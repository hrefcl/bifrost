import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import { CalendarEvent, type ICalendarEvent } from '../../models/CalendarEvent.js';
import { GoogleConnection } from '../../models/GoogleConnection.js';
import { googleConfigured } from '../../config/env.js';
import { upsertEvent, deleteEvent, type GoogleEventResource } from './calendar-api.js';

/**
 * Motor de sincronización de UN evento con Google (F-gcal G3, v1 unidireccional Bifrost→Google).
 * Desacoplado del calendario y del OAuth. El job es IDEMPOTENTE: lee el evento fresco y decide por su
 * estado actual (upsert vs. delete), de modo que reintentos o ediciones repetidas convergen sin duplicar.
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

/**
 * Sincroniza un evento con Google. Lee FRESCO y decide:
 *  - tombstone (status 'cancelled' o googleSyncStatus 'deleting') → borra en Google (por id determinista,
 *    idempotente: un 404 = ya no está = éxito).
 *  - resto → upsert idempotente.
 * Persiste el resultado en googleSyncStatus/Error. Re-lanza en fallo para que BullMQ reintente.
 * Aislamiento: SIEMPRE contra la conexión del dueño del evento (nunca cruza usuarios).
 */
export async function syncEventToGoogle(eventId: string): Promise<void> {
  if (!googleConfigured()) return;
  const ev = await CalendarEvent.findById(eventId);
  if (!ev) return; // borrado en duro sin tombstone: no hay nada que reflejar

  const isTombstone = ev.status === 'cancelled' || ev.googleSyncStatus === 'deleting';
  const conn = await GoogleConnection.findOne({ userId: ev.userId });
  if (!conn || conn.status === 'revoked') {
    // El dueño no tiene Google conectado. Si es un tombstone, no hay forma de borrar en Google → se
    // limpia el doc local para no dejar un evento cancelado colgando; si no, sólo se marca skipped.
    if (isTombstone) await CalendarEvent.deleteOne({ _id: ev._id });
    else await mark(ev, 'skipped');
    return;
  }
  const calId = conn.googleCalendarId || 'primary';
  const gid = ev.googleEventId ?? googleEventIdFor(ev._id);

  try {
    if (isTombstone) {
      await deleteEvent(ev.userId, calId, gid); // idempotente (404 = ya no está = ok)
      await CalendarEvent.deleteOne({ _id: ev._id }); // Google confirmó → se elimina el tombstone local
    } else {
      await upsertEvent(ev.userId, calId, toGoogleResource(ev, gid));
      await mark(ev, 'synced', gid);
    }
  } catch (err) {
    await mark(ev, 'error', gid, (err as Error).message);
    throw err; // BullMQ reintenta; si fue OAuthError, connection.ts ya marcó la conexión
  }
}

async function mark(
  ev: ICalendarEvent,
  status: NonNullable<ICalendarEvent['googleSyncStatus']>,
  gid?: string,
  error?: string
): Promise<void> {
  const set: Record<string, unknown> = { googleSyncStatus: status };
  if (gid) set.googleEventId = gid;
  if (status === 'synced' || status === 'deleted') set.googleLastSyncedAt = new Date();
  const update: Record<string, unknown> = { $set: set };
  if (error) set.googleSyncError = error.slice(0, 500);
  else update.$unset = { googleSyncError: '' };
  await CalendarEvent.updateOne({ _id: ev._id }, update);
}
