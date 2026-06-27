import mongoose, { Schema, type Document } from 'mongoose';
import type { StorageType } from '../services/storage/index.js';

/**
 * Fuente de verdad de un adjunto subido (no se confía en el `storageKey` que mande el cliente
 * — ver review B/D de PR-B). Cada blob es DUEÑO-bound (`userId`) y PROVIDER-bound
 * (`providerType`): las lecturas van SIEMPRE al provider de origen, aunque el activo cambie.
 * `refCount` permite que forward reuse el mismo blob; cleanup cuando llega a 0 (PR-H).
 */
export interface IAttachmentBlob extends Document {
  storageKey: string;
  providerType: StorageType;
  userId: mongoose.Types.ObjectId;
  filename: string;
  contentType: string;
  size: number;
  refCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const AttachmentBlobSchema = new Schema<IAttachmentBlob>(
  {
    storageKey: { type: String, required: true },
    providerType: { type: String, enum: ['local', 's3'], required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    refCount: { type: Number, default: 1 },
  },
  { timestamps: true }
);

export const AttachmentBlob = mongoose.model<IAttachmentBlob>(
  'AttachmentBlob',
  AttachmentBlobSchema
);
