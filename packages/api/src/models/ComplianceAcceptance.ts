import mongoose, { Schema, type Document, type Types } from 'mongoose';

export type ComplianceAcceptanceMethod = 'explicit_click' | 'scroll_confirmed';

/**
 * `ComplianceAcceptance` — evidencia legal **append-only** (DESIGN v4 §2.3).
 *
 * Sin rutas UPDATE/DELETE. Idempotente por índice único `(tenantId,userId,documentId,version)`:
 * un doble POST choca E11000 y se trata como éxito. `evidenceHmac` (HMAC-SHA256 con clave dedicada
 * versionada por `hmacKeyId`) la hace tamper-evident y verificable años después.
 */
export interface IComplianceAcceptance extends Document {
  tenantId: string;
  userId: Types.ObjectId;
  userEmail: string;
  documentId: Types.ObjectId;
  documentKey: string;
  versionId: Types.ObjectId;
  version: number;
  contentHash: string;
  acceptedAt: Date;
  ip: string;
  userAgent: string;
  locale: string;
  method: ComplianceAcceptanceMethod;
  hmacKeyId: string;
  evidenceHmac: string;
  createdAt: Date;
}

const ComplianceAcceptanceSchema = new Schema<IComplianceAcceptance>(
  {
    tenantId: { type: String, required: true, default: 'default' },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userEmail: { type: String, required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'ComplianceDocument', required: true },
    documentKey: { type: String, required: true },
    versionId: { type: Schema.Types.ObjectId, ref: 'ComplianceVersion', required: true },
    version: { type: Number, required: true },
    contentHash: { type: String, required: true },
    acceptedAt: { type: Date, required: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    locale: { type: String, default: '' },
    method: {
      type: String,
      enum: ['explicit_click', 'scroll_confirmed'],
      default: 'explicit_click',
    },
    hmacKeyId: { type: String, required: true },
    evidenceHmac: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Idempotencia: una aceptación por (tenant, user, documento, versión).
ComplianceAcceptanceSchema.index(
  { tenantId: 1, userId: 1, documentId: 1, version: 1 },
  { unique: true }
);
// Historial/consulta por usuario (DESIGN §2.3). El compuesto de abajo lo cubre como prefijo, pero
// se declara explícito por fidelidad al esquema documentado (D-008).
ComplianceAcceptanceSchema.index({ tenantId: 1, userId: 1 });
// Gate: ¿el user aceptó una versión >= enforcedVersion de este documento?
ComplianceAcceptanceSchema.index({ tenantId: 1, userId: 1, documentKey: 1, version: 1 });
// Auditoría/cobertura por documento+versión.
ComplianceAcceptanceSchema.index({ tenantId: 1, documentKey: 1, version: 1 });

export const ComplianceAcceptance = mongoose.model<IComplianceAcceptance>(
  'ComplianceAcceptance',
  ComplianceAcceptanceSchema
);
