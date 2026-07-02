import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// IMAP mock: la verificación post-alta (connect/logout) resuelve OK → simula el buzón ya activo.
vi.mock('imapflow', () => {
  class ImapFlow {
    constructor(_opts: unknown) {}
    async connect(): Promise<void> {}
    async logout(): Promise<void> {}
  }
  return { ImapFlow };
});

import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { setMailboxConfig } from '../../services/mailbox/index.js';
import { User } from '../../models/User.js';
import { Account } from '../../models/Account.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app: FastifyInstance;
let dir: string;
let accountsFile: string;

async function seedAdmin() {
  const { user } = await seedUserWithAccount({ email: 'admin@cleverty.info' });
  await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
  return authHeaders(app, user._id.toString());
}
async function enableProvisioning() {
  await setMailboxConfig(
    { providerType: 'docker-mailserver', dockerMailserver: { accountsFile } },
    'test'
  );
}

beforeAll(async () => {
  await setupTestDb();
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
  await teardownTestDb();
});
beforeEach(async () => {
  await resetState();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-prov-'));
  accountsFile = path.join(dir, 'postfix-accounts.cf');
  process.env.MAIL_SERVER_HOST = 'mail.cleverty.info';
});
afterEach(async () => {
  delete process.env.MAIL_SERVER_HOST;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('admin: alta turnkey (Bifrost crea el buzón real)', () => {
  it('con provisioning activo, el alta con SÓLO email crea el buzón real y devuelve la password generada', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();

    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: { email: 'nueva@cleverty.info', displayName: 'Nueva' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(typeof body.generatedPassword).toBe('string');
    expect(body.generatedPassword.length).toBeGreaterThan(10);

    // Buzón REAL escrito + cuenta Bifrost creada.
    expect(await fs.readFile(accountsFile, 'utf8')).toContain(
      'nueva@cleverty.info|{BLF-CRYPT}$2y$'
    );
    expect(await Account.findOne({ email: 'nueva@cleverty.info' })).not.toBeNull();
  });

  it('sin provisioning (bring-your-own), el alta con sólo email es 400 (faltan IMAP/SMTP/password)', async () => {
    const headers = await seedAdmin();
    // provider none por defecto (no enableProvisioning)
    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: { email: 'nueva@empresa.com' },
    });
    expect(create.statusCode).toBe(400);
  });

  it('DELETE revoca el buzón real antes de borrar la cuenta', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: { email: 'baja@cleverty.info', password: 'x' },
    });
    const acc = await Account.findOne({ email: 'baja@cleverty.info' }).lean();
    expect(acc).not.toBeNull();
    expect(await fs.readFile(accountsFile, 'utf8')).toContain('baja@cleverty.info');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/accounts/${String(acc?._id)}`,
      headers,
    });
    expect(del.statusCode).toBe(200);
    expect(await fs.readFile(accountsFile, 'utf8')).not.toContain('baja@cleverty.info');
    expect(await Account.findOne({ email: 'baja@cleverty.info' })).toBeNull();
  });

  it('alta turnkey con email ya existente → 409', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    const body = { email: 'dup@cleverty.info', password: 'x' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: body,
    });
    expect(second.statusCode).toBe(409);
  });
});
