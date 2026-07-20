import mongoose, { Schema, type Document } from 'mongoose';
import type { MeetRoomDto, MeetRoomMode, MeetRoomStatus, MeetRoomSource } from '@webmail6/shared';

/**
 * Sala de Bifrost Meet. Owner-bound por `userId`. El `slug` es **ÚNICO GLOBAL** (no por usuario): es
 * el namespace público de los links de unión y no debe ser enumerable ni colisionar entre tenants
 * (review C-H3). Lifecycle SUAVE: `status:'closed'` en vez de hard-delete (no romper links en vuelo,
 * preservar auditoría). La fila es **requerida** para emitir tokens — sin fila no hay autorización
 * posible (review B-H1): el endpoint de token hace 404 si no existe/closed.
 */
export interface IMeetRoom extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  slug: string;
  name: string;
  mode: MeetRoomMode;
  status: MeetRoomStatus;
  source: MeetRoomSource;
  calendarEventId?: mongoose.Types.ObjectId;
  bookingId?: mongoose.Types.ObjectId;
  maxParticipants: number;
  allowExternalOverride?: boolean;
  /** per_event: `endAt + 30m`. La expiración se hace cumplir pasivamente (janitor + empty_timeout). */
  expiresAt?: Date;
  /**
   * Instante desde el que la sala tiene UN SOLO participante (la marca el janitor; `$unset` en cuanto
   * vuelve a haber 2+ o el cliente confirma "sigo acá"). Es el reloj del auto-cierre por inactividad:
   * `empty_timeout` de LiveKit NO cubre este caso porque la sala no está vacía, tiene 1 conectado.
   */
  soloSince?: Date;
  /** GC largo opcional (TTL index): purga la fila mucho después de expirar. */
  purgeAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MeetRoomSchema = new Schema<IMeetRoom>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    slug: { type: String, required: true, maxlength: 64 },
    name: { type: String, required: true, maxlength: 200 },
    mode: { type: String, enum: ['per_event', 'personal'], required: true },
    status: { type: String, enum: ['active', 'closed'], required: true, default: 'active' },
    source: { type: String, enum: ['manual', 'calendar', 'booking'], required: true },
    calendarEventId: { type: Schema.Types.ObjectId },
    bookingId: { type: Schema.Types.ObjectId },
    maxParticipants: { type: Number, required: true, min: 2, max: 1000 },
    allowExternalOverride: { type: Boolean },
    expiresAt: { type: Date },
    purgeAt: { type: Date },
    soloSince: { type: Date },
  },
  { timestamps: true }
);

// slug ÚNICO GLOBAL (namespace público compartido entre tenants).
MeetRoomSchema.index({ slug: 1 }, { unique: true });
// Listado por host (no único).
MeetRoomSchema.index({ userId: 1, status: 1 });
// Idempotencia de salas de booking: un booking ↔ una sala (review: replay no duplica).
MeetRoomSchema.index(
  { bookingId: 1 },
  { unique: true, partialFilterExpression: { bookingId: { $exists: true } } }
);
// ÚNICO parcial: una sola sala por evento de calendario → el create race-safe (el 2º insert concurrente
// lanza duplicate-key y `createCalendarMeetRoom` reusa la sala existente). Review B (HIGH).
MeetRoomSchema.index(
  { calendarEventId: 1 },
  { unique: true, partialFilterExpression: { calendarEventId: { $exists: true } } }
);
// GC largo: TTL sobre purgeAt (NO sobre expiresAt — borrar al expirar mataría links recién terminados).
MeetRoomSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const MeetRoom = mongoose.model<IMeetRoom>('MeetRoom', MeetRoomSchema);

/** Proyecta el doc a DTO. `meetUrl` se construye con la base pública pasada (no se persiste). */
export function serializeMeetRoom(doc: IMeetRoom, publicBaseUrl: string): MeetRoomDto {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    slug: doc.slug,
    name: doc.name,
    mode: doc.mode,
    status: doc.status,
    source: doc.source,
    calendarEventId: doc.calendarEventId?.toString(),
    bookingId: doc.bookingId?.toString(),
    maxParticipants: doc.maxParticipants,
    allowExternalOverride: doc.allowExternalOverride,
    expiresAt: doc.expiresAt?.toISOString(),
    meetUrl: `${publicBaseUrl.replace(/\/+$/, '')}/meet/${doc.slug}`,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
