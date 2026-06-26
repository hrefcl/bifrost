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
    summary: { type: String, required: true },
    description: { type: String },
    location: { type: String },
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
  },
  { timestamps: true }
);

CalendarEventSchema.index({ userId: 1, startDate: 1 });
CalendarEventSchema.index({ accountId: 1, calendarId: 1, uid: 1 }, { unique: true });

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
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const CalendarEvent = mongoose.model<ICalendarEvent>('CalendarEvent', CalendarEventSchema);
