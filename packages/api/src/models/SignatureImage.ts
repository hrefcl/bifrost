import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Imagen de firma externalizada: cuando el usuario pega una firma con imágenes `data:` (base64), las
 * subimos acá y reemplazamos el `data:` por una URL pública (los clientes de correo, p.ej. Gmail,
 * BLOQUEAN imágenes data: en correos recibidos). Igual que hace Gmail al pegar una firma. Los bytes
 * viven en Mongo (imágenes chicas, acotadas por tamaño); se sirven sin auth por /api/signature-images.
 */
export interface ISignatureImage extends Document {
  userId: mongoose.Types.ObjectId;
  contentType: string;
  hash: string;
  data: Buffer;
  size: number;
  createdAt: Date;
}

const SignatureImageSchema = new Schema<ISignatureImage>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    contentType: { type: String, required: true },
    hash: { type: String, required: true },
    data: { type: Buffer, required: true },
    size: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Dedup: la misma imagen (mismo contenido) de un usuario se reutiliza en vez de duplicarse.
SignatureImageSchema.index({ userId: 1, hash: 1 }, { unique: true });

export const SignatureImage = mongoose.model<ISignatureImage>(
  'SignatureImage',
  SignatureImageSchema
);
