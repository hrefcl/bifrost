import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { buildSetupApp } from '../src/setup/index.js';
import { closeRedis, redis } from '../src/config/redis.js';
import { User } from '../src/models/User.js';
import { Account } from '../src/models/Account.js';
import { Folder } from '../src/models/Folder.js';
import { Email } from '../src/models/Email.js';

let mongoServer: MongoMemoryServer | undefined;

export async function setupTestDb() {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGODB_URI);
  // Construir índices de forma DETERMINISTA antes de cualquier test. `autoIndex` los
  // crea en background y había un race: la primera query `$text` podía ejecutarse antes
  // de que `email_text_search` existiera → 500 ("text index required"). createIndexes()
  // espera a que estén listos (idempotente; resetState usa deleteMany y los conserva).
  await Promise.all([
    User.createIndexes(),
    Account.createIndexes(),
    Folder.createIndexes(),
    Email.createIndexes(),
  ]);
}

export async function teardownTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await mongoServer?.stop();
  await closeRedis();
}

/** Borra todas las colecciones y flushea Redis entre tests para aislamiento. */
export async function resetState() {
  const collections = await mongoose.connection.db?.collections();
  for (const c of collections ?? []) {
    await c.deleteMany({});
  }
  await redis.flushall();
}

export async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp();
}

/** App de modo setup (sólo rutas /setup). Cubre buildSetupApp para el smoke de F3.1. */
export async function buildTestSetupApp(): Promise<FastifyInstance> {
  return buildSetupApp();
}

/** Header Authorization con un JWT válido firmado por la propia app (mismo secreto). */
export function authHeaders(app: FastifyInstance, userId: string): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ userId })}` };
}

export interface SeededUser {
  user: InstanceType<typeof User>;
  account: InstanceType<typeof Account>;
}

/** Crea un usuario + cuenta primaria con credenciales cifradas reales (clave de test). */
export async function seedUserWithAccount(opts: {
  email: string;
  password?: string;
}): Promise<SeededUser> {
  const user = await User.create({
    primaryEmail: opts.email,
    displayName: opts.email.split('@')[0],
  });
  const account = new Account({
    userId: user._id,
    name: opts.email,
    email: opts.email,
    isPrimary: true,
    imap: {
      host: 'imap.test',
      port: 993,
      secure: true,
      authMethod: 'password',
      authUser: opts.email,
      authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
      compress: false,
      preferredProtocol: 'imap',
    },
    smtp: {
      host: 'smtp.test',
      port: 465,
      secure: true,
      authMethod: 'password',
      authUser: opts.email,
      authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
    },
    status: 'active',
  });
  account.setImapCredentials(opts.password ?? 'secret-pass');
  account.setSmtpCredentials(opts.password ?? 'secret-pass');
  await account.save();
  return { user, account };
}

/** Crea una cuenta adicional para un usuario ya existente. */
export async function seedAccountFor(
  userId: mongoose.Types.ObjectId | string,
  email: string,
  password = 'secret-pass'
): Promise<InstanceType<typeof Account>> {
  const account = new Account({
    userId,
    name: email,
    email,
    isPrimary: false,
    imap: {
      host: 'imap.test',
      port: 993,
      secure: true,
      authMethod: 'password',
      authUser: email,
      authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
      compress: false,
      preferredProtocol: 'imap',
    },
    smtp: {
      host: 'smtp.test',
      port: 465,
      secure: true,
      authMethod: 'password',
      authUser: email,
      authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
    },
    status: 'active',
  });
  account.setImapCredentials(password);
  account.setSmtpCredentials(password);
  await account.save();
  return account;
}

export async function seedFolder(
  accountId: mongoose.Types.ObjectId | string,
  opts?: { name?: string; path?: string }
): Promise<InstanceType<typeof Folder>> {
  return Folder.create({
    accountId,
    name: opts?.name ?? 'INBOX',
    path: opts?.path ?? 'INBOX',
    delimiter: '/',
    displayName: opts?.name ?? 'INBOX',
    flags: [],
    uidValidity: 0,
    uidNext: 0,
    totalMessages: 0,
    unseenMessages: 0,
    subscribed: true,
    sortOrder: 0,
    expanded: false,
    syncedAt: new Date(),
  });
}

export async function seedEmail(
  accountId: mongoose.Types.ObjectId | string,
  folderId: mongoose.Types.ObjectId | string,
  opts?: { uid?: number; subject?: string }
): Promise<InstanceType<typeof Email>> {
  return Email.create({
    accountId,
    folderId,
    uid: opts?.uid ?? 1,
    messageId: `m-${String(opts?.uid ?? 1)}@test`,
    from: { address: 'sender@test' },
    to: [{ address: 'me@test' }],
    subject: opts?.subject ?? 'test subject',
    date: new Date(),
    internalDate: new Date(),
    size: 100,
    flags: { seen: false, answered: false, flagged: false, deleted: false, draft: false },
    hasAttachments: false,
    attachmentCount: 0,
    bodyCached: false,
  });
}
