import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  loginOrRegister,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  toLoginResponse,
} from '../services/auth.js';
import { User } from '../models/User.js';
import { Account } from '../models/Account.js';
import { resolveAdminAccess } from '../lib/authz.js';
import { counters } from '../lib/metrics.js';
import { env, jwtAccessTtlSeconds } from '../config/env.js';
import { sanitizeEmailHtml } from '../lib/sanitizeHtml.js';
import { externalizeDataImages, storeDataImage } from '../services/signature-images.js';
import { getSignaturePolicy } from '../services/signature-policy.js';
import { SIGNATURE_TEMPLATES, isValidTemplateId } from '../lib/signature-templates.js';
import { renderPreview } from '../services/user-signature.js';
import { randomToken } from '../config/crypto.js';
import type { LoginRequest, LoginResponse, RefreshResponse } from '@webmail6/shared';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  displayName: z.string().optional(),
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
});

const preferencesPatchSchema = z
  .object({
    defaultSignature: z.string().max(50_000).optional(),
    autoIncludeSignature: z.boolean().optional(),
  })
  .strict();

// Perfil personal editable por el usuario (firmas F3). La foto entra como data: URL ráster y se
// EXTERNALIZA a URL interna (`storeDataImage`) — nunca se acepta una URL remota (review H2).
const profilePatchSchema = z
  .object({
    // El usuario edita su propio nombre visible. `min(1)`: es `required` en el modelo → nunca se vacía.
    displayName: z.string().trim().min(1).max(120).optional(),
    jobTitle: z.string().trim().max(120).optional(),
    department: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(40).optional(),
    photoDataUrl: z.string().max(3_000_000).optional(),
    clearPhoto: z.boolean().optional(),
  })
  .strict();

// Elección de firma white-label del usuario (firmas F4). `.strict()` anti mass-assign.
const signaturePrefSchema = z
  .object({
    source: z.enum(['template', 'custom']).optional(),
    templateId: z.string().max(60).optional(),
    includePhoto: z.boolean().optional(),
  })
  .strict();

// `.default({})`: el cliente web refresca SÓLO con la cookie httpOnly (sin body) →
// request.body llega `undefined` en runtime (aunque el tipo Body de Fastify diga lo
// contrario). Sin el default, z.object().parse(undefined) tiraría 400 y rompería
// restore() en cada reload (sesión válida → /login). `refreshToken` sigue opcional.
const refreshBodySchema = z
  .object({
    // Normaliza "" → undefined: un refreshToken vacío del body debe caer a la cookie
    // (no quedarse en string vacío e ignorar una cookie válida → 401).
    refreshToken: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
  })
  .strict()
  .default({});

function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: 7 * 24 * 60 * 60,
  };
}

/** Lee un límite por env con guard de NaN/≤0 (un typo no debe romper ni desactivar el límite). */
function rateMax(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar] ?? String(fallback));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function authRoutes(fastify: FastifyInstance) {
  // Límites por IP configurables por env. CLAVE: el limitador keyea por `request.ip` (IP real vía
  // trustProxy), y en el modelo self-hosted per-tenant de Bifrost una empresa entera comparte UNA IP
  // pública de oficina (NAT). Los defaults históricos (10 login / 30 refresh por minuto) asumían
  // 1 IP = 1 usuario y estrangulaban a toda la oficina: la entrada matinal de ~15 personas + los
  // reintentos del SPA + el refresh de tokens superaban 10 logins/min desde esa única IP → 429 para
  // TODOS (outage real en cleverty). Subimos a 100 login / 600 refresh por minuto por IP: holgado
  // para una PYME (~50) tras un NAT, y sigue acotando la fuerza bruta (el login exige credenciales
  // IMAP reales; el fail2ban del mailserver sólo ve la IP del contenedor API, así que ESTE límite
  // por-IP-real es la defensa efectiva). El operador puede endurecerlo por env si lo necesita. El
  // harness E2E (suite serial desde una sola IP) los eleva aún más. Global en app.ts (RATE_LIMIT_MAX).
  const loginMax = rateMax('AUTH_LOGIN_RATE_MAX', 100);
  const refreshMax = rateMax('AUTH_REFRESH_RATE_MAX', 600);

  fastify.post<{ Body: LoginRequest; Reply: LoginResponse }>(
    '/login',
    // Rate limit estricto: login verifica credenciales IMAP reales (anti fuerza bruta).
    { config: { requiresAuth: false, rateLimit: { max: loginMax, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const { user, account, bootstrappedAdmin } = await loginOrRegister(body);
      if (bootstrappedAdmin) {
        // Evento de seguridad: el sistema no tenía admin y este 1er usuario lo otorgó. Se audita (warn
        // estructurado, sin credenciales) + métrica Prometheus (debería quedar en 1; >1 = anomalía a
        // alertar) para que un grant inesperado no pase silencioso.
        counters.bootstrapAdminGrants++;
        request.log.warn(
          { userId: user._id.toString(), email: user.primaryEmail, ip: request.ip },
          'bootstrap admin otorgado: no existia admin, este usuario quedo admin'
        );
      }
      const accessToken = fastify.jwt.sign({ userId: user._id.toString() });
      const familyId = randomToken(16);
      const refreshToken = await createRefreshToken(
        user._id.toString(),
        familyId,
        request.headers['user-agent'],
        request.ip
      );

      void reply.setCookie('refresh_token', refreshToken, cookieOptions());
      return await toLoginResponse(user, account, accessToken);
    }
  );

  // Logout no requiere access token válido: alcanza con la cookie de refresh (un
  // access token vencido no debe impedir cerrar sesión).
  fastify.post('/logout', { config: { requiresAuth: false } }, async (request, reply) => {
    const refreshToken = request.cookies.refresh_token;
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    void reply.clearCookie('refresh_token', { path: '/' });
    return { ok: true };
  });

  fastify.post<{ Body: { refreshToken?: string }; Reply: RefreshResponse }>(
    '/refresh',
    { config: { requiresAuth: false, rateLimit: { max: refreshMax, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = refreshBodySchema.parse(request.body);
      const refreshToken = parsed.refreshToken ?? request.cookies.refresh_token;
      if (!refreshToken) {
        return reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Missing refresh token',
        } as unknown as RefreshResponse);
      }

      const rotated = await rotateRefreshToken(refreshToken);
      if (!rotated) {
        return reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid refresh token',
        } as unknown as RefreshResponse);
      }

      const accessToken = fastify.jwt.sign({ userId: rotated.userId });
      void reply.setCookie('refresh_token', rotated.token, cookieOptions());
      return { accessToken, expiresIn: jwtAccessTtlSeconds };
    }
  );

  // `skipCompliance`: el SPA hace `GET /me` en restore(); si el gate lo bloqueara con 403, el store
  // limpiaría la sesión y el usuario no podría llegar al flujo de aceptación (B P3 MEDIUM, anti-deadlock).
  // `PATCH /me/preferences` (escritura) SÍ queda gateado.
  fastify.get('/me', { config: { skipCompliance: true } }, async (request) => {
    const user = await User.findById(request.user.userId).lean();
    if (!user) {
      throw new Error('User not found');
    }
    const accounts = await Account.find({ userId: user._id })
      .select('email name isPrimary status')
      .lean();
    // Permisos admin efectivos (RBAC F8): la UI admite/filtra el panel /admin con esto (backend re-valida).
    const { permissions } = await resolveAdminAccess(user._id.toString());

    return {
      id: user._id.toString(),
      primaryEmail: user.primaryEmail,
      displayName: user.displayName,
      role: user.role,
      adminPermissions: [...permissions],
      avatarUrl: user.avatarUrl,
      jobTitle: user.jobTitle,
      department: user.department,
      phone: user.phone,
      photoUrl: user.photoUrl,
      username: user.username,
      preferences: user.preferences,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString(),
      accounts: accounts.map((a) => ({
        id: a._id.toString(),
        email: a.email,
        name: a.name,
        isPrimary: a.isPrimary,
        status: a.status,
      })),
    };
  });

  // Actualiza preferencias del usuario (hoy: firma HTML por defecto + auto-inclusión). El
  // `defaultSignature` se SANEA (es HTML que se embebe en correos salientes) con la misma
  // política que el body de los emails. `.strict()` rechaza claves inesperadas (anti mass-assign).
  fastify.patch('/me/preferences', async (request, reply) => {
    const body = preferencesPatchSchema.parse(request.body);
    // Update DIRIGIDO con $set de los paths nestados: actualiza SÓLO las prefs provistas, sin
    // re-validar el documento entero (un `user.save()` fallaría si OTRO campo, p.ej.
    // displayName, quedó inválido al crearse el usuario — no es asunto de este endpoint).
    const set: Record<string, unknown> = {};
    if (body.defaultSignature !== undefined) {
      // Externalizar imágenes data: (base64) → URL pública hosteada en el box ANTES de sanear. Gmail
      // y otros clientes BLOQUEAN data: en correos recibidos (la foto se vería rota); Gmail mismo las
      // sube a googleusercontent al pegar la firma — replicamos ese comportamiento.
      const externalized = await externalizeDataImages(
        request.user.userId,
        body.defaultSignature,
        env.FRONTEND_URL
      );
      set['preferences.defaultSignature'] = sanitizeEmailHtml(externalized);
    }
    if (body.autoIncludeSignature !== undefined) {
      set['preferences.autoIncludeSignature'] = body.autoIncludeSignature;
    }
    const user = await User.findByIdAndUpdate(
      request.user.userId,
      { $set: set },
      { new: true, runValidators: true }
    );
    if (!user) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'User not found' });
    }
    return {
      defaultSignature: user.preferences.defaultSignature,
      autoIncludeSignature: user.preferences.autoIncludeSignature,
    };
  });

  // Perfil personal (firmas F3): cargo, departamento, teléfono y foto. `$set`/`$unset` dirigido
  // (un string vacío LIMPIA el campo). La foto (data: URL) se externaliza a URL interna.
  fastify.patch('/me/profile', async (request, reply) => {
    const body = profilePatchSchema.parse(request.body);
    const set: Record<string, unknown> = {};
    const unset: Record<string, unknown> = {};
    const text = (v: string | undefined, key: string) => {
      if (v === undefined) return;
      const t = v.trim();
      if (t) set[key] = t;
      else unset[key] = '';
    };
    // displayName es `required`: sólo se ACTUALIZA si viene con contenido; nunca se `unset` (no puede quedar vacío).
    const dn = body.displayName?.trim();
    if (dn) set.displayName = dn;
    text(body.jobTitle, 'jobTitle');
    text(body.department, 'department');
    text(body.phone, 'phone');
    if (body.clearPhoto) {
      unset.photoUrl = '';
    } else if (body.photoDataUrl !== undefined) {
      const url = await storeDataImage(request.user.userId, body.photoDataUrl, env.FRONTEND_URL);
      if (!url) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Foto inválida (usá una imagen PNG/JPG/WEBP/GIF de hasta 2 MB).',
        });
      }
      set.photoUrl = url;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;
    const user = await User.findByIdAndUpdate(request.user.userId, update, { new: true });
    if (!user) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'User not found' });
    }
    return {
      displayName: user.displayName,
      jobTitle: user.jobTitle,
      department: user.department,
      phone: user.phone,
      photoUrl: user.photoUrl,
    };
  });

  // Opciones de firma para la UI de Ajustes (firmas F4): templates permitidos por la política,
  // flags de la política, la elección actual y si el usuario tiene foto.
  fastify.get('/me/signature/options', async (request) => {
    const [user, policy] = await Promise.all([
      User.findById(request.user.userId).lean(),
      getSignaturePolicy(),
    ]);
    const allowed = policy.allowedTemplateIds.length
      ? policy.allowedTemplateIds
      : SIGNATURE_TEMPLATES.map((t) => t.id);
    return {
      templates: SIGNATURE_TEMPLATES.filter((t) => allowed.includes(t.id)).map((t) => ({
        id: t.id,
        nameKey: t.nameKey,
      })),
      policy: {
        lockTemplate: policy.lockTemplate,
        allowCustomHtml: policy.allowCustomHtml,
        enforceSignature: policy.enforceSignature,
      },
      current: user?.preferences.signature ?? null,
      hasPhoto: Boolean(user?.photoUrl),
    };
  });

  // Preview en vivo (firmas F4): rendiza server-side el MISMO pipeline que el envío (fuente única).
  fastify.get('/me/signature/preview', async (request) => {
    const q = z
      .object({ templateId: z.string(), includePhoto: z.coerce.boolean().optional() })
      .parse(request.query);
    const user = await User.findById(request.user.userId).lean();
    if (!user) return { html: '' };
    const html = await renderPreview(user, q.templateId, env.FRONTEND_URL, q.includePhoto ?? true);
    return { html };
  });

  // Guarda la elección de firma del usuario (firmas F4). $set dirigido de paths anidados.
  fastify.patch('/me/signature', async (request, reply) => {
    const body = signaturePrefSchema.parse(request.body);
    // La política se consulta una vez si hace falta validar source/templateId contra ella.
    const policy =
      body.source === 'custom' || body.templateId !== undefined ? await getSignaturePolicy() : null;
    const set: Record<string, unknown> = {};
    if (body.source !== undefined) {
      // Rechazar 'custom' si la política lo prohíbe (consistente con la rama de templateId). Sin esto
      // se persistía una preferencia inconsistente; `buildUserSignature` igual la ignora al enviar
      // (allowCustomHtml=false → cae a template), pero no debe guardarse (review A, L1).
      if (body.source === 'custom' && policy && !policy.allowCustomHtml) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Firma personalizada no permitida por la política.',
        });
      }
      set['preferences.signature.source'] = body.source;
    }
    if (body.templateId !== undefined) {
      if (!isValidTemplateId(body.templateId)) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: 'Bad Request', message: 'Template inválido' });
      }
      // Debe estar HABILITADO por la política ([] = todos). `buildUserSignature` igual lo acota al
      // enviar, pero rechazar acá evita persistir una preferencia inconsistente (review D, LOW).
      if (
        policy &&
        policy.allowedTemplateIds.length > 0 &&
        !policy.allowedTemplateIds.includes(body.templateId)
      ) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: 'Bad Request', message: 'Template no habilitado' });
      }
      set['preferences.signature.templateId'] = body.templateId;
    }
    if (body.includePhoto !== undefined)
      set['preferences.signature.includePhoto'] = body.includePhoto;
    const user = await User.findByIdAndUpdate(
      request.user.userId,
      { $set: set },
      { new: true }
    ).lean();
    if (!user) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'User not found' });
    }
    return user.preferences.signature ?? null;
  });
}
