import mongoose, { Schema, type Document } from 'mongoose';
import type { UserPreferences } from '@webmail6/shared';

export interface IUser extends Document {
  primaryEmail: string;
  displayName: string;
  avatarUrl?: string;
  preferences: UserPreferences;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

const UserSchema = new Schema<IUser>(
  {
    primaryEmail: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    avatarUrl: { type: String },
    preferences: {
      language: { type: String, default: 'es' },
      timezone: { type: String, default: 'America/Mexico_City' },
      timeFormat: { type: String, enum: ['12h', '24h'], default: '24h' },
      theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
      density: {
        type: String,
        enum: ['compact', 'comfortable', 'spacious'],
        default: 'comfortable',
      },
      pageSize: { type: Number, default: 50, min: 10, max: 200 },
      layout: { type: String, enum: ['three-pane', 'list-only'], default: 'three-pane' },
      enableThreading: { type: Boolean, default: true },
      showPreview: { type: Boolean, default: true },
      keyboardShortcutSet: { type: String, enum: ['gmail', 'outlook'], default: 'gmail' },
      composeFormat: { type: String, enum: ['html', 'text'], default: 'html' },
      defaultSignature: { type: String },
      autoIncludeSignature: { type: Boolean, default: true },
      notifications: {
        desktopEnabled: { type: Boolean, default: true },
        soundEnabled: { type: Boolean, default: false },
        notifyOnlyContacts: { type: Boolean, default: false },
      },
      security: {
        confirmExternalLinks: { type: Boolean, default: true },
        autoLoadImages: { type: Boolean, default: false },
        blockRemoteContentUnknown: { type: Boolean, default: true },
      },
    },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

// NOTA: se eliminó el índice TTL sobre createdAt (expireAfterSeconds: 63072000).
// Borraba TODOS los usuarios a los 2 años de creados sin considerar actividad
// (createdAt nunca cambia) → pérdida de datos catastrófica (H-DATA-TTL). La
// retención, si se necesitara, debe ser una política explícita opt-in.

export const User = mongoose.model<IUser>('User', UserSchema);
