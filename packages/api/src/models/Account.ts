import mongoose, { Schema, type Document } from 'mongoose';
import type { ImapConfig, SmtpConfig, CaldavConfig, AccountStatus } from '@webmail6/shared';
import { encrypt, decrypt } from '../config/crypto.js';

export interface IAccount extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  email: string;
  isPrimary: boolean;
  imap: ImapConfig & { authCredentialsEncrypted: ReturnType<typeof encrypt> };
  smtp: SmtpConfig & { authCredentialsEncrypted: ReturnType<typeof encrypt> };
  caldav?: CaldavConfig & { passwordEncrypted: ReturnType<typeof encrypt> };
  status: AccountStatus;
  lastError?: string;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;

  setImapCredentials(plain: string): void;
  getImapCredentials(): string;
  setSmtpCredentials(plain: string): void;
  getSmtpCredentials(): string;
}

const EncryptedFieldSchema = new Schema(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
  },
  { _id: false }
);

const ImapConfigSchema = new Schema(
  {
    host: { type: String, required: true },
    port: { type: Number, required: true },
    secure: { type: Boolean, required: true },
    authMethod: { type: String, enum: ['password', 'oauth2'], required: true },
    authUser: { type: String, required: true },
    authCredentialsEncrypted: { type: EncryptedFieldSchema, required: true },
    compress: { type: Boolean, default: false },
    capabilities: { type: [String] },
    hasCondstore: { type: Boolean },
    hasQresync: { type: Boolean },
    hasIdle: { type: Boolean },
    preferredProtocol: { type: String, enum: ['imap', 'jmap'], default: 'imap' },
  },
  { _id: false }
);

const SmtpConfigSchema = new Schema(
  {
    host: { type: String, required: true },
    port: { type: Number, required: true },
    secure: { type: Boolean, required: true },
    authMethod: { type: String, enum: ['password', 'oauth2'], required: true },
    authUser: { type: String, required: true },
    authCredentialsEncrypted: { type: EncryptedFieldSchema, required: true },
  },
  { _id: false }
);

const CaldavConfigSchema = new Schema(
  {
    baseUrl: { type: String, required: true },
    username: { type: String, required: true },
    passwordEncrypted: { type: EncryptedFieldSchema, required: true },
  },
  { _id: false }
);

const AccountSchema = new Schema<IAccount>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    isPrimary: { type: Boolean, default: false },
    imap: { type: ImapConfigSchema, required: true },
    smtp: { type: SmtpConfigSchema, required: true },
    caldav: { type: CaldavConfigSchema },
    status: { type: String, enum: ['active', 'syncing', 'error', 'disabled'], default: 'active' },
    lastError: { type: String },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

AccountSchema.index({ userId: 1, isPrimary: -1 });
AccountSchema.index({ email: 1 }, { unique: true });
AccountSchema.index({ status: 1, lastSyncedAt: 1 });

// Helpers para encriptar/desencriptar credenciales de forma transparente
AccountSchema.methods.setImapCredentials = function (this: IAccount, plain: string): void {
  this.imap.authCredentialsEncrypted = encrypt(plain);
};

AccountSchema.methods.getImapCredentials = function (this: IAccount): string {
  return decrypt(this.imap.authCredentialsEncrypted);
};

AccountSchema.methods.setSmtpCredentials = function (this: IAccount, plain: string): void {
  this.smtp.authCredentialsEncrypted = encrypt(plain);
};

AccountSchema.methods.getSmtpCredentials = function (this: IAccount): string {
  return decrypt(this.smtp.authCredentialsEncrypted);
};

export const Account = mongoose.model<IAccount>('Account', AccountSchema);
