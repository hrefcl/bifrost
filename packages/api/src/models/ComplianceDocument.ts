import mongoose, { Schema, type Document, type Types } from 'mongoose';

/** Slug del documento (clave estable por tenant). Los `system` se siembran por defecto. */
export type ComplianceEnforcement = 'none' | 'soft' | 'block_partial' | 'block_full';
export type ComplianceAudience = 'all' | 'role:user' | 'role:admin';
export type ComplianceCategory =
  | 'legal'
  | 'privacy'
  | 'security'
  | 'operational'
  | 'cookies'
  | 'custom';

/**
 * `ComplianceDocument` — el "slot" lógico de una política (DESIGN v4 §2.1).
 *
 * Lleva el estado **denormalizado** (current, next y enforced) que permite al gate decidir leyendo
 * SÓLO esta colección (sin populate de versiones). Esa denormalización es una **caché derivada
 * rebuildable**: la fuente de verdad es `ComplianceVersion`; `reconcileComplianceDenorm` la sana.
 */
export interface IComplianceDocument extends Document {
  tenantId: string;
  key: string;
  category: ComplianceCategory;
  title: string;
  enforcement: ComplianceEnforcement;
  audience: ComplianceAudience;
  active: boolean;
  order: number;
  defaultLocale: string;
  system: boolean;
  deletedAt?: Date | null;
  versionCounter: number;
  // ---- denormalizado: versión vigente (current) ----
  currentVersionId?: Types.ObjectId | null;
  currentVersionNumber: number;
  currentContentHash: string;
  currentEffectiveAt?: Date | null;
  currentExpiresAt?: Date | null;
  // ---- denormalizado: última publicada (puede no estar vigente aún) ----
  latestPublishedVersion: number;
  latestPublishedEffectiveAt?: Date | null;
  // Marca temporal del snapshot que produjo el current/next denormalizado. Guard contra recomputes
  // STALE en el tiempo (uno que cruzó el effectiveAt de una versión programada y reanudó tarde no debe
  // pisar un current más reciente). Ver recomputeDenorm (B-reaudit verify MED).
  denormComputedAt?: Date | null;
  // Mayor número de versión PUBLICADA que la denorm ya procesó (current/next/expiró). Permite detectar
  // una denorm STALE — `latestPublishedVersion > denormReflectedVersion` ⇒ se publicó algo que el
  // recompute aún no reflejó (crash entre el status-flip de publishVersion y su recomputeDenorm) — SIN
  // confundirlo con un doc cuya versión vigente ya expiró legítimamente (B-reaudit verify HIGH-3 residual,
  // incl. el bypass de PRIMERA publicación con currentVersionNumber=0).
  denormReflectedVersion: number;
  // ---- denormalizado: umbral de exigencia ----
  enforcedVersion: number;
  enforcedFrom?: Date | null;
  // ---- denormalizado: próxima versión PROGRAMADA (effectiveAt futuro) ----
  nextVersionId?: Types.ObjectId | null;
  nextVersionNumber: number;
  nextEffectiveAt?: Date | null;
  nextContentHash: string;
  nextRequiresReacceptance: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ComplianceDocumentSchema = new Schema<IComplianceDocument>(
  {
    tenantId: { type: String, required: true, default: 'default', index: true },
    key: { type: String, required: true },
    category: {
      type: String,
      enum: ['legal', 'privacy', 'security', 'operational', 'cookies', 'custom'],
      required: true,
    },
    title: { type: String, required: true },
    enforcement: {
      type: String,
      enum: ['none', 'soft', 'block_partial', 'block_full'],
      // Default conservador (DESIGN §5): los seeds nacen 'soft' → nunca bloquean un login existente.
      default: 'soft',
      required: true,
      index: true,
    },
    audience: { type: String, enum: ['all', 'role:user', 'role:admin'], default: 'all' },
    active: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
    defaultLocale: { type: String, default: 'es' },
    system: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    versionCounter: { type: Number, default: 0 },
    currentVersionId: { type: Schema.Types.ObjectId, ref: 'ComplianceVersion', default: null },
    currentVersionNumber: { type: Number, default: 0 },
    currentContentHash: { type: String, default: '' },
    currentEffectiveAt: { type: Date, default: null },
    currentExpiresAt: { type: Date, default: null },
    latestPublishedVersion: { type: Number, default: 0 },
    latestPublishedEffectiveAt: { type: Date, default: null },
    denormComputedAt: { type: Date, default: null },
    denormReflectedVersion: { type: Number, default: 0 },
    enforcedVersion: { type: Number, default: 0 },
    enforcedFrom: { type: Date, default: null },
    nextVersionId: { type: Schema.Types.ObjectId, ref: 'ComplianceVersion', default: null },
    nextVersionNumber: { type: Number, default: 0 },
    nextEffectiveAt: { type: Date, default: null },
    nextContentHash: { type: String, default: '' },
    nextRequiresReacceptance: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Un documento por (tenant, key). El gate filtra por tenantId + active + enforcement.
ComplianceDocumentSchema.index({ tenantId: 1, key: 1 }, { unique: true });
// Para el snapshot del gate: documentos enforced, activos y no soft-deleted de un tenant (D-007).
ComplianceDocumentSchema.index({ tenantId: 1, active: 1, enforcement: 1, deletedAt: 1 });

export const ComplianceDocument = mongoose.model<IComplianceDocument>(
  'ComplianceDocument',
  ComplianceDocumentSchema
);
