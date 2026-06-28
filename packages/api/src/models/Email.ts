import mongoose, { Schema, type Document } from 'mongoose';
import type { EmailFlags, Address } from '@webmail6/shared';

export interface IEmail extends Document {
  accountId: mongoose.Types.ObjectId;
  folderId: mongoose.Types.ObjectId;
  uid: number;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  from: Address;
  replyTo?: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  date: Date;
  internalDate: Date;
  size: number;
  preview?: string;
  flags: EmailFlags;
  keywords?: string[];
  hasAttachments: boolean;
  attachmentCount: number;
  modseq?: number;
  bodyCached: boolean;
  bodyCachedAt?: Date;
  /** Pospuesto (snooze, estilo Gmail): oculto de su carpeta hasta esta fecha; null = no pospuesto. */
  snoozedUntil?: Date;
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

const FlagsSchema = new Schema(
  {
    seen: { type: Boolean, default: false },
    answered: { type: Boolean, default: false },
    flagged: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    draft: { type: Boolean, default: false },
  },
  { _id: false }
);

const EmailSchema = new Schema<IEmail>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true, index: true },
    folderId: { type: Schema.Types.ObjectId, required: true, index: true },
    uid: { type: Number, required: true },
    messageId: { type: String, required: true },
    inReplyTo: { type: String },
    references: { type: [String] },
    threadId: { type: String, index: true },
    from: { type: AddressSchema, required: true },
    replyTo: { type: AddressSchema },
    to: { type: [AddressSchema], required: true },
    cc: { type: [AddressSchema] },
    bcc: { type: [AddressSchema] },
    subject: { type: String, default: '' },
    date: { type: Date, required: true, index: true },
    internalDate: { type: Date, required: true },
    size: { type: Number, required: true },
    preview: { type: String },
    flags: { type: FlagsSchema, default: () => ({}) },
    keywords: { type: [String] },
    hasAttachments: { type: Boolean, default: false },
    attachmentCount: { type: Number, default: 0 },
    modseq: { type: Number },
    bodyCached: { type: Boolean, default: false },
    bodyCachedAt: { type: Date },
    snoozedUntil: { type: Date },
  },
  { timestamps: true }
);

// Unicidad por mensaje dentro de un folder (UID es único por-carpeta). Evita
// duplicados en upsert y soporta el filtro de sync.
EmailSchema.index({ accountId: 1, folderId: 1, uid: 1 }, { unique: true });
// Índice ESR principal: Equality → Sort → Range
EmailSchema.index({ accountId: 1, folderId: 1, date: -1, uid: -1 });
EmailSchema.index({ accountId: 1, threadId: 1, date: -1 });
EmailSchema.index({ accountId: 1, 'flags.seen': 1, folderId: 1 });
EmailSchema.index({ accountId: 1, 'from.address': 1, date: -1 });
// Pospuestos: buscar por usuario (cuenta) los que siguen en snooze.
EmailSchema.index({ accountId: 1, snoozedUntil: 1 });
EmailSchema.index(
  { accountId: 1, subject: 'text', preview: 'text', 'from.address': 'text' },
  { weights: { subject: 10, preview: 5, 'from.address': 3 }, name: 'email_text_search' }
);

export const Email = mongoose.model<IEmail>('Email', EmailSchema);
