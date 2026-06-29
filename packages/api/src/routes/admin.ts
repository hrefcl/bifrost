import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/authz.js';
import { getStorageConfigPublic, setStorageConfig } from '../services/storage/index.js';
import { isSafeS3Endpoint, verifyS3Connection } from '../services/storage/s3.js';
import { getBranding, setBranding, toPublicBranding } from '../services/branding.js';
import { loginOrRegister } from '../services/auth.js';
import { checkForUpdate } from '../services/update-check.js';
import { BUILD_INFO } from '../lib/buildInfo.js';
import { User } from '../models/User.js';
import { Account } from '../models/Account.js';
import { Email } from '../models/Email.js';
import { Folder } from '../models/Folder.js';
import { AttachmentBlob } from '../models/AttachmentBlob.js';
import { Draft } from '../models/Draft.js';
import { Contact } from '../models/Contact.js';
import { CalendarEvent } from '../models/CalendarEvent.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'id inválido');
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// Logo como data URL base64 (sin SVG: un SVG podría traer scripts; aunque en <img> no ejecutan,
// lo excluimos por defensa en profundidad). Cap de ~256KB decodificados para no inflar el doc.
const LOGO_MAX_BYTES = 256 * 1024;
const logoDataUrl = z
  .string()
  .regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, 'logo inválido')
  .refine((v) => {
    const b64 = v.slice(v.indexOf(',') + 1);
    return Math.floor((b64.length * 3) / 4) <= LOGO_MAX_BYTES;
  }, 'el logo supera 256KB');

const brandingSchema = z
  .object({
    companyName: z.string().trim().max(60).optional(),
    tagline: z.string().trim().max(80).optional(),
    accentColor: z.string().regex(HEX, 'color inválido').optional(),
    // '' o null LIMPIAN el logo; un data URL válido lo fija; ausente = no tocar.
    logoDataUrl: z.union([logoDataUrl, z.literal(''), z.null()]).optional(),
  })
  .strict();

// Alta de cuenta por el admin (mismo contrato que el login + cuota/nombre). El backend verifica
// las credenciales IMAP reales antes de crear (createAccount reusa loginOrRegister).
const createAccountSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
    displayName: z.string().trim().max(120).optional(),
    imapHost: z.string().min(1),
    imapPort: z.number().int().min(1).max(65535),
    imapSecure: z.boolean(),
    smtpHost: z.string().min(1),
    smtpPort: z.number().int().min(1).max(65535),
    smtpSecure: z.boolean(),
    quotaBytes: z.number().int().min(0).optional(),
  })
  .strict();

const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    quotaBytes: z.number().int().min(0).optional(),
    // El admin sólo conmuta active⇄disabled; 'syncing'/'error' los maneja el sistema.
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

// `local` (sin config) o `s3` (endpoint opcional + bucket/region/keys; el secret se cifra al
// persistir). Union discriminada → `.strict()` rechaza campos extra y mezclas inválidas.
const storageConfigSchema = z.discriminatedUnion('providerType', [
  z.object({ providerType: z.literal('local') }).strict(),
  z
    .object({
      providerType: z.literal('s3'),
      s3: z
        .object({
          // Endpoint estructuralmente seguro: sólo http/https, sin userinfo/query/fragment/path
          // ni IP de metadata cloud (ver isSafeS3Endpoint). Rechaza ftp://, file://, etc.
          endpoint: z.string().url().refine(isSafeS3Endpoint, 'endpoint S3 inválido').optional(),
          bucket: z.string().min(1),
          // region se interpola en la URL del host AWS por defecto → restringimos al charset
          // de región (evita inyección de host/query/path).
          region: z
            .string()
            .min(1)
            .regex(/^[a-z0-9-]+$/, 'región inválida'),
          accessKeyId: z.string().min(1),
          secretAccessKey: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * Rutas del panel de administración. TODO lo de acá exige rol `admin` (verificado en DB,
 * no por el claim del JWT). Por ahora sólo un endpoint de sondeo; los PRs siguientes suman
 * la config de providers (storage, provisión de buzones, etc.). El feature-gating real vive
 * acá (backend), no sólo en la UI.
 */
export default function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request) => {
    await requireAdmin(request.user.userId);
  });

  // Sondeo: confirma que el solicitante es admin (la UI lo usa para mostrar /admin).
  fastify.get('/whoami', () => {
    return { role: 'admin' as const };
  });

  // Build de la imagen API (admin-only — NO en /health público para no facilitar fingerprinting).
  fastify.get('/version', () => BUILD_INFO);

  // Chequeo de actualización (estilo WordPress): compara el build instalado con el último publicado
  // en GitHub. Sólo lectura (Fase 1). `?force=1` salta el cache. Admin-only (preHandler de arriba).
  fastify.get('/update/check', async (request) => {
    const { force } = z.object({ force: z.enum(['1', 'true']).optional() }).parse(request.query);
    return checkForUpdate(force !== undefined);
  });

  // Config del storage de adjuntos (wizard Paso 1). GET sin secretos.
  fastify.get('/config/storage', async () => {
    return getStorageConfigPublic();
  });

  fastify.patch('/config/storage', async (request) => {
    const body = storageConfigSchema.parse(request.body);
    return setStorageConfig(body, request.user.userId);
  });

  // Probar la conexión S3 sin persistir: el admin verifica credenciales/bucket ANTES de activar
  // S3 y romper los uploads de todos con un typo. Hace un round-trip real (put→get→delete).
  const s3TestSchema = z
    .object({
      endpoint: z.string().url().refine(isSafeS3Endpoint, 'endpoint S3 inválido').optional(),
      bucket: z.string().min(1),
      region: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, 'región inválida'),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
    })
    .strict();

  fastify.post('/config/storage/test', async (request, reply) => {
    const s3 = s3TestSchema.parse(request.body);
    try {
      await verifyS3Connection(s3);
    } catch {
      // No filtramos el detalle crudo del provider (podría incluir info sensible del request).
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'No se pudo conectar al bucket S3 con esos datos. Revisá endpoint/credenciales.',
      });
    }
    return { ok: true };
  });

  // ---- Branding (white-label en runtime) ----
  // GET con metadatos de auditoría (updatedBy/At) para el panel; la vista pública SIN auth vive en
  // /api/branding.
  fastify.get('/config/branding', async () => {
    const cfg = await getBranding();
    return { ...toPublicBranding(cfg), updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt };
  });

  fastify.put('/config/branding', async (request) => {
    const body = brandingSchema.parse(request.body);
    const cfg = await setBranding(body, request.user.userId);
    return { ...toPublicBranding(cfg), updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt };
  });

  // ---- Gestión de cuentas (Roundcube administrable) ----
  // Lista todas las cuentas con su usuario, estado, cuota y uso REAL de almacenamiento de adjuntos
  // (suma de blobs del usuario) — no un número inventado.
  fastify.get('/accounts', async () => {
    const accounts = await Account.find()
      .select('email name isPrimary status lastSyncedAt quotaBytes userId')
      .sort({ createdAt: 1 })
      .lean();
    const userIds = [...new Set(accounts.map((a) => a.userId.toString()))];
    const users = await User.find({ _id: { $in: userIds } })
      .select('displayName primaryEmail role')
      .lean();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));
    // Uso por usuario = suma de bytes de sus AttachmentBlob (lo único que almacenamos nosotros;
    // el correo vive en el servidor IMAP). Un solo aggregate para todos.
    const usageAgg = await AttachmentBlob.aggregate<{ _id: unknown; used: number }>([
      { $match: { userId: { $in: accounts.map((a) => a.userId) } } },
      { $group: { _id: '$userId', used: { $sum: '$size' } } },
    ]);
    const usedByUser = new Map(usageAgg.map((u) => [String(u._id), u.used]));
    return {
      accounts: accounts.map((a) => {
        const u = userById.get(a.userId.toString());
        return {
          id: a._id.toString(),
          userId: a.userId.toString(),
          email: a.email,
          name: a.name,
          displayName: u?.displayName ?? a.name,
          role: u?.role ?? 'user',
          isPrimary: a.isPrimary,
          status: a.status,
          quotaBytes: a.quotaBytes ?? 0,
          usedBytes: usedByUser.get(a.userId.toString()) ?? 0,
          lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
        };
      }),
    };
  });

  // Crea una cuenta (verifica credenciales IMAP reales vía loginOrRegister antes de persistir).
  fastify.post('/accounts', async (request, reply) => {
    const body = createAccountSchema.parse(request.body);
    const { user, account, isNew } = await loginOrRegister(body);
    if (!isNew) {
      // El email ya existía: no es un alta. Avisar en vez de fingir creación.
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Ya existe una cuenta con ese email.',
      });
    }
    const set: Record<string, unknown> = {};
    if (body.quotaBytes !== undefined) set.quotaBytes = body.quotaBytes;
    if (Object.keys(set).length > 0) await Account.updateOne({ _id: account._id }, { $set: set });
    if (body.displayName) {
      await User.updateOne({ _id: user._id }, { $set: { displayName: body.displayName } });
    }
    return reply.code(201).send({
      id: account._id.toString(),
      email: account.email,
      status: account.status,
      quotaBytes: body.quotaBytes ?? 0,
    });
  });

  // Edita una cuenta: nombre, cuota y habilitar/deshabilitar. No permite que un admin se
  // deshabilite a SÍ MISMO (se dejaría afuera). El nombre vive en el usuario dueño.
  fastify.patch('/accounts/:id', async (request, reply) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const body = updateAccountSchema.parse(request.body);
    const account = await Account.findById(id).select('userId').lean();
    if (!account) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
    }
    if (body.status === 'disabled' && account.userId.toString() === request.user.userId) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'No podés deshabilitar tu propia cuenta de administrador.',
      });
    }
    const set: Record<string, unknown> = {};
    if (body.quotaBytes !== undefined) set.quotaBytes = body.quotaBytes;
    if (body.status !== undefined) set.status = body.status;
    if (Object.keys(set).length > 0) await Account.updateOne({ _id: id }, { $set: set });
    if (body.displayName) {
      await User.updateOne({ _id: account.userId }, { $set: { displayName: body.displayName } });
    }
    return { ok: true };
  });

  // Elimina una cuenta y su correo cacheado (emails/folders). Si era la última del usuario, borra
  // también el usuario. No permite borrar la cuenta del propio admin (anti auto-lockout). Los blobs
  // de adjuntos quedan para el GC (son por-usuario y mark-and-sweep).
  fastify.delete('/accounts/:id', async (request, reply) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const account = await Account.findById(id).select('userId').lean();
    if (!account) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
    }
    if (account.userId.toString() === request.user.userId) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'No podés eliminar tu propia cuenta de administrador.',
      });
    }
    await Account.deleteOne({ _id: id });
    // Datos ACOTADOS A LA CUENTA (accountId-bound): se borran SIEMPRE, sea o no la última cuenta.
    // Incluye Drafts: así sus AttachmentBlob quedan SIN referencia y el GC mark-and-sweep los
    // reclama (docs + bytes en el storage provider) — si no, fuga de storage por blobs inmortales.
    await Promise.all([
      Email.deleteMany({ accountId: id }),
      Folder.deleteMany({ accountId: id }),
      Draft.deleteMany({ accountId: id }),
      CalendarEvent.deleteMany({ accountId: id }),
    ]);
    // Si era la ÚLTIMA cuenta del usuario, borrar también el usuario y sus datos por-usuario
    // (Contacts). Los AttachmentBlob (userId-bound) los recicla el GC al quedar sin drafts.
    const remaining = await Account.countDocuments({ userId: account.userId });
    if (remaining === 0) {
      await Promise.all([
        User.deleteOne({ _id: account.userId }),
        Contact.deleteMany({ userId: account.userId }),
      ]);
    }
    return { ok: true };
  });
}
