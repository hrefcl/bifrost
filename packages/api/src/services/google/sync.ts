import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import { CalendarEvent, type ICalendarEvent } from '../../models/CalendarEvent.js';
import { GoogleConnection } from '../../models/GoogleConnection.js';
import { googleConfigured } from '../../config/env.js';
import { withLock } from '../../lib/withLock.js';
import { upsertEvent, deleteEvent, type GoogleEventResource } from './calendar-api.js';

/**
 * Motor de sincronización de UN evento con Google (F-gcal G3, v1 unidireccional Bifrost→Google).
 * Desacoplado del calendario y del OAuth. El job es IDEMPOTENTE: lee el evento fresco y decide por su
 * estado actual (upsert vs. delete), de modo que reintentos o ediciones repetidas convergen sin duplicar.
 *
 * Concurrencia (review B HIGH): la sync de un evento se SERIALIZA con `withLock` por eventId (evita que
 * un upsert en vuelo y un delete se reordenen → nada de recrear en Google algo ya borrado). Además, las
 * escrituras terminales de estado usan CAS sobre `updatedAt`: si el evento cambió mientras el job hablaba
 * con Google, NO se pisa el estado nuevo (lo retoma el job siguiente / el reconciler).
 */

/**
 * Id determinista y estable del evento en Google, derivado del `_id` (único). Idempotente: mismo `_id`
 * ⇒ mismo id ⇒ jamás duplica. Válido para Google (regex `[a-v0-9]{5,1024}`: el hex `0-9a-f` cae dentro).
 */
export function googleEventIdFor(eventId: Types.ObjectId | string): string {
  return 'bif' + createHash('sha256').update(String(eventId)).digest('hex');
}

function toGoogleResource(ev: ICalendarEvent, id: string): GoogleEventResource {
  const start = ev.allDay
    ? { date: ev.startDate.toISOString().slice(0, 10) }
    : { dateTime: ev.startDate.toISOString(), timeZone: ev.startTimezone || 'UTC' };
  const end = ev.allDay
    ? { date: ev.endDate.toISOString().slice(0, 10) }
    : { dateTime: ev.endDate.toISOString(), timeZone: ev.endTimezone || 'UTC' };
  return {
    id,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    start,
    end,
    status: ev.status === 'tentative' ? 'tentative' : 'confirmed',
  };
}

/** Punto de entrada del job. Serializa por evento; si otro job ya lo está sincronizando, no compite
 *  (ese job lee fresco y refleja el último estado; un cambio aún más nuevo lo retoma el reconciler). */
export async function syncEventToGoogle(eventId: string): Promise<void> {
  if (!googleConfigured()) return;
  await withLock(`gcal:evt:${eventId}`, () => doSync(eventId), { ttlSeconds: 30, waitMs: 5000 });
}

async function doSync(eventId: string): Promise<void> {
  const ev = await CalendarEvent.findById(eventId);
  if (!ev) return; // borrado en duro sin tombstone: no hay nada que reflejar
  const rev = ev.updatedAt; // CAS: sólo escribimos el estado terminal si el evento no cambió entretanto

  const isTombstone = ev.status === 'cancelled' || ev.googleSyncStatus === 'deleting';
  const conn = await GoogleConnection.findOne({ userId: ev.userId });
  if (!conn || conn.status === 'revoked') {
    // El dueño no tiene Google conectado. Si es un tombstone, no hay forma de borrar en Google → se
    // limpia el doc local para no dejar un evento cancelado colgando; si no, sólo se marca skipped.
    if (isTombstone) await CalendarEvent.deleteOne({ _id: ev._id, updatedAt: rev });
    else await mark(ev, 'skipped', rev);
    return;
  }
  const calId = conn.googleCalendarId || 'primary';
  const gid = ev.googleEventId ?? googleEventIdFor(ev._id);

  try {
    if (isTombstone) {
      await deleteEvent(ev.userId, calId, gid); // idempotente (404 = ya no está = ok)
      // Google confirmó → se elimina el tombstone local, salvo que una edición concurrente lo haya
      // tocado (updatedAt cambió) → lo retoma el próximo job/reconciler.
      await CalendarEvent.deleteOne({ _id: ev._id, updatedAt: rev });
    } else {
      await upsertEvent(ev.userId, calId, toGoogleResource(ev, gid));
      await mark(ev, 'synced', rev, gid);
    }
  } catch (err) {
    await mark(ev, 'error', rev, gid, (err as Error).message);
    throw err; // BullMQ reintenta; si fue OAuthError, connection.ts ya marcó la conexión
  }
}

async function mark(
  ev: ICalendarEvent,
  status: NonNullable<ICalendarEvent['googleSyncStatus']>,
  rev: Date,
  gid?: string,
  error?: string
): Promise<void> {
  const set: Record<string, unknown> = { googleSyncStatus: status };
  if (gid) set.googleEventId = gid;
  if (status === 'synced') set.googleLastSyncedAt = new Date();
  const update: Record<string, unknown> = { $set: set };
  if (error) set.googleSyncError = error.slice(0, 500);
  else update.$unset = { googleSyncError: '' };
  // CAS: sólo si el evento no fue modificado desde que el job lo leyó (evita pisar un pending/deleting
  // que dejó una edición/borrado concurrente — review B HIGH).
  await CalendarEvent.updateOne({ _id: ev._id, updatedAt: rev }, update);
}
