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
} from '../../../test/integration-helper.js';
import { setMailboxConfig } from '../../services/mailbox/index.js';
import { createProvisionKey, revokeProvisionKey } from '../../services/provision-keys.js';
import { Account } from '../../models/Account.js';
import { User } from '../../models/User.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app: FastifyInstance;
let dir: string;
let accountsFile: string;
const KEY = 'test-provision-key-abc123';

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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prov-route-'));
  accountsFile = path.join(dir, 'postfix-accounts.cf');
  process.env.PROVISION_API_KEY = KEY;
  process.env.MAIL_SERVER_HOST = 'mail.cleverty.info';
});
afterEach(async () => {
  delete process.env.PROVISION_API_KEY;
  delete process.env.MAIL_SERVER_HOST;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('POST/DELETE /api/provision (auth de servicio)', () => {
  it('404 cuando PROVISION_API_KEY no está configurada (no revela el endpoint)', async () => {
    delete process.env.PROVISION_API_KEY;
    const res = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': KEY },
      payload: { email: 'a@cleverty.info' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('401 con key ausente o incorrecta', async () => {
    await enableProvisioning();
    const noKey = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      payload: { email: 'a@cleverty.info' },
    });
    expect(noKey.statusCode).toBe(401);

    const badKey = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': 'wrong' },
      payload: { email: 'a@cleverty.info' },
    });
    expect(badKey.statusCode).toBe(401);
  });

  it('503 cuando la key es válida pero el provider está en none', async () => {
    await setMailboxConfig({ providerType: 'none' }, 'test');
    const res = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': KEY },
      payload: { email: 'a@cleverty.info' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('crea el buzón real + la cuenta y devuelve la contraseña generada UNA vez', async () => {
    await enableProvisioning();
    const res = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': KEY },
      payload: { email: 'Nueva@cleverty.info', displayName: 'Nueva' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe('nueva@cleverty.info');
    expect(typeof body.password).toBe('string');
    expect(body.password.length).toBeGreaterThan(10);

    // El buzón REAL quedó escrito en el accounts.cf.
    const content = await fs.readFile(accountsFile, 'utf8');
    expect(content).toContain('nueva@cleverty.info|{BLF-CRYPT}$2y$');
    // Y la cuenta Bifrost existe.
    expect(await Account.findOne({ email: 'nueva@cleverty.info' })).not.toBeNull();
  });

  it('usa la contraseña provista (no la devuelve) y luego 409 en el duplicado', async () => {
    await enableProvisioning();
    const first = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': KEY },
      payload: { email: 'ana@cleverty.info', password: 'mi-clave-elegida' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().password).toBeUndefined(); // no se devuelve la provista

    const dup = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': KEY },
      payload: { email: 'ana@cleverty.info', password: 'otra' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('DELETE revoca el buzón real y borra la cuenta', async () => {
    await enableProvisioning();
    await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': KEY },
      payload: { email: 'baja@cleverty.info', password: 'x' },
    });
    expect(await fs.readFile(accountsFile, 'utf8')).toContain('baja@cleverty.info');

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/provision/mailboxes/baja%40cleverty.info',
      headers: { 'x-provision-key': KEY },
    });
    expect(del.statusCode).toBe(200);
    // El buzón real desapareció del accounts.cf → sin acceso IMAP/SMTP.
    expect(await fs.readFile(accountsFile, 'utf8')).not.toContain('baja@cleverty.info');
    expect(await Account.findOne({ email: 'baja@cleverty.info' })).toBeNull();
    expect(await User.findOne({ primaryEmail: 'baja@cleverty.info' })).toBeNull();
  });

  it('DELETE de un buzón inexistente → 404', async () => {
    await enableProvisioning();
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/provision/mailboxes/fantasma%40cleverty.info',
      headers: { 'x-provision-key': KEY },
    });
    expect(del.statusCode).toBe(404);
  });

  it('acepta una key GESTIONADA (DB) aunque no haya key de entorno', async () => {
    delete process.env.PROVISION_API_KEY; // sin bootstrap: sólo la key gestionada
    await enableProvisioning();
    const { token } = await createProvisionKey('Vanir', 'admin:1');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': token },
      payload: { email: 'db@cleverty.info', password: 'x' },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('una key gestionada REVOCADA deja de autenticar (401)', async () => {
    await enableProvisioning();
    const { token, key } = await createProvisionKey('Temporal', 'admin:1');
    await revokeProvisionKey(key.id);
    // env key sigue seteada → hay keys ⇒ 401 (no 404).
    const res = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': token },
      payload: { email: 'x@cleverty.info' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sin key de entorno NI gestionada → 404 (endpoint oculto)', async () => {
    delete process.env.PROVISION_API_KEY;
    await enableProvisioning(); // provider activo, pero ninguna key existe
    const res = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: { 'x-provision-key': 'lo-que-sea' },
      payload: { email: 'x@cleverty.info' },
    });
    expect(res.statusCode).toBe(404);
  });
});
