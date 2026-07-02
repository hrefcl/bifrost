import mongoose, { Schema, type Document } from 'mongoose';

/**
 * API-key del provisioning máquina-a-máquina (`/api/provision/*`), gestionable desde el panel /admin.
 *
 * SEGURIDAD: se guarda SÓLO el hash SHA-256 del token (nunca el valor en claro), igual que un refresh
 * token. El valor plano se muestra UNA vez al crearla (estándar tipo GitHub PAT/Stripe) → si se pierde,
 * se revoca y se genera otra. `prefix` (primeros chars) es sólo para reconocerla en la lista.
 */
export interface IProvisionApiKey extends Document {
  label: string;
  tokenHash: string;
  prefix: string;
  createdBy: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProvisionApiKeySchema = new Schema<IProvisionApiKey>(
  {
    label: { type: String, required: true, trim: true, maxlength: 120 },
    // Único: dos keys distintas no pueden colisionar de hash (imposible en la práctica, pero lo blinda).
    tokenHash: { type: String, required: true, unique: true },
    prefix: { type: String, required: true },
    createdBy: { type: String, required: true },
    lastUsedAt: { type: Date, default: null },
    // Revocación = soft-delete: se conserva el registro (auditoría) pero deja de autenticar.
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const ProvisionApiKey = mongoose.model<IProvisionApiKey>(
  'ProvisionApiKey',
  ProvisionApiKeySchema
);
