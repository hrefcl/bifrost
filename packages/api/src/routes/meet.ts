import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RoomServiceClient } from 'livekit-server-sdk';
import { MeetRoom, serializeMeetRoom, type IMeetRoom } from '../models/MeetRoom.js';
import {
  getStoredMeetSettings,
  setMeetSettings,
  type StoredMeetSettings,
} from '../services/meet/settings.js';
import {
  meetEnabled,
  resolveBacklink,
  authorizeAndComputeTtl,
  issueAccessToken,
  ensureRoom,
  closeLiveKitRoom,
  clampMaxParticipants,
  makeOpaqueIdentity,
  resolveLivekitCreds,
  livekitSourceOf,
  LivekitCredsError,
  type MeetRole,
} from '../services/meet/token-service.js';
import { isSafeS3Endpoint } from '../services/storage/s3.js';
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
  // LiveKit externo/Cloud (F3.7). `livekitApiSecret`: omitido=preserva, ''=clear (couple key+secret),
  // valor=set (se cifra). `livekitApiUrl` se valida http/https en el PATCH (anti-config rota).
  livekitApiKey: z.string().max(256).optional(),
  livekitApiSecret: z.string().max(512).optional(),
  livekitApiUrl: z.string().max(512).optional(),
  region: z.string().max(64).optional(),
  maxResolution: z.enum(['720p', '1080p']).optional(),
  autoRecord: z.boolean().optional(),
  onDemand: z.boolean().optional(),
});

/**
 * Defensa en profundidad (review B/D del modo LiveKit externo): el `wsUrl` es la URL de signaling a la que
 * conecta el NAVEGADOR → debe ser `wss://` (TLS). Rechaza `ws://` (dejaría media/token sin cifrar), http(s),
 * userinfo y paths raros. No bloquea hosts internos a propósito: igual que el resto de Meet asume admin
 * confiable (el bundled usa hosts internos para el apiUrl); acá sólo se garantiza el TRANSPORTE seguro.
 */
export function isSafeExternalWsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'wss:') return false;
  if (u.username || u.password) return false;
  if (u.search || u.hash) return false;
  if (u.pathname !== '/' && u.pathname !== '') return false;
  return true;
}

// Body del endpoint de prueba de conexión: usa las creds guardadas, o un candidato (sin persistir).
const testBodySchema = z.object({
  livekitApiUrl: z.string().max(512).optional(),
  livekitApiKey: z.string().max(256).optional(),
  livekitApiSecret: z.string().max(512).optional(),
});

/** DTO admin (allowlist): NUNCA expone el secret (ni plano ni cifrado). Solo `hasApiSecret`+`livekitSource`. */
function toAdminMeetSettings(s: StoredMeetSettings): MeetSettings {
  return {
    enabled: s.enabled,
    wsUrl: s.wsUrl,
    publicBaseUrl: s.publicBaseUrl,
    turnDomain: s.turnDomain,
    maxParticipants: s.maxParticipants,
    maxDurationMinutes: s.maxDurationMinutes,
    allowExternal: s.allowExternal,
    branding: s.branding,
    auditEnabled: s.auditEnabled,
    recordingPolicy: 'disabled',
    livekitApiKey: s.livekitApiKey,
    livekitApiUrl: s.livekitApiUrl,
    region: s.region,
    maxResolution: s.maxResolution,
    autoRecord: s.autoRecord,
    onDemand: s.onDemand,
    // `hasApiSecret` ⟺ PAR DB estructuralmente usable (key+secret), no solo el ciphertext presente —
    // así el DTO no miente si quedara un `secretEnc` huérfano de datos legacy (review C-F1/D-005).
    hasApiSecret: Boolean(s.livekitApiKey?.trim() && s.livekitApiSecretEnc),
    livekitSource: livekitSourceOf(s),
  };
}

function newSlug(): string {
  return randomBytes(16).toString('base64url');
}

/** Primer valor no-vacío (tras trim). Fallback por string VACÍO, no solo null → `??` no lo cubre. */
function firstNonEmpty(...vals: (string | undefined)[]): string {
  for (const v of vals) {
    const t = v?.trim();
    if (t && t.length > 0) return t;
  }
  return '';
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
  settings: StoredMeetSettings,
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
      const settings = await getStoredMeetSettings();
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
        return reply.code(500).send({
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
    const settings = await getStoredMeetSettings();
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
      const settings = await getStoredMeetSettings();
      if (!meetEnabled(settings)) return reply.send({ disabled: true });
      const { slug } = slugParam.parse(request.params);
      const room = await MeetRoom.findOne({ slug, userId: request.user.userId, status: 'active' });
      if (!room) return notFound(reply);
      if (room.mode !== 'personal') {
        return reply.code(409).send({
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
    const settings = await getStoredMeetSettings();
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
      const settings = await getStoredMeetSettings();
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
      const settings = await getStoredMeetSettings();
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
      const settings = await getStoredMeetSettings();
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
  settings: StoredMeetSettings,
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
  let token: string;
  try {
    token = await issueAccessToken({
      settings,
      role,
      slug: room.slug,
      identity,
      displayName: name,
      ttlSeconds: authz.ttlSeconds,
    });
  } catch (err) {
    // Credenciales LiveKit no usables (par DB indesencriptable / ausentes) → FAIL-CLOSED 503 (review
    // F3.7 B/C-H2): no se mintea con creds equivocadas. El admin ve `livekitSource:'error'` en el panel.
    if (err instanceof LivekitCredsError) {
      request.log.error({ meet: 'token.creds_unavailable', source: err.source, slug: room.slug });
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'meet_unavailable',
      });
    }
    throw err;
  }

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

  // GET → DTO admin (NUNCA el secret; solo hasApiSecret + livekitSource).
  fastify.get('/settings', async () => {
    return { settings: toAdminMeetSettings(await getStoredMeetSettings()) };
  });

  fastify.patch('/settings', async (request, reply) => {
    const patch = settingsPatchSchema.parse(request.body);
    // Validaciones de integridad del par/URL antes de persistir:
    // - setear un secret (valor no vacío) exige una key (par completo) — actual o en el mismo patch.
    if (patch.livekitApiSecret !== undefined && patch.livekitApiSecret !== '') {
      const current = await getStoredMeetSettings();
      const keyAfter = patch.livekitApiKey ?? current.livekitApiKey;
      if (!keyAfter || keyAfter.trim().length === 0) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'livekit_api_key_required_with_secret',
        });
      }
    }
    // - el apiUrl, si se setea, debe ser http/https sin userinfo (anti-config rota / SSRF básico).
    if (
      patch.livekitApiUrl !== undefined &&
      patch.livekitApiUrl !== '' &&
      !isSafeS3Endpoint(patch.livekitApiUrl)
    ) {
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'invalid_livekit_api_url' });
    }
    // - el wsUrl (signaling del navegador), si se setea, debe ser wss:// (TLS). Defensa en profundidad
    //   del modo LiveKit externo: no persistir un canal inseguro configurado por PATCH.
    if (patch.wsUrl !== undefined && patch.wsUrl !== '' && !isSafeExternalWsUrl(patch.wsUrl)) {
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'invalid_livekit_ws_url' });
    }
    const stored = await setMeetSettings(patch);
    return { settings: toAdminMeetSettings(stored) };
  });

  // Prueba de conexión al LiveKit configurado (o un candidato sin persistir). Admin-only + rate-limit
  // estricto (~5/min) + URL http/https sin userinfo + timeout abortable + respuesta por CATEGORÍA
  // (nunca el mensaje raw del SDK ni el secret en logs — review F3.7 M4). NOTA: alcanza hosts internos
  // por diseño (el livekit bundled es `http://livekit:7880`, IP privada de docker) → asume admin confiable.
  fastify.post(
    '/test',
    // `skipOnError:false` (review D-003): fail-closed si el store del rate-limit falla → no se vuelve
    // un escáner interno sin límite aunque sea admin-only.
    { config: { rateLimit: { max: 5, timeWindow: '1 minute', skipOnError: false } } },
    async (request, reply) => {
      const body = testBodySchema.parse(request.body ?? {});
      const stored = await getStoredMeetSettings();
      // Resolver las creds a probar: candidato del body si vino completo; si no, las efectivas guardadas.
      let apiUrl: string;
      let key: string;
      let secret: string;
      if (body.livekitApiKey && body.livekitApiSecret) {
        // wss→https / ws→http PRESERVANDO la 's' (review D-001: `/^ws/`→'http' rompía TLS de Cloud).
        apiUrl = firstNonEmpty(
          body.livekitApiUrl,
          stored.livekitApiUrl,
          stored.wsUrl.replace(/^ws(s?):\/\//i, 'http$1://')
        );
        key = body.livekitApiKey;
        secret = body.livekitApiSecret;
      } else {
        const creds = resolveLivekitCreds(stored);
        if (creds.source !== 'db' && creds.source !== 'env') {
          return reply.send({ ok: false, category: 'invalid' });
        }
        apiUrl = firstNonEmpty(body.livekitApiUrl, creds.apiUrl);
        key = creds.key;
        secret = creds.secret;
      }
      if (!isSafeS3Endpoint(apiUrl)) {
        return reply.send({ ok: false, category: 'invalid' });
      }
      let result: { ok: boolean; category: string; activeRooms?: number };
      // El timer del race se LIMPIA en `finally` (review C-F2: el setTimeout perdedor dejaba un timer de
      // 3s residual). Nota: el race acota la RESPUESTA, no aborta el `listRooms()` subyacente — el SDK no
      // expone AbortSignal; el socket queda hasta su propio timeout. Aceptable: admin-only + 5/min.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const client = new RoomServiceClient(apiUrl, key, secret);
        const rooms = await Promise.race([
          client.listRooms(),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              rej(new Error('timeout'));
            }, 3000);
          }),
        ]);
        result = { ok: true, category: 'reachable', activeRooms: rooms.length };
      } catch (err) {
        // Categoría genérica — nunca el mensaje raw (delata topología) ni el secret. Solo 401/unauthorized
        // → 'unauthorized' (review C-F3: 'invalid' aparece en errores de red → mislabel de host alcanzable).
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        const category =
          msg.includes('401') || msg.includes('unauthorized') ? 'unauthorized' : 'unreachable';
        request.log.warn({ meet: 'test.fail', category });
        result = { ok: false, category };
      } finally {
        if (timer) clearTimeout(timer);
      }
      return reply.send(result);
    }
  );
}
