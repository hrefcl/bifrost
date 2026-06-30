import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { MeetRoom, serializeMeetRoom, type IMeetRoom } from '../models/MeetRoom.js';
import { getMeetSettings, setMeetSettings } from '../services/meet/settings.js';
import {
  meetEnabled,
  resolveBacklink,
  authorizeAndComputeTtl,
  issueAccessToken,
  ensureRoom,
  closeLiveKitRoom,
  clampMaxParticipants,
  makeOpaqueIdentity,
  type MeetRole,
} from '../services/meet/token-service.js';
import { requireAdmin } from '../lib/authz.js';
import { counters } from '../lib/metrics.js';
import type { MeetSettings } from '@webmail6/shared';

const SLUG_RE = /^[A-Za-z0-9_-]{8,64}$/;
const slugParam = z.object({ slug: z.string().regex(SLUG_RE) });

// Las salas creadas manualmente son SIEMPRE `personal` (sin ventana). Las `per_event` sólo nacen de
// bookings/calendar (F3.2) con su backing; permitir `per_event` manual creaba un estado sin backing
// que se comportaba como personal pero sin `expiresAt` (review B/C/D-002). Por eso `mode` no se acepta.
const createRoomSchema = z.object({
  name: z.string().min(1).max(200),
  maxParticipants: z.number().int().min(2).max(1000).optional(),
  allowExternal: z.boolean().optional(),
});

const tokenBodySchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
});

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  wsUrl: z.string().max(512).optional(),
  publicBaseUrl: z.string().max(512).optional(),
  turnDomain: z.string().max(255).optional(),
  maxParticipants: z.number().int().min(2).max(1000).optional(),
  maxDurationMinutes: z.number().int().min(5).max(1440).optional(),
  allowExternal: z.boolean().optional(),
  branding: z.object({ displayName: z.string().max(120).optional() }).optional(),
  auditEnabled: z.boolean().optional(),
});

function newSlug(): string {
  return randomBytes(16).toString('base64url');
}

/** ¿Es una colisión de índice único sobre `slug`? (NO cualquier E11000 — review C-L2). */
function isSlugCollision(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  if (e.code !== 11000) return false;
  // Distinguir la colisión de slug de otras (p.ej. {bookingId} en F3.2): sólo regeneramos el slug.
  if (e.keyPattern) return Object.prototype.hasOwnProperty.call(e.keyPattern, 'slug');
  return typeof e.message === 'string' && e.message.includes('slug');
}

/** 404 idéntico para "no existe" y "closed"/"no es tuya" → no filtra existencia de slugs (review D-M5). */
function notFound(reply: FastifyReply) {
  return reply
    .code(404)
    .send({ statusCode: 404, error: 'Not Found', message: 'Sala no encontrada' });
}

function audit(
  request: { log: FastifyInstance['log'] },
  settings: MeetSettings,
  event: string,
  data: Record<string, unknown>
) {
  if (settings.auditEnabled) request.log.info({ meet: event, ...data }, `meet.${event}`);
}

/** Rutas de Bifrost Meet (`prefix: /api/meet`). */
export default function meetRoutes(fastify: FastifyInstance) {
  // ---- Salas del host (JWT) ----

  // Crear sala manual/personal del usuario autenticado.
  fastify.post(
    '/rooms',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = await getMeetSettings();
      if (!meetEnabled(settings)) return reply.send({ disabled: true });
      const body = createRoomSchema.parse(request.body);
      const userId = request.user.userId;
      const maxParticipants = clampMaxParticipants(
        body.maxParticipants ?? settings.maxParticipants,
        settings
      );

      let room: IMeetRoom | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          room = await MeetRoom.create({
            userId,
            slug: newSlug(),
            name: body.name,
            mode: 'personal', // las salas manuales son siempre personales (sin ventana)
            status: 'active',
            source: 'manual',
            maxParticipants,
            allowExternalOverride: body.allowExternal === true ? true : undefined,
          });
          break;
        } catch (err) {
          if (isSlugCollision(err) && attempt < 2) continue; // colisión de slug global → regenerar
          throw err;
        }
      }
      if (!room)
        return reply
          .code(500)
          .send({
            statusCode: 500,
            error: 'Internal Server Error',
            message: 'No se pudo crear la sala',
          });

      counters.meetRoomsCreated++;
      audit(request, settings, 'room.create', { slug: room.slug, userId, source: 'manual' });
      return reply.code(201).send({ room: serializeMeetRoom(room, settings.publicBaseUrl) });
    }
  );

  // Metadata de una sala propia.
  fastify.get('/rooms/:slug', async (request, reply) => {
    const settings = await getMeetSettings();
    if (!meetEnabled(settings)) return reply.send({ disabled: true });
    const { slug } = slugParam.parse(request.params);
    const room = await MeetRoom.findOne({ slug, userId: request.user.userId, status: 'active' });
    if (!room) return notFound(reply);
    return reply.send({ room: serializeMeetRoom(room, settings.publicBaseUrl) });
  });

  // Rota el slug (salas personales): invalida links viejos (review C-M4).
  fastify.post(
    '/rooms/:slug/rotate',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = await getMeetSettings();
      if (!meetEnabled(settings)) return reply.send({ disabled: true });
      const { slug } = slugParam.parse(request.params);
      const room = await MeetRoom.findOne({ slug, userId: request.user.userId, status: 'active' });
      if (!room) return notFound(reply);
      if (room.mode !== 'personal') {
        return reply
          .code(409)
          .send({
            statusCode: 409,
            error: 'Conflict',
            message: 'Sólo se rota el slug de salas personales',
          });
      }
      // Cierra la sala LiveKit del slug viejo (desconecta) antes de cambiar.
      await closeLiveKitRoom(settings, room.slug);
      for (let attempt = 0; attempt < 3; attempt++) {
        room.slug = newSlug();
        try {
          await room.save();
          break;
        } catch (err) {
          if (isSlugCollision(err) && attempt < 2) continue;
          throw err;
        }
      }
      audit(request, settings, 'room.rotate', { slug: room.slug, userId: request.user.userId });
      return reply.send({ room: serializeMeetRoom(room, settings.publicBaseUrl) });
    }
  );

  // Cierra (soft) la sala + deleteRoom best-effort.
  fastify.delete('/rooms/:slug', async (request, reply) => {
    const settings = await getMeetSettings();
    if (!meetEnabled(settings)) return reply.send({ disabled: true });
    const { slug } = slugParam.parse(request.params);
    const room = await MeetRoom.findOne({ slug, userId: request.user.userId, status: 'active' });
    if (!room) return notFound(reply);
    room.status = 'closed';
    await room.save();
    await closeLiveKitRoom(settings, slug);
    audit(request, settings, 'room.close', { slug, userId: request.user.userId });
    return reply.send({ ok: true });
  });

  // Token host/interno (JWT). host = dueño de la sala; cualquier otro autenticado = interno.
  fastify.post(
    '/rooms/:slug/token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = await getMeetSettings();
      if (!meetEnabled(settings)) return notFound(reply);
      const { slug } = slugParam.parse(request.params);
      const body = tokenBodySchema.parse(request.body ?? {});
      const room = await MeetRoom.findOne({ slug, status: 'active' });
      if (!room) return notFound(reply);
      const role: MeetRole = room.userId.toString() === request.user.userId ? 'host' : 'internal';
      return issueForRoom(request, reply, settings, room, role, body.displayName);
    }
  );

  // ---- Endpoints PÚBLICOS (sin auth) ----

  // Metadata mínima pública. 404 IDÉNTICO si no existe/closed (no enumerable). Rate-limit IP+slug.
  fastify.get(
    '/public/:slug',
    {
      config: { requiresAuth: false, rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const settings = await getMeetSettings();
      if (!meetEnabled(settings)) return notFound(reply);
      const parsed = slugParam.safeParse(request.params);
      if (!parsed.success) return notFound(reply);
      const room = await MeetRoom.findOne({ slug: parsed.data.slug, status: 'active' })
        .select('userId slug name mode source bookingId calendarEventId')
        .lean<Pick<
          IMeetRoom,
          'userId' | 'slug' | 'name' | 'mode' | 'source' | 'bookingId' | 'calendarEventId'
        > | null>();
      if (!room) return notFound(reply);
      // Mismo backlink que el endpoint de token: un slug huérfano/cancelado NO es observable (review
      // B-MED/C-L3) → 404 idéntico, así la metadata pública no filtra existencia de salas muertas.
      const link = await resolveBacklink(room);
      if (!link.ok) return notFound(reply);
      // Sólo lo mínimo para la pantalla de unión (sin userId ni datos privados).
      return reply.send({
        room: { slug: room.slug, name: room.name, mode: room.mode },
        // Salas personales no piden nombre (el host se identifica); per_event sí (invitado).
        requiresName: room.mode !== 'personal',
      });
    }
  );

  // Token de invitado externo. Rate-limit ESTRICTO fail-closed (review B-MED/C-M1/D-001): `skipOnError:
  // false` sobrescribe el global (`skipOnError:true`) → si el store del limiter falla, la request se
  // RECHAZA (no se relaja). Key = IP+slug (DESIGN §100) para que el límite sea por slug, no global por IP.
  fastify.post(
    '/public/:slug/token',
    {
      config: {
        requiresAuth: false,
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          skipOnError: false,
          keyGenerator: (req) => {
            const slug = (req.params as { slug?: string }).slug ?? '';
            return `meet-token|${req.ip}|${slug}`;
          },
        },
      },
    },
    async (request, reply) => {
      const settings = await getMeetSettings();
      if (!meetEnabled(settings)) return notFound(reply);
      const parsed = slugParam.safeParse(request.params);
      if (!parsed.success) return notFound(reply);
      const body = tokenBodySchema.parse(request.body ?? {});
      const room = await MeetRoom.findOne({ slug: parsed.data.slug, status: 'active' });
      if (!room) return notFound(reply);
      return issueForRoom(request, reply, settings, room, 'external', body.displayName);
    }
  );
}

/**
 * Lógica común de emisión: backlink → autorización/ventana/ttl → token → ensureRoom (no-fatal) →
 * audit. Devuelve `MeetTokenResponse` o el código de error correspondiente.
 */
async function issueForRoom(
  request: { log: FastifyInstance['log']; ip: string },
  reply: FastifyReply,
  settings: MeetSettings,
  room: IMeetRoom,
  role: MeetRole,
  displayName?: string
) {
  // Backlink: salas booking/calendar exigen fila de respaldo no-cancelada (404 si huérfana — B-H1).
  const link = await resolveBacklink(room);
  if (!link.ok) return notFound(reply);

  const authz = authorizeAndComputeTtl({
    room,
    backing: link.backing,
    settings,
    role,
    now: Date.now(),
  });
  if (!authz.allowed) {
    return reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: authz.reason });
  }

  const identity = makeOpaqueIdentity(role);
  const name = (displayName ?? '').trim() || (role === 'host' ? 'Anfitrión' : 'Invitado');
  const token = await issueAccessToken({
    role,
    slug: room.slug,
    identity,
    displayName: name,
    ttlSeconds: authz.ttlSeconds,
  });

  // ensureRoom FUERA de cualquier lock y NO-bloqueante (review C-L6): fire-and-forget para no sumar
  // hasta 3s de latencia al token bajo un burst de joins. La sala igual se auto-crea al primer join
  // (grant `roomCreate`) y el techo global de livekit.yaml protege el cap aunque ensureRoom no llegue
  // a correr. `ensureRoom` ya traga sus propios errores; el `.catch` es sólo por el unhandled-rejection.
  void ensureRoom(settings, room.slug, clampMaxParticipants(room.maxParticipants, settings)).catch(
    () => undefined
  );

  counters.meetTokensIssued++;
  audit(request, settings, 'token.issue', {
    slug: room.slug,
    role,
    identity,
    ip: request.ip,
    ttl: authz.ttlSeconds,
  });

  return reply.send({
    token,
    wsUrl: settings.wsUrl,
    room: room.slug,
    identity,
    role,
    expiresInSeconds: authz.ttlSeconds,
  });
}

/** Rutas admin de Meet (`prefix: /api/admin/meet`). Sólo rol admin. */
export function meetAdminRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request) => {
    await requireAdmin(request.user.userId);
  });

  fastify.get('/settings', async () => {
    return { settings: await getMeetSettings() };
  });

  fastify.patch('/settings', async (request) => {
    const patch = settingsPatchSchema.parse(request.body);
    return { settings: await setMeetSettings(patch) };
  });
}
