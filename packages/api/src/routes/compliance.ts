import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/authz.js';
import { resolveTenantId } from '../lib/complianceTenant.js';
import { User } from '../models/User.js';
import { ComplianceDocument } from '../models/ComplianceDocument.js';
import { ComplianceVersion } from '../models/ComplianceVersion.js';
import { ComplianceAcceptance } from '../models/ComplianceAcceptance.js';
import { ComplianceAdminAction } from '../models/ComplianceAdminAction.js';
import * as svc from '../services/compliance.js';

// Metadata de ruta para el gate de compliance (DESIGN §3.3). `skipCompliance` exime una ruta del gate
// (rutas de lectura/aceptación del usuario). `complianceEffect` clasifica semánticamente para
// `block_partial`. El hook del gate (P3) las lee; aquí se declara el contrato de tipos.
declare module 'fastify' {
  interface FastifyContextConfig {
    skipCompliance?: boolean;
    complianceEffect?: 'read' | 'write' | 'none';
  }
}

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'id inválido');
const localeContent = z.object({
  locale: z.string().min(2).max(10),
  title: z.string().min(1).max(300),
  bodyMarkdown: z.string().max(500_000),
});

/** Usuario autenticado con rol fresco desde DB (la audiencia no confía en el claim del JWT). */
async function authedUser(
  request: FastifyRequest
): Promise<{ id: string; email: string; role: 'user' | 'admin' }> {
  const userId = request.user.userId;
  const user = await User.findById(userId).select('primaryEmail role').lean();
  if (!user)
    throw Object.assign(new Error('User not found'), { statusCode: 401, name: 'Unauthorized' });
  return { id: userId, email: user.primaryEmail, role: user.role };
}

/** preHandler: exige rol admin (consulta DB, no el claim). */
async function adminGuard(request: FastifyRequest): Promise<void> {
  await requireAdmin(request.user.userId);
}

function actorOf(request: FastifyRequest, email: string) {
  return { id: undefined, email, ip: request.ip };
}

/**
 * Escapa una celda CSV y neutraliza inyección de fórmulas (B-L3/D14, reforzado B P2 MED-2).
 * Prefija con `'` si el valor empieza por `= + - @`, por TAB/CR, o por whitespace/control + fórmula
 * (bypass conocido en spreadsheets que trimean el prefijo). Luego entrecomilla si hay comas/comillas/saltos.
 */
function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? '' : String(value);
  const trimmed = s.replace(/^\s+/, '');
  if (/^[=+\-@\t\r]/.test(s) || /^[=+\-@]/.test(trimmed)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export default function complianceRoutes(fastify: FastifyInstance) {
  // ─────────────────────────── USUARIO (skipCompliance: el gate no debe bloquear leer/aceptar) ───────────────────────────

  fastify.get('/pending', { config: { skipCompliance: true } }, async (request) => {
    const tenantId = resolveTenantId(request);
    const user = await authedUser(request);
    return svc.getPendingForUser(tenantId, { id: user.id, role: user.role });
  });

  fastify.get('/documents', { config: { skipCompliance: true } }, async (request) => {
    const tenantId = resolveTenantId(request);
    const user = await authedUser(request);
    // Filtra por audiencia (D-001): un usuario no debe siquiera ENUMERAR documentos de otra audiencia
    // (p.ej. role:admin). Sólo 'all' o los de su rol.
    const docs = await ComplianceDocument.find({
      tenantId,
      active: true,
      deletedAt: null,
      enforcement: { $ne: 'none' },
      currentVersionId: { $ne: null },
      audience: { $in: ['all', `role:${user.role}`] },
    })
      .select('key title category order enforcement currentVersionNumber defaultLocale')
      .sort({ order: 1 })
      .lean();
    return { documents: docs };
  });

  const docKeyParam = z.object({ key: z.string().min(1).max(100) });
  const docKeyQuery = z.object({ locale: z.string().min(2).max(10).optional() });

  fastify.get<{ Params: { key: string }; Querystring: { locale?: string } }>(
    '/documents/:key',
    { config: { skipCompliance: true } },
    async (request, reply) => {
      const tenantId = resolveTenantId(request);
      const user = await authedUser(request);
      const { key } = docKeyParam.parse(request.params);
      const { locale } = docKeyQuery.parse(request.query);
      const doc = await ComplianceDocument.findOne({
        tenantId,
        key,
        deletedAt: null,
        active: true,
      }).lean();
      // Sólo visible si está activo, enforced y aplica a la audiencia del usuario (B P2 MED-1).
      const applies =
        doc != null &&
        doc.enforcement !== 'none' &&
        (doc.audience === 'all' || doc.audience === `role:${user.role}`);
      if (!applies || doc.currentVersionId == null) {
        notFound(reply);
        return;
      }
      const version = await ComplianceVersion.findOne({
        _id: doc.currentVersionId,
        tenantId,
      }).lean();
      if (!version) {
        notFound(reply);
        return;
      }
      const want = locale ?? doc.defaultLocale;
      const content =
        version.contents.find((c) => c.locale === want) ??
        version.contents.find((c) => c.locale === doc.defaultLocale) ??
        version.contents[0];
      return {
        key: doc.key,
        title: doc.title,
        version: version.version,
        locale: content.locale,
        bodyHtml: content.bodyHtml,
        effectiveAt: version.effectiveAt,
      };
    }
  );

  const acceptBody = z.object({
    documentKey: z.string().min(1).max(100),
    version: z.number().int().min(1),
    locale: z.string().min(2).max(10).optional(),
    method: z.enum(['explicit_click', 'scroll_confirmed']).optional(),
  });

  fastify.post('/accept', { config: { skipCompliance: true } }, async (request) => {
    const tenantId = resolveTenantId(request);
    const user = await authedUser(request);
    const body = acceptBody.parse(request.body);
    // IP y user-agent se capturan SERVER-SIDE (trustProxy=true → request.ip es la IP real del cliente,
    // no la del proxy). El cliente NO los provee → la evidencia HMAC firma datos confiables (D-035).
    return svc.recordAcceptance({
      tenantId,
      user: { id: user.id, email: user.email, role: user.role },
      documentKey: body.documentKey,
      version: body.version,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      locale: body.locale ?? 'es',
      method: body.method,
    });
  });

  fastify.get('/me/acceptances', { config: { skipCompliance: true } }, async (request) => {
    const tenantId = resolveTenantId(request);
    const user = await authedUser(request);
    const acceptances = await ComplianceAcceptance.find({ tenantId, userId: user.id })
      .select('documentKey version acceptedAt locale')
      .sort({ acceptedAt: -1 })
      .limit(1000) // acotado (B P2 MED-3): un usuario no acumula >1000 aceptaciones en la práctica
      .lean();
    return { acceptances };
  });

  // ─────────────────────────── ADMIN (requireAdmin; NO skipCompliance: un admin con políticas pendientes debe aceptar) ───────────────────────────

  fastify.get('/admin/documents', { preHandler: adminGuard }, async (request) => {
    const tenantId = resolveTenantId(request);
    const docs = await ComplianceDocument.find({ tenantId }).sort({ order: 1 }).lean();
    return { documents: docs };
  });

  const createDocBody = z
    .object({
      key: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-z0-9-]+$/, 'key debe ser kebab-case'),
      category: z.enum(['legal', 'privacy', 'security', 'operational', 'cookies', 'custom']),
      title: z.string().min(1).max(300),
      enforcement: z.enum(['none', 'soft', 'block_partial', 'block_full']).optional(),
      audience: z.enum(['all', 'role:user', 'role:admin']).optional(),
      order: z.number().int().min(0).max(100000).optional(),
      defaultLocale: z.string().min(2).max(10).optional(),
    })
    .strict(); // rechaza campos extra (p.ej. `system`) → cierra mass-assignment latente (D-004)

  fastify.post('/admin/documents', { preHandler: adminGuard }, async (request) => {
    const tenantId = resolveTenantId(request);
    const user = await authedUser(request);
    const body = createDocBody.parse(request.body);
    const doc = await svc.createDocument({
      tenantId,
      ...body,
      actor: actorOf(request, user.email),
    });
    return { document: doc };
  });

  const updateDocBody = z
    .object({
      title: z.string().min(1).max(300).optional(),
      enforcement: z.enum(['none', 'soft', 'block_partial', 'block_full']).optional(),
      audience: z.enum(['all', 'role:user', 'role:admin']).optional(),
      active: z.boolean().optional(),
      order: z.number().int().min(0).max(100000).optional(),
    })
    .strict();

  fastify.patch<{ Params: { id: string } }>(
    '/admin/documents/:id',
    { preHandler: adminGuard },
    async (request) => {
      const tenantId = resolveTenantId(request);
      const user = await authedUser(request);
      const id = objectId.parse(request.params.id);
      const patch = updateDocBody.parse(request.body);
      const doc = await svc.updateDocumentMetadata(
        tenantId,
        id,
        patch,
        actorOf(request, user.email)
      );
      return { document: doc };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/admin/documents/:id',
    { preHandler: adminGuard },
    async (request) => {
      const tenantId = resolveTenantId(request);
      const user = await authedUser(request);
      const id = objectId.parse(request.params.id);
      return svc.deleteDocument(tenantId, id, actorOf(request, user.email));
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/admin/documents/:id/versions',
    { preHandler: adminGuard },
    async (request) => {
      const tenantId = resolveTenantId(request);
      const id = objectId.parse(request.params.id);
      const versions = await ComplianceVersion.find({ documentId: id, tenantId })
        .select(
          'version status changeSummary requiresReacceptance effectiveAt expiresAt publishedAt authorEmail createdAt'
        )
        .sort({ version: -1 })
        .lean();
      return { versions };
    }
  );

  const createVersionBody = z.object({
    contents: z.array(localeContent).min(1).max(50),
    changeSummary: z.string().max(2000).optional(),
    requiresReacceptance: z.boolean().optional(),
    effectiveAt: z.coerce.date(),
    expiresAt: z.coerce.date().nullable().optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/admin/documents/:id/versions',
    { preHandler: adminGuard },
    async (request) => {
      const tenantId = resolveTenantId(request);
      const user = await authedUser(request);
      const id = objectId.parse(request.params.id);
      const body = createVersionBody.parse(request.body);
      const version = await svc.createDraftVersion({
        tenantId,
        documentId: id,
        contents: body.contents,
        changeSummary: body.changeSummary,
        requiresReacceptance: body.requiresReacceptance,
        effectiveAt: body.effectiveAt,
        expiresAt: body.expiresAt ?? null,
        authorEmail: user.email,
      });
      return { version };
    }
  );

  const updateVersionBody = z
    .object({
      contents: z.array(localeContent).min(1).max(50).optional(),
      changeSummary: z.string().max(2000).optional(),
      requiresReacceptance: z.boolean().optional(),
      effectiveAt: z.coerce.date().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
    })
    .strict();

  fastify.patch<{ Params: { id: string } }>(
    '/admin/versions/:id',
    { preHandler: adminGuard },
    async (request) => {
      const tenantId = resolveTenantId(request);
      const id = objectId.parse(request.params.id);
      const patch = updateVersionBody.parse(request.body);
      const version = await svc.updateDraftVersion(tenantId, id, patch);
      return { version };
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/admin/versions/:id/publish',
    { preHandler: adminGuard },
    async (request) => {
      const tenantId = resolveTenantId(request);
      const user = await authedUser(request);
      const id = objectId.parse(request.params.id);
      const version = await svc.publishVersion(tenantId, id, actorOf(request, user.email));
      return { version };
    }
  );

  const acceptancesQuery = z.object({
    documentKey: z.string().max(100).optional(),
    userId: objectId.optional(),
    format: z.enum(['json', 'csv']).optional(),
    limit: z.coerce.number().int().min(1).max(5000).optional(),
  });

  fastify.get('/admin/acceptances', { preHandler: adminGuard }, async (request, reply) => {
    const tenantId = resolveTenantId(request);
    const q = acceptancesQuery.parse(request.query);
    const filter: Record<string, unknown> = { tenantId };
    if (q.documentKey) filter.documentKey = q.documentKey;
    if (q.userId) filter.userId = q.userId;
    const rows = await ComplianceAcceptance.find(filter)
      .select('-evidenceHmac') // no se sobreexpone el MAC en el listado (D-005); /verify lo usa aparte
      .sort({ acceptedAt: -1 })
      .limit(q.limit ?? 1000)
      .lean();
    if (q.format === 'csv') {
      // El export de evidencia es una acción auditable (gobierno del framework, B P6 MEDIUM).
      const user = await authedUser(request);
      await svc.logAdminAction({
        tenantId,
        actorEmail: user.email,
        action: 'export_acceptances',
        documentKey: q.documentKey ?? '',
        after: { count: rows.length },
        ip: request.ip,
      });
      const header = [
        'userEmail',
        'documentKey',
        'version',
        'acceptedAt',
        'ip',
        'userAgent',
        'locale',
        'method',
        'hmacKeyId',
      ];
      const lines = [header.join(',')];
      for (const r of rows) {
        lines.push(
          [
            r.userEmail,
            r.documentKey,
            r.version,
            r.acceptedAt.toISOString(),
            r.ip,
            r.userAgent,
            r.locale,
            r.method,
            r.hmacKeyId,
          ]
            .map(csvCell)
            .join(',')
        );
      }
      void reply.header('content-type', 'text/csv; charset=utf-8');
      return lines.join('\n');
    }
    return { acceptances: rows };
  });

  fastify.post<{ Params: { id: string } }>(
    '/admin/acceptances/:id/verify',
    { preHandler: adminGuard },
    async (request) => {
      const tenantId = resolveTenantId(request);
      const id = objectId.parse(request.params.id);
      return svc.verifyAcceptanceById(tenantId, id);
    }
  );

  fastify.get('/admin/stats', { preHandler: adminGuard }, async (request) => {
    const tenantId = resolveTenantId(request);
    // Filtra activos/no-borrados (D-007) y ACOTA a 200 docs para evitar N+1 ilimitado (D-002). En la
    // práctica un tenant tiene pocas políticas enforced; 200 es un techo holgado.
    const docs = await ComplianceDocument.find({
      tenantId,
      enforcement: { $ne: 'none' },
      active: true,
      deletedAt: null,
    })
      .select('key title enforcement enforcedVersion currentVersionNumber')
      .limit(200)
      .lean();
    const stats = [];
    for (const d of docs) {
      const accepted = await ComplianceAcceptance.countDocuments({
        tenantId,
        documentKey: d.key,
        version: { $gte: d.enforcedVersion },
      });
      stats.push({
        key: d.key,
        title: d.title,
        enforcement: d.enforcement,
        enforcedVersion: d.enforcedVersion,
        acceptedCount: accepted,
      });
    }
    return { stats };
  });

  fastify.get('/admin/actions', { preHandler: adminGuard }, async (request) => {
    const tenantId = resolveTenantId(request);
    const actions = await ComplianceAdminAction.find({ tenantId })
      .sort({ at: -1 })
      .limit(500)
      .lean();
    return { actions };
  });
}

function notFound(reply: FastifyReply) {
  void reply
    .code(404)
    .send({ statusCode: 404, error: 'Not Found', message: 'Documento no encontrado' });
}
