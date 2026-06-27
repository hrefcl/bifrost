import mongoose, { Schema, type Document } from 'mongoose';
import type { StorageType } from '../services/storage/index.js';

/**
 * Fuente de verdad de un adjunto subido (no se confía en el `storageKey` que mande el cliente
 * — ver review B/D de PR-B). Cada blob es DUEÑO-bound (`userId`) y PROVIDER-bound
 * (`providerType`): las lecturas van SIEMPRE al provider de origen, aunque el activo cambie.
 *
 * Lifecycle (MARK-AND-SWEEP con LEASE, ver `cleanupOrphanAttachments`):
 *  - `status`: 'active' (adjuntable/legible) | 'deleting' (lease del GC en curso → no adjuntable).
 *  - `lastReferencedAt`: se actualiza al subir y cada vez que se adjunta a un draft. El GC sólo
 *    considera candidatos con lastReferencedAt anterior a la gracia, y vuelve a chequear de forma
 *    ATÓMICA (CAS sobre status+lastReferencedAt) para no borrar un blob recién referenciado.
 * `refCount` queda como metadato informativo; el GC no depende de él.
 */
export interface IAttachmentBlob extends Document {
  storageKey: string;
  providerType: StorageType;
  userId: mongoose.Types.ObjectId;
  filename: string;
  contentType: string;
  size: number;
  refCount: number;
  status: 'active' | 'deleting';
  lastReferencedAt: Date;
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
    status: { type: String, enum: ['active', 'deleting'], default: 'active' },
    lastReferencedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// El GC busca candidatos por (status, lastReferencedAt); índice para que el barrido escale.
AttachmentBlobSchema.index({ status: 1, lastReferencedAt: 1 });

export const AttachmentBlob = mongoose.model<IAttachmentBlob>(
  'AttachmentBlob',
  AttachmentBlobSchema
);
