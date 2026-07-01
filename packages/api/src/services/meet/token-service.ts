import { randomBytes } from 'node:crypto';
import type mongoose from 'mongoose';
import { AccessToken, RoomServiceClient, type VideoGrant } from 'livekit-server-sdk';
import type { IMeetRoom } from '../../models/MeetRoom.js';
import { Booking } from '../../models/Booking.js';
import { CalendarEvent } from '../../models/CalendarEvent.js';
import { decrypt } from '../../config/crypto.js';
import type { StoredMeetSettings } from './settings.js';

/**
 * Servicio de tokens y salas de Bifrost Meet.
 *
 * Reglas duras (review B/C/D, DESIGN §5/§9):
 *  - El token se emite SIEMPRE en backend (la API key/secret nunca salen del server).
 *  - Identidad de participante OPACA y única (`<rolePrefix>-<rand>`); el display name es metadata.
 *  - Salas `per_event` (booking/calendar) tienen VENTANA temporal: nadie mintea tokens días antes ni
 *    fuera de horario (el host sí puede reabrir su propia sala).
 *  - El token de un evento NUNCA vive más allá de `endAt + 30m` (tope DURO — review B-LOW); el piso
 *    de 15m no puede empujar el expiry más allá de ese tope para invitados internos/externos.
 *  - El endpoint REQUIERE la fila MeetRoom y un backlink válido: un slug huérfano (crash entre el
 *    insert de MeetRoom y `Booking.create`) o de un booking cancelado NUNCA puede mintear tokens.
 *  - `ensureRoom` corre FUERA de todo lock, time-boxed y no-fatal (LiveKit caído ⇒ token igual sale;
 *    la sala se auto-crea al primer join con el grant `roomCreate`).
 */

export type MeetRole = 'host' | 'internal' | 'external';

export const EARLY_JOIN_MS = 15 * 60 * 1000; // se puede entrar 15m antes del inicio
export const GRACE_MS = 30 * 60 * 1000; // y hasta 30m después del fin (tope duro del token)
const TTL_FLOOR_SEC = 15 * 60; // piso de TTL para el host que reabre su sala
const PERSONAL_TTL_CAP_SEC = 12 * 3600; // techo de salas personales (sin ventana)
const EMPTY_TIMEOUT_SEC = 5 * 60; // LiveKit cierra la sala tras 5m vacía
const ENSURE_ROOM_TIMEOUT_MS = 3000; // ensureRoom time-boxed (no acopla el token a LiveKit)

/** Credenciales LiveKit RESUELTAS de una sola fuente (DB-XOR-env, atómicas — review F3.7 C-M1). */
export type LivekitCreds =
  | { source: 'db' | 'env'; key: string; secret: string; apiUrl: string }
  | { source: 'error' } // par DB presente pero NO desencriptable (ENCRYPTION_KEY rotada) — falla cerrado
  | { source: 'none' }; // sin credenciales en ningún lado

function deriveApiUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//i, 'http$1://');
}

/** Devuelve `explicit` si es no-vacío (tras trim), si no deriva el apiUrl del wsUrl. (`||` no se puede:
 *  el fallback es por string VACÍO, no solo null — `??` no lo cubre.) */
function apiUrlOrDerive(explicit: string | undefined, wsUrl: string): string {
  const t = explicit?.trim();
  return t && t.length > 0 ? t : deriveApiUrl(wsUrl);
}

/**
 * Resuelve el TRIPLE {key, secret, apiUrl} desde UNA sola fuente (review F3.7 C-M1/B/D), SÍNCRONO:
 *  - Par DB COMPLETO (`livekitApiKey` + `livekitApiSecretEnc`) → DB (decrypt). Si el decrypt LANZA
 *    (tag GCM no verifica = ENCRYPTION_KEY rotada) → `{source:'error'}`, NUNCA aliasa a env (review C-M2).
 *  - Par DB ausente o PARCIAL → env (fallback/bootstrap; backward-compat F3.1–F3.4).
 *  - Nada → `{source:'none'}`.
 * NUNCA mezcla key DB con apiUrl env ni viceversa.
 */
export function resolveLivekitCreds(s: StoredMeetSettings): LivekitCreds {
  const dbKey = s.livekitApiKey?.trim();
  if (dbKey && s.livekitApiSecretEnc) {
    let secret: string;
    try {
      secret = decrypt(s.livekitApiSecretEnc);
    } catch {
      return { source: 'error' };
    }
    return { source: 'db', key: dbKey, secret, apiUrl: apiUrlOrDerive(s.livekitApiUrl, s.wsUrl) };
  }
  const envKey = process.env.LIVEKIT_API_KEY?.trim();
  const envSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (envKey && envSecret) {
    return {
      source: 'env',
      key: envKey,
      secret: envSecret,
      apiUrl: apiUrlOrDerive(process.env.LIVEKIT_API_URL, s.wsUrl),
    };
  }
  return { source: 'none' };
}

/** Fuente efectiva (para el DTO admin). NO expone credenciales. */
export function livekitSourceOf(s: StoredMeetSettings): 'db' | 'env' | 'error' | 'none' {
  return resolveLivekitCreds(s).source;
}

/**
 * ¿Está la feature realmente operativa? TOTAL y boolean explícito — JAMÁS lanza (se llama en
 * `/api/config/public` SIN auth). Chequea PRESENCIA de credenciales (par DB presente OR par env presente),
 * NO desencripta (review F3.7 C-M2/C-L1): el decrypt y el fail-closed ocurren al emitir token. Exige
 * además el flag del admin + `wsUrl`/`publicBaseUrl` (sin ellos no hay link ni signaling — review D-005).
 */
export function meetEnabled(s: StoredMeetSettings): boolean {
  if (!s.enabled) return false;
  if (s.wsUrl.trim().length === 0 || s.publicBaseUrl.trim().length === 0) return false;
  const dbPresent = Boolean(s.livekitApiKey?.trim() && s.livekitApiSecretEnc);
  const envPresent = Boolean(
    process.env.LIVEKIT_API_KEY?.trim() && process.env.LIVEKIT_API_SECRET?.trim()
  );
  return dbPresent || envPresent;
}

/** Identidad opaca, no derivada del nombre visible (review B/D). */
export function makeOpaqueIdentity(role: MeetRole): string {
  const prefix = role === 'host' ? 'host' : role === 'internal' ? 'user' : 'guest';
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

/**
 * Grants por rol. `canPublish` habilita cámara, micrófono Y pantalla compartida (track `screen_share`)
 * → screen share es parte del MVP para los 3 roles, sin permiso extra. `roomCreate` permite auto-crear
 * la sala (por slug) al primer join si `ensureRoom` no llegó a crearla. NUNCA roomList/roomRecord.
 */
export function buildGrants(role: MeetRole, slug: string): VideoGrant {
  const base: VideoGrant = {
    room: slug,
    roomJoin: true,
    roomCreate: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  };
  if (role === 'host') base.roomAdmin = true; // sólo el host modera; interno/externo NO.
  return base;
}

/** Backing entity de una sala `per_event` (para backlink + ventana). */
interface Backing {
  startAt: Date;
  endAt: Date;
}

/**
 * Resuelve y VALIDA el backlink de la sala. Para `booking`/`calendar`, la fila de respaldo debe existir,
 * NO estar cancelada Y pertenecer al MISMO tenant que la sala (`userId`); si falla algo ⇒ `null` (el
 * caller hace 404). `manual`/`personal` no tienen backing ⇒ devuelve `{ ok: true, backing: null }`.
 *
 * El check de `userId` es defensa-en-profundidad multi-tenant (review B-LOW): un slug cuya fila de
 * respaldo fuera de otro tenant (no debería ocurrir, pero un bug futuro podría) nunca mintea token.
 */
export async function resolveBacklink(
  room: Pick<IMeetRoom, 'userId' | 'source' | 'bookingId' | 'calendarEventId' | 'mode'>
): Promise<{ ok: boolean; backing: Backing | null }> {
  if (room.source === 'booking') {
    if (!room.bookingId) return { ok: false, backing: null };
    const b = await Booking.findById(room.bookingId).select('startAt endAt status userId').lean<{
      startAt: Date;
      endAt: Date;
      status: string;
      userId: mongoose.Types.ObjectId;
    } | null>();
    if (b?.status !== 'confirmed' || !b.userId.equals(room.userId)) {
      return { ok: false, backing: null };
    }
    return { ok: true, backing: { startAt: b.startAt, endAt: b.endAt } };
  }
  if (room.source === 'calendar') {
    if (!room.calendarEventId) return { ok: false, backing: null };
    const e = await CalendarEvent.findById(room.calendarEventId)
      .select('startDate endDate status userId')
      .lean<{
        startDate: Date;
        endDate: Date;
        status: string;
        userId: mongoose.Types.ObjectId;
      } | null>();
    if (!e || e.status === 'cancelled' || !e.userId.equals(room.userId)) {
      return { ok: false, backing: null };
    }
    return { ok: true, backing: { startAt: e.startDate, endAt: e.endDate } };
  }
  // manual / personal: sin backing.
  return { ok: true, backing: null };
}

export type AuthzResult =
  | { allowed: true; ttlSeconds: number }
  | { allowed: false; code: 403; reason: 'too_early' | 'window_closed' | 'external_forbidden' };

/**
 * Autoriza la emisión del token (ventana temporal + allowExternal) y calcula el TTL. Función PURA
 * (sin IO) → testeable sin LiveKit ni Mongo.
 */
export function authorizeAndComputeTtl(params: {
  room: Pick<IMeetRoom, 'mode' | 'allowExternalOverride'>;
  backing: Backing | null;
  settings: Pick<StoredMeetSettings, 'maxDurationMinutes' | 'allowExternal'>;
  role: MeetRole;
  now: number;
}): AuthzResult {
  const { room, backing, settings, role, now } = params;

  // Gate allowExternal (sólo aplica a externos). Las salas de booking fuerzan override=true (C-M5).
  if (role === 'external') {
    const allowed = room.allowExternalOverride === true || settings.allowExternal;
    if (!allowed) return { allowed: false, code: 403, reason: 'external_forbidden' };
  }

  const capSec = Math.max(60, settings.maxDurationMinutes * 60);

  // Salas personales: sin ventana temporal.
  if (room.mode === 'personal' || !backing) {
    return { allowed: true, ttlSeconds: Math.min(capSec, PERSONAL_TTL_CAP_SEC) };
  }

  // Salas per_event: ventana temporal. El host puede reabrir su propia sala (bypass de ventana).
  const startMs = backing.startAt.getTime();
  const endMs = backing.endAt.getTime();
  const hardEndMs = endMs + GRACE_MS;
  if (role !== 'host') {
    if (now < startMs - EARLY_JOIN_MS) return { allowed: false, code: 403, reason: 'too_early' };
    if (now > hardEndMs) return { allowed: false, code: 403, reason: 'window_closed' };
  }

  const remainingSec = Math.floor((hardEndMs - now) / 1000);
  let ttlSeconds: number;
  if (role === 'host') {
    // host: piso de 15m (puede reabrir su propia sala), techo = cap. PRODUCT DECISION (review D-003):
    // el host SÍ puede bypassear el tope duro `endAt+30m` — es el dueño y reabrir su reunión es legítimo;
    // el token sigue acotado por el cap (`maxDurationMinutes`), nunca 6h del SDK.
    ttlSeconds = Math.min(capSec, Math.max(remainingSec, TTL_FLOOR_SEC));
  } else {
    // interno/externo: el token NUNCA vive más allá de `endAt + 30m` (tope DURO — review B-HIGH).
    ttlSeconds = Math.min(capSec, remainingSec);
    // En el último segundo antes del tope, `remainingSec` puede caer a 0. Un `ttl:0` es FALSY y el
    // SDK de LiveKit lo reemplaza por su default (≫ tope) → el token sobreviviría el tope duro
    // (review B-HIGH, AccessToken.ts:88 `options?.ttl || defaultTTL`). Por eso, en el borde, rechazamos
    // como ventana cerrada en vez de emitir un token muerto/peligroso.
    if (ttlSeconds < 1) return { allowed: false, code: 403, reason: 'window_closed' };
  }
  return { allowed: true, ttlSeconds };
}

/**
 * Emite el AccessToken JWT firmado con las credenciales RESUELTAS (DB-XOR-env). Si no hay credenciales
 * usables (`source` 'error'/'none') LANZA `LivekitCredsError` → el caller responde 503 (fail-closed —
 * review F3.7 B/C-H2: un par DB indesencriptable NO mintea con creds env equivocadas).
 */
export class LivekitCredsError extends Error {
  constructor(public source: 'error' | 'none') {
    super(`livekit creds unavailable (source=${source})`);
  }
}

export async function issueAccessToken(params: {
  settings: StoredMeetSettings;
  role: MeetRole;
  slug: string;
  identity: string;
  displayName: string;
  ttlSeconds: number;
}): Promise<string> {
  const creds = resolveLivekitCreds(params.settings);
  if (creds.source !== 'db' && creds.source !== 'env') throw new LivekitCredsError(creds.source);
  // Guardia dura: NUNCA pasar ttl<1 al SDK (un `0` falsy se reemplaza por su default ≫ tope — B-HIGH).
  // El authorizer ya garantiza ttl≥1; esto es defensa-en-profundidad por si cambia el caller.
  const ttl = Math.max(1, Math.floor(params.ttlSeconds));
  const at = new AccessToken(creds.key, creds.secret, {
    identity: params.identity,
    name: params.displayName,
    ttl,
  });
  at.addGrant(buildGrants(params.role, params.slug));
  return at.toJwt();
}

/**
 * Crea/asegura la sala en LiveKit (cap de participantes, empty_timeout). FUERA de todo lock,
 * time-boxed y NO-FATAL: si LiveKit está lento o caído, se traga el error (la sala se auto-crea al
 * primer join). `maxParticipants` ya viene clampeado al techo global por el caller.
 */
export async function ensureRoom(
  settings: StoredMeetSettings,
  slug: string,
  maxParticipants: number
): Promise<void> {
  const creds = resolveLivekitCreds(settings);
  if (creds.source !== 'db' && creds.source !== 'env') return; // sin creds usables → no-op (no-fatal)
  const client = new RoomServiceClient(creds.apiUrl, creds.key, creds.secret);
  const op = client.createRoom({
    name: slug,
    emptyTimeout: EMPTY_TIMEOUT_SEC,
    maxParticipants,
  });
  try {
    await withTimeout(op, ENSURE_ROOM_TIMEOUT_MS);
  } catch {
    // no-fatal por diseño (review C-H2): el token igual se emite.
  }
}

/** Cierra la sala en LiveKit (desconecta activos). Best-effort, no-fatal. */
export async function closeLiveKitRoom(settings: StoredMeetSettings, slug: string): Promise<void> {
  const creds = resolveLivekitCreds(settings);
  if (creds.source !== 'db' && creds.source !== 'env') return;
  const client = new RoomServiceClient(creds.apiUrl, creds.key, creds.secret);
  try {
    await withTimeout(client.deleteRoom(slug), ENSURE_ROOM_TIMEOUT_MS);
  } catch {
    // no-fatal.
  }
}

/** Clampa el cap por-sala al techo global de MeetSettings (review D-caveat). */
export function clampMaxParticipants(
  roomMax: number,
  settings: Pick<StoredMeetSettings, 'maxParticipants'>
): number {
  return Math.max(2, Math.min(roomMax, settings.maxParticipants));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}
