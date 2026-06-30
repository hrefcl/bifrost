import mongoose, { Schema, type Document } from 'mongoose';
import type {
  Booking as BookingDto,
  BookingInvitee,
  BookingAnswer,
  BookingSnapshot,
  BookingStatus,
  MeetingLocation,
} from '@webmail6/shared';

/**
 * Reserva (booking). FUENTE DE VERDAD del sistema (review B/C: el CalendarEvent es proyección
 * reparable). Campos SERVER-ONLY (no salen en el DTO): `managementTokenHash`, `idempotencyKeyHash`,
 * `icsUid`, `pendingReschedule`.
 *
 * Garantías de integridad ancladas en índices (review B/C/D, Fase 3.4 los explota):
 *  - `{userId, eventTypeId, idempotencyKeyHash}` único parcial → idempotencia DURABLE del POST /book (B-HIGH v3.2).
 *  - `{userId, startAt}` único parcial sobre confirmed → backstop anti-doble-booking exacto (defensa
 *    en profundidad; la garantía primaria es el lock + re-validación). El overlap general lo cubre 3.4.
 *  - `{managementTokenHash}` único parcial → lookup O(1) de la página de gestión (token hasheado).
 */
export interface IBooking extends Document {
  eventTypeId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  snapshot: BookingSnapshot;
  startAt: Date;
  endAt: Date;
  invitee: BookingInvitee;
  answers: BookingAnswer[];
  status: BookingStatus;
  cancelReason?: string;
  cancelledBy?: 'invitee' | 'host';
  calendarEventId?: mongoose.Types.ObjectId;
  rescheduledFromId?: mongoose.Types.ObjectId;
  rescheduledToId?: mongoose.Types.ObjectId;
  source: 'public' | 'host' | 'api';
  // server-only
  managementTokenHash: string;
  idempotencyKeyHash?: string;
  icsUid: string;
  pendingReschedule?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const LocationSchema = new Schema<MeetingLocation>(
  {
    type: { type: String, enum: ['in_person', 'phone', 'video', 'custom'], required: true },
    value: { type: String, maxlength: 2048 },
  },
  { _id: false }
);

const SnapshotSchema = new Schema<BookingSnapshot>(
  {
    timezone: { type: String, required: true },
    durationMinutes: { type: Number, required: true },
    bufferBeforeMin: { type: Number, required: true },
    bufferAfterMin: { type: Number, required: true },
    minimumNoticeMin: { type: Number, required: true },
    title: { type: String, required: true, maxlength: 200 },
    location: { type: LocationSchema, required: true },
  },
  { _id: false }
);

const InviteeSchema = new Schema<BookingInvitee>(
  {
    name: { type: String, required: true, maxlength: 200 },
    email: { type: String, required: true, maxlength: 320 },
    timezone: { type: String, required: true },
    phone: { type: String, maxlength: 64 },
  },
  { _id: false }
);

const AnswerSchema = new Schema<BookingAnswer>(
  {
    questionId: { type: String, required: true },
    label: { type: String, required: true, maxlength: 256 },
    answer: { type: String, required: true, maxlength: 4096 },
  },
  { _id: false }
);

const BookingSchema = new Schema<IBooking>(
  {
    eventTypeId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    snapshot: { type: SnapshotSchema, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    invitee: { type: InviteeSchema, required: true },
    answers: { type: [AnswerSchema], default: [] },
    status: {
      type: String,
      enum: ['confirmed', 'cancelled', 'rescheduled'],
      default: 'confirmed',
    },
    cancelReason: { type: String, maxlength: 1024 },
    cancelledBy: { type: String, enum: ['invitee', 'host'] },
    calendarEventId: { type: Schema.Types.ObjectId },
    rescheduledFromId: { type: Schema.Types.ObjectId },
    rescheduledToId: { type: Schema.Types.ObjectId },
    source: { type: String, enum: ['public', 'host', 'api'], default: 'public' },
    managementTokenHash: { type: String, required: true },
    idempotencyKeyHash: { type: String },
    icsUid: { type: String, required: true },
    pendingReschedule: { type: Boolean },
  },
  { timestamps: true }
);

// Invariante temporal: el fin debe ser posterior al inicio (review D — evita estados imposibles).
BookingSchema.pre('validate', function (next) {
  // `instanceof Date`: en pre('validate') las fechas pueden faltar todavía (la validación de
  // `required` corre después); si faltan, que la atrape `required`, no un TypeError aquí.
  if (
    this.startAt instanceof Date &&
    this.endAt instanceof Date &&
    this.endAt.getTime() <= this.startAt.getTime()
  ) {
    next(new Error('Booking.endAt must be after startAt'));
    return;
  }
  next();
});

// Idempotencia DURABLE del POST /book (review B-HIGH v3.2): la misma Idempotency-Key del cliente,
// scopeada por host + eventType, no puede crear dos reservas. Parcial: sólo aplica cuando hay key.
// (Incluye eventTypeId para coincidir con el contrato del diseño v3 — review B/D LOW de Fase 3.1.)
BookingSchema.index(
  { userId: 1, eventTypeId: 1, idempotencyKeyHash: 1 },
  { unique: true, partialFilterExpression: { idempotencyKeyHash: { $type: 'string' } } }
);
// Backstop anti-doble-booking de inicio EXACTO (defensa en profundidad). Parcial: sólo confirmadas
// bloquean el slot; cancelled/rescheduled lo liberan.
BookingSchema.index(
  { userId: 1, startAt: 1 },
  { unique: true, partialFilterExpression: { status: 'confirmed' } }
);
// Lookup de la página de gestión por token hasheado (review B/D: token no se guarda en claro).
BookingSchema.index(
  { managementTokenHash: 1 },
  { unique: true, partialFilterExpression: { managementTokenHash: { $type: 'string' } } }
);
// Listado del host (próximas/pasadas por estado) y overlap eficiente por fin (análogo a CalendarEvent).
BookingSchema.index({ userId: 1, status: 1, startAt: 1 });
BookingSchema.index({ userId: 1, endAt: 1 });
BookingSchema.index({ eventTypeId: 1, startAt: 1 });

export function serializeBooking(doc: IBooking): BookingDto {
  return {
    id: doc._id.toString(),
    eventTypeId: doc.eventTypeId.toString(),
    userId: doc.userId.toString(),
    snapshot: {
      timezone: doc.snapshot.timezone,
      durationMinutes: doc.snapshot.durationMinutes,
      bufferBeforeMin: doc.snapshot.bufferBeforeMin,
      bufferAfterMin: doc.snapshot.bufferAfterMin,
      minimumNoticeMin: doc.snapshot.minimumNoticeMin,
      title: doc.snapshot.title,
      location: { type: doc.snapshot.location.type, value: doc.snapshot.location.value },
    },
    startAt: doc.startAt.toISOString(),
    endAt: doc.endAt.toISOString(),
    invitee: {
      name: doc.invitee.name,
      email: doc.invitee.email,
      timezone: doc.invitee.timezone,
      phone: doc.invitee.phone,
    },
    answers: doc.answers.map((a) => ({
      questionId: a.questionId,
      label: a.label,
      answer: a.answer,
    })),
    status: doc.status,
    cancelReason: doc.cancelReason,
    cancelledBy: doc.cancelledBy,
    calendarEventId: doc.calendarEventId?.toString(),
    rescheduledFromId: doc.rescheduledFromId?.toString(),
    rescheduledToId: doc.rescheduledToId?.toString(),
    source: doc.source,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const Booking = mongoose.model<IBooking>('Booking', BookingSchema);
