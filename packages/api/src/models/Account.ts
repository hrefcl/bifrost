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
  /** Cuota de adjuntos subidos, en bytes. 0/ausente = sin límite (ver enforcement en attachments). */
  quotaBytes?: number;
  /** Provisioning: al SUSPENDER, se guarda acá la línea `email|hash` que se quitó del accounts.cf,
   *  para poder REACTIVAR sin perder la contraseña. Presente ⇒ el buzón está suspendido. */
  provisionSuspendedLine?: string;
  createdAt: Date;
  updatedAt: Date;

  setImapCredentials(plain: string): void;
  getImapCredentials(): string;
  setSmtpCredentials(plain: string): void;
  getSmtpCredentials(): string;
}

// Credencial cifrada. Los campos NO son `required`: una cuenta puede existir SIN credenciales de webmail
// (buzón importado del servidor por reconcileMailboxes que nadie vinculó todavía → ciphertext:''). Con
// `required:true`, Mongoose rechaza el string vacío y un `account.save()` sobre ese shell (p.ej. al
// suspenderlo) tiraba ValidationError→502. El estado "sin credenciales" es legítimo y se rellena al
// primer login o al fijar la contraseña. Default '' mantiene el shape para docs nuevos.
const EncryptedFieldSchema = new Schema(
  {
    ciphertext: { type: String, default: '' },
    iv: { type: String, default: '' },
    tag: { type: String, default: '' },
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
    // Cuota de adjuntos en bytes (0 = sin límite). La fija el admin; se aplica al subir adjuntos.
    quotaBytes: { type: Number, default: 0, min: 0 },
    // Provisioning: línea `email|hash` guardada al suspender (presente ⇒ suspendido). Ver IAccount.
    provisionSuspendedLine: { type: String },
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
