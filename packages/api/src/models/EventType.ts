import mongoose, { Schema, type Document } from 'mongoose';
import type { EventType as EventTypeDto, MeetingLocation, CustomQuestion } from '@webmail6/shared';

/**
 * Tipo de reunión publicable (event type, plantilla con su propio enlace público).
 * Owner-bound por `userId`. `slug` único por usuario. `DELETE` es SOFT (active:false) — review C-M7.
 */
export interface IEventType extends Document {
  userId: mongoose.Types.ObjectId;
  slug: string;
  title: string;
  description?: string;
  durationMinutes: number;
  color?: string;
  location: MeetingLocation;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minimumNoticeMin: number;
  dateRangeDays: number;
  slotIncrementMin?: number;
  dailyLimit?: number;
  availabilityScheduleId: mongoose.Types.ObjectId;
  cancellationPolicyText?: string;
  reschedulePolicyText?: string;
  cancelMinNoticeMin?: number;
  customQuestions: CustomQuestion[];
  active: boolean;
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

const QuestionSchema = new Schema<CustomQuestion>(
  {
    id: { type: String, required: true },
    label: { type: String, required: true, maxlength: 256 },
    type: { type: String, enum: ['text', 'textarea', 'phone'], required: true },
    required: { type: Boolean, default: false },
  },
  { _id: false }
);

const EventTypeSchema = new Schema<IEventType>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    slug: { type: String, required: true, maxlength: 64 },
    title: { type: String, required: true, maxlength: 200 },
    description: { type: String, maxlength: 4096 },
    durationMinutes: { type: Number, required: true, min: 5, max: 1440 },
    color: { type: String, maxlength: 32 },
    location: { type: LocationSchema, required: true },
    bufferBeforeMin: { type: Number, default: 0, min: 0, max: 1440 },
    bufferAfterMin: { type: Number, default: 0, min: 0, max: 1440 },
    minimumNoticeMin: { type: Number, default: 0, min: 0 },
    dateRangeDays: { type: Number, default: 60, min: 1, max: 365 },
    slotIncrementMin: { type: Number, min: 1, max: 1440 },
    dailyLimit: { type: Number, min: 0 },
    availabilityScheduleId: { type: Schema.Types.ObjectId, required: true },
    cancellationPolicyText: { type: String, maxlength: 2048 },
    reschedulePolicyText: { type: String, maxlength: 2048 },
    cancelMinNoticeMin: { type: Number, min: 0 },
    customQuestions: { type: [QuestionSchema], default: [] },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

// slug único POR usuario (no global): dos hosts pueden tener ambos "30min".
EventTypeSchema.index({ userId: 1, slug: 1 }, { unique: true });

export function serializeEventType(doc: IEventType): EventTypeDto {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    slug: doc.slug,
    title: doc.title,
    description: doc.description,
    durationMinutes: doc.durationMinutes,
    color: doc.color,
    location: { type: doc.location.type, value: doc.location.value },
    bufferBeforeMin: doc.bufferBeforeMin,
    bufferAfterMin: doc.bufferAfterMin,
    minimumNoticeMin: doc.minimumNoticeMin,
    dateRangeDays: doc.dateRangeDays,
    slotIncrementMin: doc.slotIncrementMin,
    dailyLimit: doc.dailyLimit,
    availabilityScheduleId: doc.availabilityScheduleId.toString(),
    cancellationPolicyText: doc.cancellationPolicyText,
    reschedulePolicyText: doc.reschedulePolicyText,
    cancelMinNoticeMin: doc.cancelMinNoticeMin,
    customQuestions: doc.customQuestions.map((q) => ({
      id: q.id,
      label: q.label,
      type: q.type,
      required: q.required,
    })),
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const EventType = mongoose.model<IEventType>('EventType', EventTypeSchema);
