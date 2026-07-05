import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import { CalendarEvent, type ICalendarEvent } from '../../models/CalendarEvent.js';
import { GoogleConnection } from '../../models/GoogleConnection.js';
import { googleEnabled } from './creds.js';
import { withLock } from '../../lib/withLock.js';
import { upsertEvent, deleteEvent, type GoogleEventResource } from './calendar-api.js';
import { OAuthError } from './oauth.js';

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
    // Marca anti-loop (bidireccional): estos eventos los originó Bifrost → el poller no debe re-importarlos.
    extendedProperties: { private: { bifrostOrigin: '1' } },
  };
}

/** Punto de entrada del job. Serializa por evento; si otro job ya lo está sincronizando, no compite
 *  (ese job lee fresco y refleja el último estado; un cambio aún más nuevo lo retoma el reconciler). */
export async function syncEventToGoogle(eventId: string): Promise<void> {
  if (!(await googleEnabled())) return;
  await withLock(`gcal:evt:${eventId}`, () => doSync(eventId), { ttlSeconds: 30, waitMs: 5000 });
}

async function doSync(eventId: string): Promise<void> {
  const ev = await CalendarEvent.findById(eventId);
  if (!ev) return; // borrado en duro sin tombstone: no hay nada que reflejar
  const rev = ev.updatedAt; // CAS: sólo escribimos el estado terminal si el evento no cambió entretanto

  const isTombstone = ev.status === 'cancelled' || ev.googleSyncStatus === 'deleting';
  const conn = await GoogleConnection.findOne({ userId: ev.userId });

  // Conexión ausente o desconexión EXPLÍCITA ('revoked'): estado TERMINAL. Nunca va a volver a esa cuenta
  // esperando sync, así que un tombstone se limpia local (no hay token para borrar en Google) y el resto
  // se marca 'skipped' (sin backfill al reconectar; el reconciler no reintenta 'skipped' → sin churn).
  if (!conn || conn.status === 'revoked') {
    if (isTombstone) await CalendarEvent.deleteOne({ _id: ev._id, updatedAt: rev });
    else await mark(ev, 'skipped', rev);
    return;
  }
  // Conexión en 'error' (credencial revocada pero RECUPERABLE al reconectar): NO se llama a Google (evita
  // el martilleo de 401s en cada reconcile) y NO se hace terminal el estado → el evento queda como está
  // (pending/error/deleting) y, al reconectar, el reconciler lo retoma y sincroniza/borra. Self-healing;
  // el único costo es churn barato de DB, sin llamada externa (review B/C/D: evita perder cambios/huérfanos).
  if (conn.status !== 'connected') return;

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
    // Sólo un fallo PERMANENTE de auth (401 de la API / invalid_grant) marca la CONEXIÓN en error para
    // cortar YA el martilleo (sin esperar a que expire el access token). Un transitorio (5xx/red) deja la
    // conexión intacta y BullMQ reintenta — review B (LOW) / C (invariante de flip).
    if (err instanceof OAuthError && err.permanent) {
      await GoogleConnection.updateOne(
        { userId: ev.userId, status: 'connected' },
        { $set: { status: 'error', syncError: 'La conexión con Google fue rechazada. Reconectá.' } }
      );
    }
    throw err; // BullMQ reintenta
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
