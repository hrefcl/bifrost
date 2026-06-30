import mongoose, { Schema, type Document } from 'mongoose';
import type {
  AvailabilitySchedule as AvailabilityScheduleDto,
  WeeklyRule,
  AvailabilityOverride,
} from '@webmail6/shared';

/**
 * Horario de disponibilidad reutilizable (un host puede tener varios). Owner-bound.
 * `weeklyRules[].weekday`: 0=Domingo … 6=Sábado. `overrides[].intervals:[]` = no disponible ese día
 * (vacación/festivo); con intervalos = REEMPLAZA la regla semanal de esa fecha (review C-M10).
 *
 * EL DEFAULT NO se guarda aquí (review B): vive como puntero `User.defaultScheduleId`, para que
 * "fijar el default" sea un update ATÓMICO de un solo documento (Mongo single-node, sin transacciones)
 * — sin la ventana de "cero defaults" del patrón boolean+clear-then-set. `isDefault` del DTO se computa
 * comparando con ese puntero.
 */
export interface IAvailabilitySchedule extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  timezone: string;
  weeklyRules: WeeklyRule[];
  overrides: AvailabilityOverride[];
  createdAt: Date;
  updatedAt: Date;
}

// 00:00..23:59 y además "24:00" como FIN-de-día (el motor 3.2 lo normaliza a 00:00 del día siguiente).
// La capa de servicio (3.3) valida que sólo el END use 24:00 y que end>start.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const IntervalSchema = new Schema(
  {
    // Validación de formato en el schema (review D): "HH:MM" 00:00..23:59. end>start lo valida la
    // capa de servicio (3.3) porque cruza dos campos del subdoc.
    start: { type: String, required: true, match: HHMM },
    end: { type: String, required: true, match: HHMM },
  },
  { _id: false }
);

const WeeklyRuleSchema = new Schema<WeeklyRule>(
  {
    weekday: { type: Number, required: true, min: 0, max: 6 },
    intervals: { type: [IntervalSchema], default: [] },
  },
  { _id: false }
);

const OverrideSchema = new Schema<AvailabilityOverride>(
  {
    date: { type: String, required: true, match: YMD }, // "YYYY-MM-DD"
    intervals: { type: [IntervalSchema], default: [] },
    note: { type: String, maxlength: 256 },
  },
  { _id: false }
);

const AvailabilityScheduleSchema = new Schema<IAvailabilitySchedule>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, maxlength: 120 },
    timezone: { type: String, required: true },
    weeklyRules: { type: [WeeklyRuleSchema], default: [] },
    overrides: { type: [OverrideSchema], default: [] },
  },
  { timestamps: true }
);

/** `isDefault` se computa contra `User.defaultScheduleId` (no se guarda en el doc) — review B. */
export function serializeAvailabilitySchedule(
  doc: IAvailabilitySchedule,
  isDefault = false
): AvailabilityScheduleDto {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    name: doc.name,
    timezone: doc.timezone,
    weeklyRules: doc.weeklyRules.map((r) => ({
      weekday: r.weekday,
      intervals: r.intervals.map((i) => ({ start: i.start, end: i.end })),
    })),
    overrides: doc.overrides.map((o) => ({
      date: o.date,
      intervals: o.intervals.map((i) => ({ start: i.start, end: i.end })),
      note: o.note,
    })),
    isDefault,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const AvailabilitySchedule = mongoose.model<IAvailabilitySchedule>(
  'AvailabilitySchedule',
  AvailabilityScheduleSchema
);
