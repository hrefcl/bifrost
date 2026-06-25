import mongoose, { Schema, type Document } from 'mongoose';
import type { SpecialUse } from '@webmail6/shared';

export interface IFolder extends Document {
  accountId: mongoose.Types.ObjectId;
  name: string;
  path: string;
  delimiter: string;
  displayName: string;
  parentPath?: string;
  flags: string[];
  specialUse?: SpecialUse;
  uidValidity: number;
  uidNext: number;
  totalMessages: number;
  unseenMessages: number;
  subscribed: boolean;
  sortOrder: number;
  expanded: boolean;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const FolderSchema = new Schema<IFolder>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    path: { type: String, required: true },
    delimiter: { type: String, required: true, default: '/' },
    displayName: { type: String, required: true },
    parentPath: { type: String },
    flags: { type: [String], default: [] },
    specialUse: { type: String, enum: ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive'] },
    uidValidity: { type: Number, required: true },
    uidNext: { type: Number, required: true, default: 1 },
    totalMessages: { type: Number, default: 0 },
    unseenMessages: { type: Number, default: 0 },
    subscribed: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    expanded: { type: Boolean, default: true },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

FolderSchema.index({ accountId: 1, path: 1 }, { unique: true });
FolderSchema.index({ accountId: 1, sortOrder: 1 });
FolderSchema.index({ accountId: 1, specialUse: 1 }, { unique: true, sparse: true });

export const Folder = mongoose.model<IFolder>('Folder', FolderSchema);
