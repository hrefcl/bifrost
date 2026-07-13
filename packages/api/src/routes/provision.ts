import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Account } from '../models/Account.js';
import { getStorageDefaults } from '../services/storage-defaults.js';
import { provisioningEnabled, MailboxExistsError } from '../services/mailbox/index.js';
import { AliasConflictError } from '../services/mailbox/types.js';
import { provisionMailboxAccount } from '../services/mailbox/provision-account.js';
import { deleteAccountCascade, MailboxRevokeError } from '../services/account-lifecycle.js';
import { verifyProvisionKey, hasActiveProvisionKey } from '../services/provision-keys.js';
import { reconcileMailboxes } from '../services/mailbox/reconcile.js';
import {
  getMailbox,
  listMailboxes,
  patchMailbox,
  setMailboxPassword,
  resetMailboxPassword,
  MailboxNotFoundError,
} from '../services/mailbox/manage.js';

/**
 * API MÁQUINA-A-MÁQUINA de provisioning (`/api/provision/*`). Bifrost como AUTORIDAD de cuentas: sistemas
 * externos (Vanir/Valhalla super_admin) gestionan el CRUD COMPLETO de buzones por API con `X-Provision-Key`,
 * en vez del anti-patrón de conectarse al EC2 con claves AWS y correr `setup email add` a mano.
 *
 * Auth uniforme: TODO endpoint del prefijo usa `X-Provision-Key` (`requiresAuth:false` salta el JWT). Sin
 * key configurada → 404 (no revela el endpoint). Con key pero inválida/ausente → 401.
 *
 * Códigos: 200/201 OK · 401 key inválida/ausente · 404 no existe · 409 ya existe (alta) · 502 mailserver
 * falló · 503 provisioning off. GARANTÍA: un 502 NO deja side-effect (los writes son atómicos temp+rename
 * con rollback) → reintentar es seguro. Además el alta acepta `Idempotency-Key` (mismo key → misma
 * respuesta cacheada, con la password generada) para no perderla ante un retry tras respuesta perdida.
 */

function envKey(): string | null {
  const k = process.env.PROVISION_API_KEY?.trim();
  return k && k.length > 0 ? k : null;
}
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
async function isAuthorized(provided: string | undefined): Promise<boolean> {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const bootstrap = envKey();
  if (bootstrap && keyMatches(provided, bootstrap)) return true;
  return verifyProvisionKey(provided);
}

// Cache de idempotencia para el ALTA (Idempotency-Key → respuesta). TTL 15 min. Resuelve el caso
// "el alta tuvo éxito pero la respuesta se perdió → el retry daría 409 sin la password generada".
const IDEM_TTL_MS = 15 * 60 * 1000;
const IDEM_MAX = 2000;
const idemCache = new Map<string, { at: number; status: number; body: unknown }>();
function idemGet(key: string): { status: number; body: unknown } | null {
  const hit = idemCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > IDEM_TTL_MS) {
    idemCache.delete(key);
    return null;
  }
  return { status: hit.status, body: hit.body };
}
function idemSet(key: string, status: number, body: unknown): void {
  const now = Date.now();
  if (idemCache.size >= IDEM_MAX) {
    // Primero barrer expirados (TTL) — nunca borra respuestas vigentes de un retry legítimo.
    for (const [k, v] of idemCache) if (now - v.at > IDEM_TTL_MS) idemCache.delete(k);
    // Si sigue lleno (todas vigentes), descartar las MÁS ANTIGUAS (Map preserva orden de inserción),
    // no un clear() total que perdería todas las respuestas cacheadas de golpe.
    while (idemCache.size >= IDEM_MAX) {
      const oldest = idemCache.keys().next().value;
      if (oldest === undefined) break;
      idemCache.delete(oldest);
    }
  }
  idemCache.set(key, { at: now, status, body });
}

const emailParam = (raw: string) =>
  z
    .object({ email: z.string().email() })
    .parse({ email: decodeURIComponent(raw) })
    .email.toLowerCase();

const createSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).optional(),
    displayName: z.string().trim().max(120).optional(),
    quotaBytes: z.number().int().min(0).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    quotaBytes: z.number().int().min(0).optional(),
    aliases: z.array(z.string().email()).max(50).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const passwordSchema = z.object({ password: z.string().min(1).max(200) }).strict();
const resetSchema = z
  .object({ password: z.string().min(1).max(200).optional() })
  .strict()
  .optional();

export default function provisionRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const provided = request.headers['x-provision-key'];
    if (!(await isAuthorized(typeof provided === 'string' ? provided : undefined))) {
      const anyKey = envKey() !== null || (await hasActiveProvisionKey());
      return anyKey
        ? reply
            .code(401)
            .send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid provision key' })
        : reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });
    }
    if (!(await provisioningEnabled())) {
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'El provisioning de buzones no está habilitado en este servidor.',
      });
    }
  });

  // ── RECONCILIAR (force-sync brownfield) ──
  // Importa a Bifrost los buzones que existen en el servidor de correo pero no están en Mongo, y REPORTA
  // los huérfanos (en Mongo pero ya no en el servidor). Resuelve el limbo del CRUD cuando la gestión de
  // buzones ocurre FUERA de Bifrost (otro sistema tocó el accounts.cf): sin esto, un buzón creado por fuera
  // no aparece en `GET /mailboxes` (lee Mongo), `POST /mailboxes` da 409 "ya existe" y `DELETE` da 404 "no
  // existe". Idempotente. NO borra huérfanos (arrastraría correo indexado) — los lista para que el llamador
  // decida un DELETE explícito. Antes solo estaba en `/admin/accounts/import` (JWT), inalcanzable por API-key.
  fastify.post('/reconcile', { config: { requiresAuth: false } }, async (_request, reply) => {
    try {
      return await reconcileMailboxes();
    } catch (err) {
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: (err as Error).message,
      });
    }
  });

  // ── LISTAR (paginado + búsqueda) ──
  fastify.get('/mailboxes', { config: { requiresAuth: false } }, async (request) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(50),
        search: z.string().trim().max(200).optional(),
      })
      .parse(request.query);
    return listMailboxes(q);
  });

  // ── CREAR ── (idempotente-friendly vía Idempotency-Key)
  fastify.post('/mailboxes', { config: { requiresAuth: false } }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const idem = request.headers['idempotency-key'];
    const idemKey = typeof idem === 'string' && idem.trim() ? idem.trim() : null;
    if (idemKey) {
      const cached = idemGet(idemKey);
      if (cached) return reply.code(cached.status).send(cached.body);
    }

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
      // El email pedido ya es un ALIAS de otro buzón → no se puede crear como dirección real.
      if (err instanceof AliasConflictError) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Ese email ya está en uso como alias de otro buzón.',
        });
      }
      throw err; // atómico con rollback → sin buzón creado; el retry es seguro (→ 500 sin side-effect)
    }
    const quotaBytes = body.quotaBytes ?? (await getStorageDefaults()).defaultQuotaBytes;
    await Account.updateOne({ _id: result.account._id }, { $set: { quotaBytes } });

    const mailbox = await getMailbox(result.account.email);
    const respBody = {
      ...mailbox,
      // Password SÓLO si Bifrost la generó (se entrega UNA vez; no se persiste en claro).
      ...(result.passwordGenerated ? { password: result.password } : {}),
      // `rescued:true` ⇒ el buzón ya existía en el servidor sin registro en Bifrost (limbo) y se reconcilió
      // aplicándole esta contraseña, en vez de un 409 muerto. El caller lo distingue de un alta fresca.
      rescued: result.rescued,
    };
    // 200 (no 201) si fue un rescate: el recurso ya existía, sólo se reconcilió.
    const status = result.rescued ? 200 : 201;
    if (idemKey) idemSet(idemKey, status, respBody);
    return reply.code(status).send(respBody);
  });

  // ── VER una ──
  fastify.get('/mailboxes/:email', { config: { requiresAuth: false } }, async (request, reply) => {
    const email = emailParam((request.params as { email: string }).email);
    const mailbox = await getMailbox(email);
    if (!mailbox) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
    }
    return mailbox;
  });

  // ── EDITAR (displayName / quota / aliases / active) ──
  fastify.patch(
    '/mailboxes/:email',
    { config: { requiresAuth: false } },
    async (request, reply) => {
      const email = emailParam((request.params as { email: string }).email);
      const patch = patchSchema.parse(request.body);
      try {
        return await patchMailbox(email, patch);
      } catch (err) {
        if (err instanceof MailboxNotFoundError) {
          return reply
            .code(404)
            .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
        }
        if (err instanceof AliasConflictError) {
          return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: err.message });
        }
        // Un fallo del mailserver (alias/suspend) → 502 (sin side-effect parcial que importe).
        return reply.code(502).send({
          statusCode: 502,
          error: 'Bad Gateway',
          message: 'No se pudo aplicar el cambio en el servidor de correo. Reintentá.',
        });
      }
    }
  );

  // ── CAMBIAR contraseña (admin fija una) ──
  fastify.put(
    '/mailboxes/:email/password',
    { config: { requiresAuth: false } },
    async (request, reply) => {
      const email = emailParam((request.params as { email: string }).email);
      const { password } = passwordSchema.parse(request.body);
      try {
        await setMailboxPassword(email, password);
      } catch (err) {
        if (err instanceof MailboxNotFoundError) {
          return reply
            .code(404)
            .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
        }
        return reply.code(502).send({
          statusCode: 502,
          error: 'Bad Gateway',
          message: 'No se pudo cambiar la contraseña en el servidor de correo. Reintentá.',
        });
      }
      return { ok: true };
    }
  );

  // ── RESETEAR contraseña (Bifrost genera y devuelve UNA vez) ──
  fastify.post(
    '/mailboxes/:email/reset-password',
    { config: { requiresAuth: false } },
    async (request, reply) => {
      const email = emailParam((request.params as { email: string }).email);
      const body = resetSchema.parse(request.body ?? {});
      try {
        return await resetMailboxPassword(email, body?.password);
      } catch (err) {
        if (err instanceof MailboxNotFoundError) {
          return reply
            .code(404)
            .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
        }
        return reply.code(502).send({
          statusCode: 502,
          error: 'Bad Gateway',
          message: 'No se pudo resetear la contraseña en el servidor de correo. Reintentá.',
        });
      }
    }
  );

  // ── ELIMINAR ──
  fastify.delete(
    '/mailboxes/:email',
    { config: { requiresAuth: false } },
    async (request, reply) => {
      const email = emailParam((request.params as { email: string }).email);
      const account = await Account.findOne({ email }).select('userId email').lean();
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
}
