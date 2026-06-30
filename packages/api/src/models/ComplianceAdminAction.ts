import mongoose, { Schema, type Document, type Types } from 'mongoose';

export type ComplianceAdminActionType =
  | 'create_document'
  | 'update_document'
  | 'delete_document'
  | 'create_version'
  | 'update_version'
  | 'publish'
  | 'export_acceptances'
  | 'toggle_kill_switch';

/**
 * `ComplianceAdminAction` — auditoría durable de acciones admin (DESIGN v4 §2.5, C-M8 / D-028).
 *
 * Append-only. Registra el gobierno del propio framework: quién cambió enforcement, publicó,
 * exportó evidencia o activó el kill-switch, y cuándo. Distinto del documento `audit-policy`
 * (que se MUESTRA a usuarios); esto es el log operativo consultable del framework.
 */
export interface IComplianceAdminAction extends Document {
  tenantId: string;
  actorId?: Types.ObjectId | null;
  actorEmail: string;
  action: ComplianceAdminActionType;
  targetType: string;
  targetId?: Types.ObjectId | null;
  documentKey: string;
  before?: unknown;
  after?: unknown;
  ip: string;
  at: Date;
  createdAt: Date;
}

const ComplianceAdminActionSchema = new Schema<IComplianceAdminAction>(
  {
    tenantId: { type: String, required: true, default: 'default', index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorEmail: { type: String, default: '' },
    action: {
      type: String,
      enum: [
        'create_document',
        'update_document',
        'delete_document',
        'create_version',
        'update_version',
        'publish',
        'export_acceptances',
        'toggle_kill_switch',
      ],
      required: true,
    },
    targetType: { type: String, default: '' },
    targetId: { type: Schema.Types.ObjectId, default: null },
    documentKey: { type: String, default: '' },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    ip: { type: String, default: '' },
    at: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ComplianceAdminActionSchema.index({ tenantId: 1, at: -1 });
ComplianceAdminActionSchema.index({ tenantId: 1, documentKey: 1, at: -1 });

export const ComplianceAdminAction = mongoose.model<IComplianceAdminAction>(
  'ComplianceAdminAction',
  ComplianceAdminActionSchema
);
