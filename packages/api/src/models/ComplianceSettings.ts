import mongoose, { Schema, type Document } from 'mongoose';

/**
 * `ComplianceSettings` — config por tenant (DESIGN v4 §2.4).
 *
 * `complianceEpoch` se bumpea ante publish/cambio de metadata y se espeja en Redis
 * (`compliance:epoch:<tenantId>`) para invalidación cross-worker del snapshot del gate.
 */
export interface IComplianceSettings extends Document {
  tenantId: string;
  complianceEpoch: number;
  createdAt: Date;
  updatedAt: Date;
}

const ComplianceSettingsSchema = new Schema<IComplianceSettings>(
  {
    tenantId: { type: String, required: true, unique: true, default: 'default' },
    complianceEpoch: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const ComplianceSettings = mongoose.model<IComplianceSettings>(
  'ComplianceSettings',
  ComplianceSettingsSchema
);
