import mongoose, { Schema, type Document } from 'mongoose';
import type { Group as GroupDto } from '@webmail6/shared';

/**
 * Grupo de cuentas/usuarios a nivel instancia (admin, F7). `name` único; `email` único SÓLO cuando
 * existe (índice parcial). `memberUserIds` referencia User; la unicidad de miembros se garantiza en
 * el router con `$addToSet/$pull` (nunca replace del array → evita lost-update, review C).
 */
export interface IGroup extends Document {
  name: string;
  description?: string;
  color?: string;
  email?: string;
  memberUserIds: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const GroupSchema = new Schema<IGroup>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, maxlength: 500 },
    color: { type: String },
    email: { type: String, lowercase: true, trim: true },
    memberUserIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
  },
  { timestamps: true }
);

GroupSchema.index({ name: 1 }, { unique: true });
// Único SÓLO cuando hay email (índice parcial): grupos sin email no colisionan entre sí.
GroupSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);

/** Serializa filtrando miembros a IDs existentes es responsabilidad del router (defensa al leer). */
export function serializeGroup(doc: IGroup, memberIds?: string[]): GroupDto {
  const members = memberIds ?? doc.memberUserIds.map((id) => id.toString());
  return {
    id: doc._id.toString(),
    name: doc.name,
    description: doc.description,
    color: doc.color,
    email: doc.email,
    memberUserIds: members,
    memberCount: members.length,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const Group = mongoose.model<IGroup>('Group', GroupSchema);
