import mongoose, { Schema, type Document } from 'mongoose';
import type { Address, DraftAttachment } from '@webmail6/shared';

export interface IDraft extends Document {
  userId: mongoose.Types.ObjectId;
  accountId: mongoose.Types.ObjectId;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  attachments: DraftAttachment[];
  replyTo?: {
    emailId?: mongoose.Types.ObjectId;
    messageId?: string;
    references?: string[];
  };
  includeSignature: boolean;
  status: 'editing' | 'sending' | 'sent' | 'failed';
  sentMessageId?: string;
  sentAt?: Date;
  sendingSince?: Date;
  lastModifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AddressSchema = new Schema(
  {
    name: { type: String },
    address: { type: String, required: true },
  },
  { _id: false }
);

const DraftAttachmentSchema = new Schema(
  {
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    storageKey: { type: String, required: true },
  },
  { _id: false }
);

const DraftSchema = new Schema<IDraft>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, required: true, index: true },
    to: { type: [AddressSchema], required: true, default: [] },
    cc: { type: [AddressSchema], default: [] },
    bcc: { type: [AddressSchema], default: [] },
    subject: { type: String, default: '' },
    bodyHtml: { type: String },
    bodyText: { type: String },
    attachments: { type: [DraftAttachmentSchema], default: [] },
    replyTo: {
      emailId: { type: Schema.Types.ObjectId },
      messageId: { type: String },
      references: { type: [String] },
    },
    includeSignature: { type: Boolean, default: true },
    status: { type: String, enum: ['editing', 'sending', 'sent', 'failed'], default: 'editing' },
    sentMessageId: { type: String },
    sentAt: { type: Date },
    sendingSince: { type: Date },
    lastModifiedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

DraftSchema.index({ accountId: 1, lastModifiedAt: -1 });
// NOTA: se eliminó el índice TTL sobre lastModifiedAt (expireAfterSeconds: 2592000).
// Borraba los borradores a los 30 días de inactividad sin aviso (H-DATA-TTL).

export const Draft = mongoose.model<IDraft>('Draft', DraftSchema);
