import mongoose, { Schema, type Document } from 'mongoose';
import type { Address } from '@webmail6/shared';

/**
 * Snapshot INTERNO de un adjunto del draft (lo que persiste Mongo). Además de la metadata
 * pública lleva los localizadores de storage (storageKey + providerType) que el envío usa
 * para leer del provider de ORIGEN. El DTO público (serializeDraft) NO expone estos campos.
 */
export interface StoredDraftAttachment {
  blobId: string;
  filename: string;
  contentType: string;
  size: number;
  storageKey: string;
  providerType: 'local' | 's3';
}

export interface IDraft extends Document {
  userId: mongoose.Types.ObjectId;
  accountId: mongoose.Types.ObjectId;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  attachments: StoredDraftAttachment[];
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
    // Referencia al AttachmentBlob de origen (se devuelve al cliente como blobId).
    blobId: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    storageKey: { type: String, required: true },
    // PROVIDER-bound: se lee del provider de origen aunque el activo cambie (storage §6.bis-C).
    providerType: { type: String, enum: ['local', 's3'], required: true },
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
// El GC de adjuntos consulta qué blobs siguen referenciados (distinct/exists sobre blobId).
DraftSchema.index({ 'attachments.blobId': 1 });
// NOTA: se eliminó el índice TTL sobre lastModifiedAt (expireAfterSeconds: 2592000).
// Borraba los borradores a los 30 días de inactividad sin aviso (H-DATA-TTL).

export const Draft = mongoose.model<IDraft>('Draft', DraftSchema);
