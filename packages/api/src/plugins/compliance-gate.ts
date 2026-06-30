import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveTenantId } from '../lib/complianceTenant.js';
import { User } from '../models/User.js';
import { ComplianceDocument } from '../models/ComplianceDocument.js';
import { getEpoch, getPendingForUser } from '../services/compliance.js';
import { counters } from '../lib/metrics.js';

/**
 * Gate de Compliance (DESIGN v4 §3) — hook `onRequest` registrado DESPUÉS de `authPlugin`, así
 * `request.user` ya está poblado. Metadata-driven: respeta `requiresAuth:false`, `skipCompliance` y
 * `complianceEffect` de la config de ruta (NO una lista de paths). Es la AUTORIDAD real del enforcement
 * (el router del SPA es sólo UX).
 *
 * Seguridad operacional: **fail-open** ante cualquier error (un bug de compliance jamás deja a una org
 * sin correo) + **kill-switch** `COMPLIANCE_ENFORCEMENT_DISABLED=1`. Performance: snapshot por epoch en
 * memoria → si el tenant no tiene documentos enforced, fast-path con 0 queries de rol/aceptación.
 */

interface EnforcedSnapshot {
  epoch: number;
  hasEnforced: boolean;
  ts: number;
}
const snapshotByTenant = new Map<string, EnforcedSnapshot>();
const SNAPSHOT_TTL_MS = 30_000;

// Caché por-usuario (D-003): `tenantId:userId` → { epoch en que se verificó SIN pendientes, expiresAt }.
// La clave incluye `tenantId` (B-reaudit MED-4): forward-compat multi-tenant — un usuario conforme en el
// tenant A jamás salta la verificación en el tenant B aunque compartan epoch. Mientras el epoch del tenant
// no cambie (sin publish/cambio de política), un usuario plenamente conforme salta los lookups de
// rol/aceptación → estado estacionario barato. Un publish bumpea epoch e invalida TODAS las entradas. NO
// se cachea si quedan pendientes (block_partial depende de la ruta). `expiresAt` acota CUALQUIER staleness
// no cubierta por el epoch: por defecto ≤60s (p.ej. un cambio de ROL que no bumpea epoch, caveat B P3b),
// pero se ADELANTA a `recheckAt` si una versión programada (block_full futuro) entrará en vigencia antes
// (B-reaudit MED-5) → la política recién vigente se aplica al instante, no hasta 60s después.
const userCompliantAtEpoch = new Map<string, { epoch: number; expiresAt: number }>();
const USER_CACHE_TTL_MS = 60_000;
const MAX_USER_CACHE = 50_000;
const userCacheKey = (tenantId: string, userId: string): string => `${tenantId}:${userId}`;

/** Epoch + si el tenant tiene algún documento enforced (no 'none', activo, no borrado). Cacheado por epoch. */
async function getTenantEnforcement(
  tenantId: string
): Promise<{ epoch: number; hasEnforced: boolean }> {
  const epoch = await getEpoch(tenantId);
  const cached = snapshotByTenant.get(tenantId);
  if (cached?.epoch === epoch && Date.now() - cached.ts < SNAPSHOT_TTL_MS) {
    return { epoch, hasEnforced: cached.hasEnforced };
  }
  const exists = await ComplianceDocument.exists({
    tenantId,
    active: true,
    deletedAt: null,
    enforcement: { $ne: 'none' },
  });
  const hasEnforced = exists != null;
  snapshotByTenant.set(tenantId, { epoch, hasEnforced, ts: Date.now() });
  return { epoch, hasEnforced };
}

/** Limpia las cachés (para tests). */
export function _resetGateSnapshot(): void {
  snapshotByTenant.clear();
  userCompliantAtEpoch.clear();
}

function effectOf(
  request: FastifyRequest,
  config: { complianceEffect?: 'read' | 'write' | 'none' }
): 'read' | 'write' | 'none' {
  if (config.complianceEffect) return config.complianceEffect;
  // Default semántico: lecturas idempotentes = 'read'; cualquier método mutante = 'write'.
  return request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'write';
}

export default fp(function complianceGatePlugin(
  fastify: FastifyInstance,
  _opts,
  done: (err?: Error) => void
) {
  // Log de seguridad (una vez, al registrar): si el kill-switch está activo, el enforcement está
  // DESACTIVADO globalmente. Queda en el log operativo (un bypass no debe pasar silencioso, DESIGN §3.5).
  if (process.env.COMPLIANCE_ENFORCEMENT_DISABLED === '1') {
    fastify.log.warn(
      'COMPLIANCE_ENFORCEMENT_DISABLED=1 — el gate de compliance está DESACTIVADO (kill-switch). El enforcement NO se aplica.'
    );
  }
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.COMPLIANCE_ENFORCEMENT_DISABLED === '1') return; // kill-switch

    const config = request.routeOptions.config as
      | {
          requiresAuth?: boolean;
          skipCompliance?: boolean;
          complianceEffect?: 'read' | 'write' | 'none';
        }
      | undefined;
    if (config?.requiresAuth === false) return; // ruta pública: no hay user que gatear
    if (config?.skipCompliance) return; // exenta (lectura/aceptación de compliance, auth)

    const userId = (request.user as { userId?: string } | undefined)?.userId;
    if (typeof userId !== 'string' || userId.length === 0) return; // sin user (defensa)

    try {
      const tenantId = resolveTenantId(request);
      const { epoch, hasEnforced } = await getTenantEnforcement(tenantId);
      // Fast-path tenant: sin documentos enforced → no se gatea nada (0 queries de rol/aceptación).
      if (!hasEnforced) return;
      // Fast-path usuario: ya verificado plenamente conforme en este epoch y antes de su expiración → no re-consulta.
      const cacheKey = userCacheKey(tenantId, userId);
      const cachedUser = userCompliantAtEpoch.get(cacheKey);
      if (cachedUser?.epoch === epoch && Date.now() < cachedUser.expiresAt) return;

      const user = await User.findById(userId).select('role').lean();
      if (!user) return; // el authz de la ruta resolverá el 401/404
      const pending = await getPendingForUser(tenantId, { id: userId, role: user.role });

      const blocked =
        pending.enforcement === 'block_full' ||
        (pending.enforcement === 'block_partial' && effectOf(request, config ?? {}) === 'write');

      if (blocked) {
        userCompliantAtEpoch.delete(cacheKey); // invalida cualquier caché previa
        counters.complianceGateBlocks++;
        void reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Compliance acceptance required',
          code: 'COMPLIANCE_REQUIRED',
          pending: pending.documents,
        });
        return;
      }
      // Sólo se cachea como conforme si NO quedan documentos pendientes (block_partial depende de la
      // ruta: un user con partial pendiente está OK en read pero no en write → no cacheable como bit).
      // El TTL se ADELANTA a `recheckAt` si una versión programada entrará en vigencia antes (B-reaudit
      // MED-5): así un block_full cuya effectiveAt es futura se aplica al instante de activarse.
      if (pending.documents.length === 0) {
        if (userCompliantAtEpoch.size >= MAX_USER_CACHE) userCompliantAtEpoch.clear();
        const nowMs = Date.now();
        const ttl = pending.recheckAt
          ? Math.max(0, Math.min(USER_CACHE_TTL_MS, pending.recheckAt.getTime() - nowMs))
          : USER_CACHE_TTL_MS;
        userCompliantAtEpoch.set(cacheKey, { epoch, expiresAt: nowMs + ttl });
      }
      // 'soft' / 'none' → pasa.
    } catch (err: unknown) {
      counters.complianceGateErrors++;
      fastify.log.error({ err, msg: 'compliance gate error' });
      // Fail-mode CONFIGURABLE (D-001): default 'open' (un bug de compliance no deja a la org sin correo);
      // 'closed' para deployments que prefieren DENEGAR ante error de infra. La métrica
      // `compliance_gate_errors_total` es la señal de alarma para el operador en ambos modos.
      if (process.env.COMPLIANCE_FAIL_MODE === 'closed') {
        void reply.code(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Compliance check temporarily unavailable',
          code: 'COMPLIANCE_CHECK_FAILED',
        });
      }
    }
  });
  done();
});
