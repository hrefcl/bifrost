import mongoose, { Schema, type Document } from 'mongoose';
import type { Contact as ContactDto } from '@webmail6/shared';

export interface IContact extends Document {
  userId: mongoose.Types.ObjectId;
  fullName: string;
  sortName: string;
  email: string;
  emails?: { label: string; address: string }[];
  phones?: { label: string; number: string }[];
  organization?: string;
  jobTitle?: string;
  notes?: string;
  isFrequent: boolean;
  usageCount: number;
  source: 'local' | 'imported' | 'carddav';
  createdAt: Date;
  updatedAt: Date;
}

const ContactSchema = new Schema<IContact>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    fullName: { type: String, required: true },
    sortName: { type: String, required: true, index: true },
    email: { type: String, required: true, index: true },
    emails: [{ label: String, address: String }],
    phones: [{ label: String, number: String }],
    organization: { type: String },
    jobTitle: { type: String },
    notes: { type: String },
    isFrequent: { type: Boolean, default: false },
    usageCount: { type: Number, default: 0 },
    source: { type: String, enum: ['local', 'imported', 'carddav'], default: 'local' },
  },
  { timestamps: true }
);

ContactSchema.index({ userId: 1, sortName: 1 });

export function serializeContact(doc: IContact): ContactDto {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    fullName: doc.fullName,
    sortName: doc.sortName,
    email: doc.email,
    emails: doc.emails,
    phones: doc.phones,
    organization: doc.organization,
    jobTitle: doc.jobTitle,
    notes: doc.notes,
    isFrequent: doc.isFrequent,
    usageCount: doc.usageCount,
    source: doc.source,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const Contact = mongoose.model<IContact>('Contact', ContactSchema);
