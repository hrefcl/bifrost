import type { Types } from 'mongoose';
import { CalendarEvent } from '../../models/CalendarEvent.js';
import type { GoogleEventRead } from './calendar-api.js';

/**
 * Motor de IMPORT bidireccional (Google → Bifrost, F-gcal BD2). Aplica UN evento del feed de Google al store
 * local como `source:'google'` (calendario aparte "Google", read-only salvo borrar). Idempotente: upsert por
 * `{userId, googleEventId, source:'google'}`. Doble anti-loop (no re-importa lo que empujó Bifrost) + filtro
 * de eventTypes especiales. Ver diseño GOOGLE-CALENDAR-BIDIRECTIONAL.md.
 */
export const GOOGLE_CAL_ID = 'google';
export const GOOGLE_CAL_NAME = 'Google';
const GOOGLE_CAL_COLOR = '#4285F4'; // azul Google, distintivo del calendario importado

export type ImportOutcome = 'imported' | 'deleted' | 'skipped' | 'ignored';

/** Convierte un start/end de Google a los campos de CalendarEvent. */
function toDates(ev: GoogleEventRead): {
  startDate: Date;
  endDate: Date;
  startTimezone: string;
  endTimezone: string;
  allDay: boolean;
} {
  const allDay = Boolean(ev.start?.date);
  const startDate = new Date(ev.start?.dateTime ?? `${ev.start?.date ?? ''}T00:00:00Z`);
  const endDate = new Date(ev.end?.dateTime ?? `${ev.end?.date ?? ''}T00:00:00Z`);
  return {
    startDate,
    endDate,
    startTimezone: ev.start?.timeZone ?? 'UTC',
    endTimezone: ev.end?.timeZone ?? 'UTC',
    allDay,
  };
}

/**
 * Aplica un evento del delta. Devuelve la acción tomada:
 *  - 'skipped'  → es Bifrost-origen (marca bifrostOrigin o ya existe como manual/booking) → no se toca.
 *  - 'ignored'  → eventType especial (birthday/fromGmail/...) → no se importa.
 *  - 'deleted'  → borrado en Google (status cancelled) → se borra el local source:'google'.
 *  - 'imported' → creado/actualizado → upsert.
 * Respeta los tombstones de borrado bidireccional (googleDeletePending): no re-crea un evento que el usuario
 * borró en Bifrost y aún no se confirmó en Google (review B/D).
 */
export async function applyGoogleEvent(
  userId: Types.ObjectId | string,
  accountId: Types.ObjectId | string,
  ev: GoogleEventRead
): Promise<ImportOutcome> {
  // Anti-loop capa 1: lo empujó Bifrost → ya está representado (no re-importar).
  if (ev.extendedProperties?.private?.bifrostOrigin) return 'skipped';
  // Sólo eventos "normales"; se descartan birthday/fromGmail/workingLocation/focusTime/outOfOffice.
  if (ev.eventType && ev.eventType !== 'default') return 'ignored';

  // Borrado en Google → borrar el import local (si existe).
  if (ev.status === 'cancelled') {
    await CalendarEvent.deleteOne({ userId, googleEventId: ev.id, source: 'google' });
    return 'deleted';
  }

  // Anti-loop capa 2 (defensa en profundidad): si ya existe un Bifrost-origen con ese googleEventId, no
  // importar (cubre eventos empujados antes de tener la marca).
  const bifOrigin = await CalendarEvent.findOne({
    userId,
    googleEventId: ev.id,
    source: { $in: ['manual', 'booking'] },
  }).select('_id');
  if (bifOrigin) return 'skipped';

  // Tombstone de borrado bidireccional en curso → no re-crear (el delete remoto está pendiente).
  const pendingDelete = await CalendarEvent.findOne({
    userId,
    googleEventId: ev.id,
    source: 'google',
    googleDeletePending: true,
  }).select('_id');
  if (pendingDelete) return 'skipped';

  const d = toDates(ev);
  const set: Record<string, unknown> = {
    userId,
    accountId,
    source: 'google',
    calendarId: GOOGLE_CAL_ID,
    calendarName: GOOGLE_CAL_NAME,
    calendarColor: GOOGLE_CAL_COLOR,
    uid: ev.id, // satisface el índice único {accountId,calendarId,uid}
    googleEventId: ev.id,
    summary: ev.summary ?? '(sin título)',
    description: ev.description,
    location: ev.location,
    startDate: d.startDate,
    endDate: d.endDate,
    startTimezone: d.startTimezone,
    endTimezone: d.endTimezone,
    allDay: d.allDay,
    status: ev.status === 'tentative' ? 'tentative' : 'confirmed',
    googleEtag: ev.etag,
    googleICalUid: ev.iCalUID,
    recurringEventId: ev.recurringEventId,
    googleLastSyncedAt: new Date(),
  };
  await CalendarEvent.findOneAndUpdate(
    { userId, googleEventId: ev.id, source: 'google' },
    { $set: set },
    { upsert: true }
  );
  return 'imported';
}
