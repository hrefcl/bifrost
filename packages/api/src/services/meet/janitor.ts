import { RoomServiceClient } from 'livekit-server-sdk';
import { MeetRoom } from '../../models/MeetRoom.js';
import { getStoredMeetSettings } from './settings.js';
import {
  meetEnabled,
  resolveLivekitCreds,
  closeLiveKitRoom,
  withTimeout,
} from './token-service.js';

/**
 * Janitor de salas de Meet: cierra las que quedaron con UN SOLO participante durante demasiado tiempo
 * (la pestaña olvidada). Es la deuda que el diseño ya prometía (`MeetRoom.expiresAt`: "janitor +
 * empty_timeout") y que nunca se implementó.
 *
 * Por qué hace falta un barrido y no alcanza LiveKit: `empty_timeout` (5m) sólo dispara con la sala
 * VACÍA. Una pestaña abierta mantiene 1 participante conectado indefinidamente → la sala nunca se vacía
 * y el media server sigue gastando CPU/ancho de banda. Ese fue el bug reportado (sala viva 2 días).
 *
 * Defensa en DOS capas, igual que Google Meet:
 *  1. CLIENTE (MeetCallView): a los 13m solo pregunta "¿seguís ahí?" y a los 15m se desconecta. Es la
 *     capa que da UX (avisa antes de cortar) y la que gana en el caso normal.
 *  2. SERVIDOR (este janitor): red de seguridad a los 20m para cuando el cliente NO puede cumplir —
 *     pestaña con el JS congelado/suspendido, build vieja cacheada, o el equipo dormido sin cerrar la
 *     conexión. El margen sobre los 15m del cliente es a propósito: si el cliente está vivo, gana él
 *     (mejor UX); el servidor sólo actúa cuando el cliente falló.
 *
 * Si el usuario responde "seguir en la llamada", el cliente pega en `/still-here` y ese endpoint hace
 * `$unset` de `soloSince` → el reloj del servidor se reinicia junto con el del cliente. Sin eso, el
 * janitor mataría a los 20m a un usuario atento que está esperando a alguien que llega tarde.
 *
 * NO toca `MeetRoom.status`: la sala (sobre todo una `personal`, cuyo link es permanente) sigue activa
 * y reutilizable. Sólo se corta la sesión viva en LiveKit; el usuario puede volver a entrar con el
 * mismo link cuando quiera. Cerrar la fila rompería links legítimos.
 */

/** Un solo participante durante más de esto ⇒ el servidor corta (red de seguridad tras los 15m del cliente). */
export const SOLO_MAX_MS = 20 * 60 * 1000;
const LIST_TIMEOUT_MS = 5000;

export interface MeetJanitorResult {
  /** Salas vivas inspeccionadas. */
  seen: number;
  /** Salas cerradas por quedar solas demasiado tiempo. */
  closed: number;
}

export async function runMeetJanitor(now: number = Date.now()): Promise<MeetJanitorResult> {
  const empty: MeetJanitorResult = { seen: 0, closed: 0 };
  const settings = await getStoredMeetSettings();
  if (!meetEnabled(settings)) return empty;
  const creds = resolveLivekitCreds(settings);
  if (creds.source !== 'db' && creds.source !== 'env') return empty;

  const client = new RoomServiceClient(creds.apiUrl, creds.key, creds.secret);
  let rooms;
  try {
    rooms = await withTimeout(client.listRooms(), LIST_TIMEOUT_MS);
  } catch {
    // LiveKit lento/caído → no-fatal, se reintenta en el próximo barrido (mismo criterio que ensureRoom).
    return empty;
  }
  if (rooms.length === 0) return empty;

  const solo: string[] = [];
  const busy: string[] = [];
  for (const r of rooms) {
    (r.numParticipants === 1 ? solo : busy).push(r.name);
  }

  // Volvió a haber compañía (o quedó vacía → la mata `empty_timeout`): borrar la marca. El filtro por
  // `$exists` evita escrituras inútiles en el caso normal (casi ninguna sala tiene la marca puesta).
  if (busy.length > 0) {
    await MeetRoom.updateMany(
      { slug: { $in: busy }, soloSince: { $exists: true } },
      { $unset: { soloSince: '' } }
    );
  }

  if (solo.length === 0) return { seen: rooms.length, closed: 0 };

  const docs = await MeetRoom.find({ slug: { $in: solo } })
    .select('slug soloSince')
    .lean<{ slug: string; soloSince?: Date }[]>();
  const sinceBySlug = new Map(docs.map((d) => [d.slug, d.soloSince]));

  const toMark: string[] = [];
  const toClose: string[] = [];
  for (const slug of solo) {
    // Sin fila en Mongo no se puede mintear token, así que una sala así no debería existir; si existiera,
    // se la marca igual y el `updateMany` no la toca → nunca se cierra. Preferible a matar por
    // `creationTime`, que NO es "solo desde" (mataría una reunión larga apenas baja a 1 participante).
    const since = sinceBySlug.get(slug);
    if (!since) toMark.push(slug);
    else if (now - since.getTime() >= SOLO_MAX_MS) toClose.push(slug);
  }

  if (toMark.length > 0) {
    await MeetRoom.updateMany({ slug: { $in: toMark } }, { $set: { soloSince: new Date(now) } });
  }

  for (const slug of toClose) {
    await closeLiveKitRoom(settings, slug); // best-effort/no-fatal por diseño
  }
  if (toClose.length > 0) {
    await MeetRoom.updateMany({ slug: { $in: toClose } }, { $unset: { soloSince: '' } });
  }

  return { seen: rooms.length, closed: toClose.length };
}

/** Reinicia el reloj de inactividad de una sala ("sigo acá" del cliente). Idempotente. */
export async function markMeetRoomAlive(slug: string): Promise<void> {
  await MeetRoom.updateOne(
    { slug, status: 'active', soloSince: { $exists: true } },
    { $unset: { soloSince: '' } }
  );
}
