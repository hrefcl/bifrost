import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Rol custom (F8 RBAC). Otorga un SUBconjunto del catálogo estático de permisos a los usuarios que lo
 * tengan asignado (`User.customRoleId`). `isSystem` marca roles que sólo un admin REAL puede tocar.
 * Los permisos se resuelven LIVE en cada request (nunca se snapshotean en el User) — review C.
 */
export interface IRole extends Document {
  name: string;
  description?: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const RoleSchema = new Schema<IRole>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, maxlength: 300 },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

RoleSchema.index({ name: 1 }, { unique: true });

export interface RoleDto {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export function serializeRole(doc: IRole): RoleDto {
  return {
    id: doc._id.toString(),
    name: doc.name,
    description: doc.description,
    permissions: doc.permissions,
    isSystem: doc.isSystem,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export const Role = mongoose.model<IRole>('Role', RoleSchema);
