import mongoose, { Schema, type Document } from 'mongoose';
import type {
  AvailabilitySchedule as AvailabilityScheduleDto,
  WeeklyRule,
  AvailabilityOverride,
} from '@webmail6/shared';

/**
 * Horario de disponibilidad reutilizable (un host puede tener varios; uno `isDefault`). Owner-bound.
 * `weeklyRules[].weekday`: 0=Domingo … 6=Sábado. `overrides[].intervals:[]` = no disponible ese día
 * (vacación/festivo); con intervalos = REEMPLAZA la regla semanal de esa fecha (review C-M10).
 */
export interface IAvailabilitySchedule extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  timezone: string;
  weeklyRules: WeeklyRule[];
  overrides: AvailabilityOverride[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/; // 00:00..23:59 (el fin-de-día 24:00 lo normaliza el motor 3.2)
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
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

AvailabilityScheduleSchema.index({ userId: 1, isDefault: 1 });
// A LO SUMO UN horario default por usuario (invariante de integridad — review B-MED): índice único
// PARCIAL sobre los docs con isDefault:true. Al cambiar el default, el servicio (3.3) debe desmarcar
// el anterior en la misma operación; el índice impide que queden dos defaults a la vez.
AvailabilityScheduleSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true },
    // Nombre explícito: el auto-generado sería `userId_1` y chocaría con el índice del campo userId.
    name: 'uniq_default_schedule_per_user',
  }
);

export function serializeAvailabilitySchedule(doc: IAvailabilitySchedule): AvailabilityScheduleDto {
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
    isDefault: doc.isDefault,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const AvailabilitySchedule = mongoose.model<IAvailabilitySchedule>(
  'AvailabilitySchedule',
  AvailabilityScheduleSchema
);
