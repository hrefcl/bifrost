import mongoose, { Schema, type Document } from 'mongoose';
import type { CalendarEvent as CalendarEventDto } from '@webmail6/shared';

export interface ICalendarEvent extends Document {
  userId: mongoose.Types.ObjectId;
  accountId: mongoose.Types.ObjectId;
  calendarId: string;
  calendarName: string;
  calendarColor?: string;
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  startDate: Date;
  startTimezone: string;
  endDate: Date;
  endTimezone: string;
  allDay: boolean;
  recurrenceRule?: string;
  recurrenceExceptions?: string[];
  organizer?: { name?: string; address: string };
  attendees?: { name?: string; email: string; status: string; role: string }[];
  inviteStatus?: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  sourceEmailId?: mongoose.Types.ObjectId;
  /** 'booking' = bloque busy de una reserva; 'google' = IMPORTADO de Google (bidireccional, read-only en
   *  Bifrost salvo borrar). Default 'manual'. */
  source?: 'manual' | 'booking' | 'google';
  bookingId?: mongoose.Types.ObjectId;
  meetRoomId?: mongoose.Types.ObjectId;
  meetUrl?: string;
  // ── Sync con Google Calendar (F-gcal, v1). Todos OPCIONALES → no rompen eventos existentes. ──
  googleEventId?: string; // id del evento en Google (relación evento↔Google; derivado del _id, ver diseño)
  googleSyncStatus?: 'pending' | 'synced' | 'error' | 'skipped' | 'deleting' | 'deleted';
  googleSyncError?: string; // último error de sync de ESTE evento
  googleLastSyncedAt?: Date;
  // ── Bidireccional (Google → Bifrost, source:'google'). ──
  googleEtag?: string; // etag del recurso Google (debug + orden de cambios)
  googleICalUid?: string; // iCalUID del evento en Google (debug/dedup de instancias)
  recurringEventId?: string; // si es una instancia de una serie, el id de la serie madre
  googleDeletePending?: boolean; // tombstone de borrado bidireccional aún sin confirmar en Google
  createdAt: Date;
  updatedAt: Date;
}

// Subdocumento opcional: address sólo es requerido si se provee un organizer.
// (Antes era un path anidado con `address` required, que rompía la creación de
// eventos sin organizer con un 500 de validación.)
const OrganizerSchema = new Schema(
  {
    name: { type: String },
    address: { type: String, required: true },
  },
  { _id: false }
);

const CalendarEventSchema = new Schema<ICalendarEvent>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, required: true, index: true },
    calendarId: { type: String, required: true },
    calendarName: { type: String, required: true },
    calendarColor: { type: String },
    uid: { type: String, required: true },
    summary: { type: String, required: true, maxlength: 1024 },
    description: { type: String, maxlength: 8192 },
    location: { type: String, maxlength: 1024 },
    startDate: { type: Date, required: true },
    startTimezone: { type: String, default: 'UTC' },
    endDate: { type: Date, required: true },
    endTimezone: { type: String, default: 'UTC' },
    allDay: { type: Boolean, default: false },
    recurrenceRule: { type: String },
    recurrenceExceptions: [{ type: String }],
    organizer: { type: OrganizerSchema },
    attendees: [{ name: String, email: String, status: String, role: String }],
    inviteStatus: { type: String },
    status: { type: String, enum: ['confirmed', 'tentative', 'cancelled'], default: 'confirmed' },
    sourceEmailId: { type: Schema.Types.ObjectId },
    // Aditivos para la agenda (no rompen eventos existentes: opcionales, default 'manual').
    source: { type: String, enum: ['manual', 'booking', 'google'], default: 'manual' },
    bookingId: { type: Schema.Types.ObjectId },
    meetRoomId: { type: Schema.Types.ObjectId },
    meetUrl: { type: String, maxlength: 2048 },
    // Sync con Google Calendar (F-gcal). `googleEventId` indexado sparse para lookups por id de Google.
    googleEventId: { type: String, index: { sparse: true } },
    googleSyncStatus: {
      type: String,
      enum: ['pending', 'synced', 'error', 'skipped', 'deleting', 'deleted'],
    },
    googleSyncError: { type: String },
    googleLastSyncedAt: { type: Date },
    // Bidireccional (source:'google').
    googleEtag: { type: String },
    googleICalUid: { type: String },
    recurringEventId: { type: String },
    googleDeletePending: { type: Boolean },
  },
  { timestamps: true }
);

CalendarEventSchema.index({ userId: 1, startDate: 1 });
// Solapamiento de rango: la query usa startDate<=end Y endDate>=start. Con sólo {userId,startDate}
// el planner filtra endDate como residual (escanea histórico). Este índice por endDate deja que el
// planner elija el bound más selectivo (eventos que terminan tras el inicio de la ventana) — review B.
CalendarEventSchema.index({ userId: 1, endDate: 1 });
CalendarEventSchema.index({ accountId: 1, calendarId: 1, uid: 1 }, { unique: true });
// Soporta el backstop del reconciler (F-gcal): busca eventos "atascados" de usuarios CONECTADOS por
// estado + antigüedad (userId ∈ {conectados} AND googleSyncStatus ∈ {pending,error,deleting} AND
// updatedAt < cutoff) cada 2 min. `userId` va PRIMERO porque la query filtra por él: con el prefijo
// {googleSyncStatus,updatedAt} el planner elegía `userId_1` y hacía un FETCH-scan (review D-HIGH, medido
// con explain). Con userId de prefijo el scan es de keys mínimo. PARCIAL (partialFilterExpression
// $exists): NO indexa los eventos sin googleSyncStatus (los que nunca tocaron Google) → sin entradas
// null que inflen el índice ni penalicen escrituras ajenas a gcal. La query filtra por valores presentes.
CalendarEventSchema.index(
  { userId: 1, googleSyncStatus: 1, updatedAt: 1 },
  { partialFilterExpression: { googleSyncStatus: { $exists: true } } }
);
// Bidireccional: upsert idempotente del import por dueño+id de Google. PARCIAL a source:'google' (sólo los
// importados) → índice chico + aislamiento por userId (review B-HIGH: no reusar {accountId,calendarId,uid}).
// UNIQUE (review B-MED): si el lock por-usuario del poller expira a mitad de un full largo y otro worker
// arranca, el upsert concurrente NO puede duplicar el import (E11000 en vez de doc doble); converge.
CalendarEventSchema.index(
  { userId: 1, googleEventId: 1 },
  { unique: true, partialFilterExpression: { source: 'google' } }
);

export function serializeCalendarEvent(doc: ICalendarEvent): CalendarEventDto {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    accountId: doc.accountId.toString(),
    calendarId: doc.calendarId,
    calendarName: doc.calendarName,
    calendarColor: doc.calendarColor,
    uid: doc.uid,
    summary: doc.summary,
    description: doc.description,
    location: doc.location,
    startDate: doc.startDate.toISOString(),
    startTimezone: doc.startTimezone,
    endDate: doc.endDate.toISOString(),
    endTimezone: doc.endTimezone,
    allDay: doc.allDay,
    recurrenceRule: doc.recurrenceRule,
    recurrenceExceptions: doc.recurrenceExceptions,
    organizer: doc.organizer,
    attendees: doc.attendees?.map((a) => ({
      name: a.name,
      email: a.email,
      status: a.status as 'needs-action' | 'accepted' | 'declined' | 'tentative',
      role: a.role as 'chair' | 'required' | 'optional',
    })),
    inviteStatus: doc.inviteStatus as CalendarEventDto['inviteStatus'],
    status: doc.status,
    sourceEmailId: doc.sourceEmailId?.toString(),
    source: doc.source,
    bookingId: doc.bookingId?.toString(),
    meetRoomId: doc.meetRoomId?.toString(),
    meetUrl: doc.meetUrl,
    // Estado de sync con Google (para que la UI muestre badge/errores). NO expone tokens.
    googleSyncStatus: doc.googleSyncStatus,
    googleSyncError: doc.googleSyncError,
    googleLastSyncedAt: doc.googleLastSyncedAt ? doc.googleLastSyncedAt.toISOString() : undefined,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const CalendarEvent = mongoose.model<ICalendarEvent>('CalendarEvent', CalendarEventSchema);
