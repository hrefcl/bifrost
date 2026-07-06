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

  it('PATCH status=disabled SUSPENDE el buzón real (fuera del accounts.cf) y active lo restaura', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: { email: 'susp@cleverty.info', password: 'x' },
    });
    const acc = await Account.findOne({ email: 'susp@cleverty.info' }).lean();
    expect(await fs.readFile(accountsFile, 'utf8')).toContain('susp@cleverty.info');

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/admin/accounts/${String(acc?._id)}`,
      headers,
      payload: { status: 'disabled' },
    });
    expect(off.statusCode).toBe(200);
    // La línea REAL se quitó del accounts.cf (corta IMAP/SMTP), no sólo el status en Mongo.
    expect(await fs.readFile(accountsFile, 'utf8')).not.toContain('susp@cleverty.info');
    expect((await Account.findOne({ email: 'susp@cleverty.info' }))?.status).toBe('disabled');

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/admin/accounts/${String(acc?._id)}`,
      headers,
      payload: { status: 'active' },
    });
    expect(on.statusCode).toBe(200);
    // Restaurada la MISMA línea (misma password).
    expect(await fs.readFile(accountsFile, 'utf8')).toContain('susp@cleverty.info');
    expect((await Account.findOne({ email: 'susp@cleverty.info' }))?.status).toBe('active');
  });

  it('POST reset-password genera una clave, la aplica al accounts.cf y la devuelve una vez', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: { email: 'pw@cleverty.info', password: 'orig' },
    });
    const acc = await Account.findOne({ email: 'pw@cleverty.info' }).lean();
    const before = await fs.readFile(accountsFile, 'utf8');

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/accounts/${String(acc?._id)}/reset-password`,
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().password).toBe('string');
    // El hash del accounts.cf cambió (clave nueva realmente aplicada).
    const after = await fs.readFile(accountsFile, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('pw@cleverty.info|{BLF-CRYPT}$2y$');
  });

  it('POST /accounts/import importa buzones existentes del servidor no registrados', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    // Buzón que existe en el servidor pero NO en Bifrost (brownfield).
    await fs.writeFile(accountsFile, 'legacy@cleverty.info|{BLF-CRYPT}$2y$10$hash\n');

    const res = await app.inject({ method: 'POST', url: '/api/admin/accounts/import', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBeGreaterThanOrEqual(1);
    const imported = await Account.findOne({ email: 'legacy@cleverty.info' });
    expect(imported).not.toBeNull();
    // Shell sin credenciales de webmail → aparece "sin vincular" en el listado.
    expect(imported?.imap.authCredentialsEncrypted.ciphertext).toBe('');

    const list = await app.inject({ method: 'GET', url: '/api/admin/accounts', headers });
    const legacy = list
      .json()
      .accounts.find((a: { email: string }) => a.email === 'legacy@cleverty.info');
    expect(legacy.linked).toBe(false);
    // El flag de modo va explícito en la respuesta → el front oculta IMAP/SMTP en el alta (modo nativo).
    expect(list.json().provisioning).toBe(true);
  });

  it('suspende un buzón IMPORTADO (sin credenciales) sin ValidationError → quita la línea real', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    // Buzón brownfield importado (shell con credenciales de webmail VACÍAS).
    await fs.writeFile(accountsFile, 'legacy@cleverty.info|{BLF-CRYPT}$2y$10$hash\n');
    await app.inject({ method: 'POST', url: '/api/admin/accounts/import', headers });
    const acc = await Account.findOne({ email: 'legacy@cleverty.info' }).lean();

    // Regresión: antes esto tiraba 502 (save() del shell fallaba por creds vacías required).
    const off = await app.inject({
      method: 'PATCH',
      url: `/api/admin/accounts/${String(acc?._id)}`,
      headers,
      payload: { status: 'disabled' },
    });
    expect(off.statusCode).toBe(200);
    expect(await fs.readFile(accountsFile, 'utf8')).not.toContain('legacy@cleverty.info');

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/admin/accounts/${String(acc?._id)}`,
      headers,
      payload: { status: 'active' },
    });
    expect(on.statusCode).toBe(200);
    expect(await fs.readFile(accountsFile, 'utf8')).toContain('legacy@cleverty.info');
  });
});

describe('admin: alias de buzón (delivery-only, F-alias A1)', () => {
  const virtualFile = (): string => path.join(dir, 'postfix-virtual.cf');
  async function createAccount(headers: Record<string, string>, email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: { email },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('PUT setea aliases → los materializa en postfix-virtual.cf y el GET los devuelve', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    const id = await createAccount(headers, 'ana@cleverty.info');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${id}/aliases`,
      headers,
      payload: { aliases: ['ventas@cleverty.info', 'Info@cleverty.info'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().aliases).toEqual(['ventas@cleverty.info', 'info@cleverty.info']); // normalizados

    const virt = await fs.readFile(virtualFile(), 'utf8');
    expect(virt).toContain('ventas@cleverty.info ana@cleverty.info');
    expect(virt).toContain('info@cleverty.info ana@cleverty.info');

    const get = await app.inject({
      method: 'GET',
      url: `/api/admin/accounts/${id}/aliases`,
      headers,
    });
    expect(get.json().aliases.sort()).toEqual(['info@cleverty.info', 'ventas@cleverty.info']);
  });

  it('un alias == dirección REAL de otra cuenta → 409', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    await createAccount(headers, 'ana@cleverty.info');
    const bobId = await createAccount(headers, 'bob@cleverty.info');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${bobId}/aliases`,
      headers,
      payload: { aliases: ['ana@cleverty.info'] }, // ya es un buzón real
    });
    expect(put.statusCode).toBe(409);
  });

  it('un alias == la propia dirección del buzón → 400', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    const id = await createAccount(headers, 'ana@cleverty.info');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${id}/aliases`,
      headers,
      payload: { aliases: ['ana@cleverty.info'] },
    });
    expect(put.statusCode).toBe(400);
  });

  it('alias inválido (no email) → 400', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    const id = await createAccount(headers, 'ana@cleverty.info');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${id}/aliases`,
      headers,
      payload: { aliases: ['no-es-email'] },
    });
    expect(put.statusCode).toBe(400);
  });

  it('alias que ya pertenece a OTRO buzón → 409 (unicidad global)', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    const anaId = await createAccount(headers, 'ana@cleverty.info');
    const bobId = await createAccount(headers, 'bob@cleverty.info');
    await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${anaId}/aliases`,
      headers,
      payload: { aliases: ['comun@cleverty.info'] },
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${bobId}/aliases`,
      headers,
      payload: { aliases: ['comun@cleverty.info'] },
    });
    expect(put.statusCode).toBe(409);
  });

  it('borrar la cuenta quita sus aliases del postfix-virtual.cf (no huérfanos)', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    const id = await createAccount(headers, 'ana@cleverty.info');
    await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${id}/aliases`,
      headers,
      payload: { aliases: ['ventas@cleverty.info'] },
    });
    expect(await fs.readFile(virtualFile(), 'utf8')).toContain('ventas@cleverty.info');

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/accounts/${id}`, headers });
    expect(del.statusCode).toBe(200);
    expect(await fs.readFile(virtualFile(), 'utf8')).not.toContain('ventas@cleverty.info');
  });

  it('crear una cuenta cuyo email YA es un alias → 409', async () => {
    const headers = await seedAdmin();
    await enableProvisioning();
    const anaId = await createAccount(headers, 'ana@cleverty.info');
    await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${anaId}/aliases`,
      headers,
      payload: { aliases: ['soporte@cleverty.info'] },
    });
    // Intentar crear un buzón real con esa misma dirección → conflicto.
    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: { email: 'soporte@cleverty.info' },
    });
    expect(create.statusCode).toBe(409);
  });

  it('sin provisioning (BYO) → PUT aliases responde 409', async () => {
    const headers = await seedAdmin();
    const { account } = await seedUserWithAccount({ email: 'byo@empresa.com' });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/admin/accounts/${String(account._id)}/aliases`,
      headers,
      payload: { aliases: ['x@empresa.com'] },
    });
    expect(put.statusCode).toBe(409);
  });
});
