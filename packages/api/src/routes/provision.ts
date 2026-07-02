import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Account } from '../models/Account.js';
import { getStorageDefaults } from '../services/storage-defaults.js';
import { provisioningEnabled, MailboxExistsError } from '../services/mailbox/index.js';
import { provisionMailboxAccount } from '../services/mailbox/provision-account.js';
import { deleteAccountCascade, MailboxRevokeError } from '../services/account-lifecycle.js';
import { verifyProvisionKey, hasActiveProvisionKey } from '../services/provision-keys.js';

/**
 * API MÁQUINA-A-MÁQUINA de provisioning (`/api/provision/*`). Bifrost como AUTORIDAD de cuentas: sistemas
 * externos (p.ej. el panel corporativo Vanir) crean/borran buzones por API con `X-Provision-Key`, en vez
 * del anti-patrón de conectarse al EC2 con claves AWS y correr `setup email add` a mano.
 *
 * Auth: header `X-Provision-Key` == `PROVISION_API_KEY` (comparación timing-safe). Sin la key configurada,
 * TODO el prefijo responde 404 (no revela que el endpoint existe). Es independiente del JWT de usuario
 * (`requiresAuth:false`) — es acceso de servicio, no de sesión.
 */

/**
 * Key BOOTSTRAP del entorno (docker-secret `PROVISION_API_KEY_FILE`), turnkey del provisioner. Convive
 * con las keys gestionadas desde /admin (DB). process.env (no el `env` congelado): testeable sin reiniciar.
 */
function envKey(): string | null {
  const k = process.env.PROVISION_API_KEY?.trim();
  return k && k.length > 0 ? k : null;
}

/** Comparación en tiempo constante (evita oráculo por timing). Longitudes distintas → false sin comparar. */
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Autentica el token contra la key bootstrap del env O cualquier key ACTIVA gestionada en /admin. */
async function isAuthorized(provided: string | undefined): Promise<boolean> {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const bootstrap = envKey();
  if (bootstrap && keyMatches(provided, bootstrap)) return true;
  return verifyProvisionKey(provided);
}

const createSchema = z
  .object({
    email: z.string().email(),
    // Opcional: si se omite, Bifrost genera una contraseña fuerte y la devuelve UNA vez.
    password: z.string().min(1).optional(),
    displayName: z.string().trim().max(120).optional(),
    quotaBytes: z.number().int().min(0).optional(),
  })
  .strict();

export default function provisionRoutes(fastify: FastifyInstance) {
  // Auth de servicio para TODO el plugin. requiresAuth:false salta el JWT; acá exigimos la API-key.
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const provided = request.headers['x-provision-key'];
    if (await isAuthorized(typeof provided === 'string' ? provided : undefined)) {
      // Autorizado (key bootstrap o gestionada) → seguimos al chequeo de provider abajo.
    } else {
      // Si NO hay ninguna key configurada (ni env ni gestionada), ocultamos el endpoint (404) para no
      // filtrar su existencia. Si hay keys pero la provista es inválida/ausente → 401.
      const anyKey = envKey() !== null || (await hasActiveProvisionKey());
      return anyKey
        ? reply
            .code(401)
            .send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid provision key' })
        : reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });
    }
    // La key es válida pero el server no está en modo turnkey → no hay backend que cree buzones.
    if (!(await provisioningEnabled())) {
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'El provisioning de buzones no está habilitado en este servidor.',
      });
    }
  });

  // Alta idempotente-friendly: crea el buzón REAL + la cuenta Bifrost.
  fastify.post('/mailboxes', { config: { requiresAuth: false } }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    let result;
    try {
      result = await provisionMailboxAccount({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
      });
    } catch (err) {
      if (err instanceof MailboxExistsError) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Ya existe un buzón con ese email.',
        });
      }
      throw err;
    }
    // Cuota por defecto (o la indicada). Mismo criterio que el alta desde /admin.
    const quotaBytes = body.quotaBytes ?? (await getStorageDefaults()).defaultQuotaBytes;
    await Account.updateOne({ _id: result.account._id }, { $set: { quotaBytes } });
    return reply.code(201).send({
      id: result.account._id.toString(),
      email: result.account.email,
      status: result.account.status,
      quotaBytes,
      // Sólo si Bifrost generó la contraseña: se entrega UNA vez (no se persiste en claro).
      ...(result.passwordGenerated ? { password: result.password } : {}),
    });
  });

  // Baja: revoca el buzón real + borra la cuenta y sus datos (cascade compartido con /admin).
  fastify.delete(
    '/mailboxes/:email',
    { config: { requiresAuth: false } },
    async (request, reply) => {
      const { email } = z
        .object({ email: z.string().email() })
        .parse({ email: decodeURIComponent((request.params as { email: string }).email) });
      const account = await Account.findOne({ email: email.toLowerCase() })
        .select('userId email')
        .lean();
      if (!account) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
      }
      try {
        await deleteAccountCascade({
          _id: account._id,
          userId: account.userId,
          email: account.email,
        });
      } catch (err) {
        if (err instanceof MailboxRevokeError) {
          return reply.code(502).send({
            statusCode: 502,
            error: 'Bad Gateway',
            message: 'No se pudo eliminar el buzón en el servidor de correo. Reintentá.',
          });
        }
        throw err;
      }
      return { ok: true };
    }
  );

  // Consulta de existencia (para que el llamador sea idempotente sin depender del 409).
  fastify.get('/mailboxes/:email', { config: { requiresAuth: false } }, async (request, reply) => {
    const { email } = z
      .object({ email: z.string().email() })
      .parse({ email: decodeURIComponent((request.params as { email: string }).email) });
    const account = await Account.findOne({ email: email.toLowerCase() })
      .select('email status')
      .lean();
    if (!account) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
    }
    return { email: account.email, status: account.status };
  });
}
