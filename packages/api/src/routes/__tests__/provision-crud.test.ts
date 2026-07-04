import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// IMAP mock: la verificación post-alta (connect/logout) resuelve OK → buzón "activo".
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
import bcrypt from 'bcryptjs';
import { setMailboxConfig } from '../../services/mailbox/index.js';
import { DockerMailserverProvider } from '../../services/mailbox/docker-mailserver.js';
import { Account } from '../../models/Account.js';

/** Verifica que `password` autentica contra la línea `email|{BLF-CRYPT}$2y$...` del accounts.cf. */
function passwordMatches(accountsContent: string, email: string, password: string): boolean {
  const raw = accountsContent.match(new RegExp(`${email.replace('.', '\\.')}\\|(\\S+)`))?.[1];
  if (!raw) return false;
  const hash = raw.replace('{BLF-CRYPT}', '').replace(/^\$2y\$/, '$2a$');
  return bcrypt.compareSync(password, hash);
}
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app: FastifyInstance;
let dir: string;
let accountsFile: string;
const KEY = 'crud-key-xyz';
const H = () => ({ 'x-provision-key': KEY });

async function enable() {
  await setMailboxConfig(
    { providerType: 'docker-mailserver', dockerMailserver: { accountsFile } },
    'test'
  );
}
async function create(email: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/provision/mailboxes',
    headers: H(),
    payload: { email, password: 'x', ...extra },
  });
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prov-crud-'));
  accountsFile = path.join(dir, 'postfix-accounts.cf');
  process.env.PROVISION_API_KEY = KEY;
  process.env.MAIL_SERVER_HOST = 'mail.cleverty.info';
  await enable();
});
afterEach(async () => {
  delete process.env.PROVISION_API_KEY;
  delete process.env.MAIL_SERVER_HOST;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('provision CRUD', () => {
  it('GET /mailboxes lista paginado (ya no cae en el guard Bearer)', async () => {
    await create('a@cleverty.info');
    await create('b@cleverty.info');
    const res = await app.inject({
      method: 'GET',
      url: '/api/provision/mailboxes?page=1&pageSize=50',
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.items).toHaveLength(2);
    // shape consistente
    const m = body.items[0];
    expect(m).toHaveProperty('id');
    expect(m).toHaveProperty('email');
    expect(m).toHaveProperty('status');
    expect(m).toHaveProperty('quotaBytes');
    expect(m).toHaveProperty('aliases');
    expect(m).toHaveProperty('createdAt');
  });

  it('GET /mailboxes?search filtra por email', async () => {
    await create('ana@cleverty.info');
    await create('beto@cleverty.info');
    const res = await app.inject({
      method: 'GET',
      url: '/api/provision/mailboxes?search=ana',
      headers: H(),
    });
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].email).toBe('ana@cleverty.info');
  });

  it('GET /mailboxes sin key → 401 (no 404: hay key configurada)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/provision/mailboxes' });
    expect(res.statusCode).toBe(401);
  });

  it('PATCH edita displayName y quotaBytes', async () => {
    await create('c@cleverty.info');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/c%40cleverty.info',
      headers: H(),
      payload: { displayName: 'Carlos', quotaBytes: 1048576 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe('Carlos');
    expect(res.json().quotaBytes).toBe(1048576);
  });

  it('PATCH active:false suspende (fuera del accounts.cf) y active:true reactiva SIN perder password', async () => {
    await create('sus@cleverty.info', { password: 'secreta' });
    const before = await fs.readFile(accountsFile, 'utf8');
    expect(before).toContain('sus@cleverty.info');

    // suspender
    const susp = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/sus%40cleverty.info',
      headers: H(),
      payload: { active: false },
    });
    expect(susp.statusCode).toBe(200);
    expect(susp.json().status).toBe('suspended');
    expect(await fs.readFile(accountsFile, 'utf8')).not.toContain('sus@cleverty.info');

    // reactivar → la MISMA línea (mismo hash) vuelve
    const react = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/sus%40cleverty.info',
      headers: H(),
      payload: { active: true },
    });
    expect(react.statusCode).toBe(200);
    expect(react.json().status).toBe('active');
    const restored = await fs.readFile(accountsFile, 'utf8');
    expect(restored).toContain('sus@cleverty.info|{BLF-CRYPT}');
  });

  it('PATCH aliases se refleja en get y en postfix-virtual.cf', async () => {
    await create('al@cleverty.info');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/al%40cleverty.info',
      headers: H(),
      payload: { aliases: ['ventas@cleverty.info', 'info@cleverty.info'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().aliases.sort()).toEqual(['info@cleverty.info', 'ventas@cleverty.info']);
    const virt = await fs.readFile(path.join(dir, 'postfix-virtual.cf'), 'utf8');
    expect(virt).toContain('ventas@cleverty.info al@cleverty.info');
  });

  it('PUT password cambia la clave (hash nuevo en accounts.cf)', async () => {
    await create('pw@cleverty.info', { password: 'vieja' });
    const h1 = (await fs.readFile(accountsFile, 'utf8')).match(/pw@cleverty\.info\|(\S+)/)?.[1];
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provision/mailboxes/pw%40cleverty.info/password',
      headers: H(),
      payload: { password: 'nueva-clave-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const h2 = (await fs.readFile(accountsFile, 'utf8')).match(/pw@cleverty\.info\|(\S+)/)?.[1];
    expect(h2).toBeTruthy();
    expect(h2).not.toBe(h1);
  });

  it('POST reset-password genera y devuelve una nueva UNA vez', async () => {
    await create('rst@cleverty.info');
    const res = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes/rst%40cleverty.info/reset-password',
      headers: H(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('rst@cleverty.info');
    expect(typeof res.json().password).toBe('string');
    expect(res.json().password.length).toBeGreaterThan(10);
  });

  it('PATCH/PUT/reset de un buzón inexistente → 404', async () => {
    for (const req of [
      {
        method: 'PATCH' as const,
        url: '/api/provision/mailboxes/no%40cleverty.info',
        payload: { displayName: 'X' },
      },
      {
        method: 'PUT' as const,
        url: '/api/provision/mailboxes/no%40cleverty.info/password',
        payload: { password: 'x' },
      },
      {
        method: 'POST' as const,
        url: '/api/provision/mailboxes/no%40cleverty.info/reset-password',
        payload: {},
      },
    ]) {
      const res = await app.inject({ ...req, headers: H() });
      expect(res.statusCode, req.url).toBe(404);
    }
  });

  it('Idempotency-Key: el retry del alta devuelve la MISMA respuesta (con la password generada)', async () => {
    const idem = { 'x-provision-key': KEY, 'idempotency-key': 'abc-123' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: idem,
      payload: { email: 'idem@cleverty.info' }, // sin password → generada
    });
    expect(first.statusCode).toBe(201);
    const pw = first.json().password;
    expect(typeof pw).toBe('string');
    // retry con la misma key → misma respuesta cacheada (misma password), NO 409
    const retry = await app.inject({
      method: 'POST',
      url: '/api/provision/mailboxes',
      headers: idem,
      payload: { email: 'idem@cleverty.info' },
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().password).toBe(pw);
  });

  // ── Regresiones de la revisión B/C/D del CRUD ──

  it('HIGH-1: si deleteMailbox falla al suspender, el hash queda a salvo y el retry completa la suspensión', async () => {
    await create('hi@cleverty.info', { password: 'orig' });
    // Falla el borrado de la línea DESPUÉS de haber persistido el hash en Mongo.
    const spy = vi
      .spyOn(DockerMailserverProvider.prototype, 'deleteMailbox')
      .mockRejectedValueOnce(new Error('mailserver down'));
    const susp = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/hi%40cleverty.info',
      headers: H(),
      payload: { active: false },
    });
    expect(susp.statusCode).toBe(502);
    // El hash quedó guardado (reintento seguro) y la línea sigue viva (el delete falló) → NO se perdió nada.
    const acc = await Account.findOne({ email: 'hi@cleverty.info' });
    expect(acc?.provisionSuspendedLine).toContain('hi@cleverty.info|{BLF-CRYPT}');
    expect(await fs.readFile(accountsFile, 'utf8')).toContain('hi@cleverty.info');
    spy.mockRestore();
    // Retry: converge a suspendido (borra la línea) sin pedir de nuevo el hash.
    const retry = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/hi%40cleverty.info',
      headers: H(),
      payload: { active: false },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe('suspended');
    expect(await fs.readFile(accountsFile, 'utf8')).not.toContain('hi@cleverty.info|');
  });

  it('HIGH-2 (B): partial-suspend → cambiar password → reactivar aplica el hash NUEVO (no el viejo vivo)', async () => {
    await create('cv@cleverty.info', { password: 'vieja' });
    const hOld = (await fs.readFile(accountsFile, 'utf8')).match(/cv@cleverty\.info\|(\S+)/)?.[1];
    // suspend con delete fallido → la línea vieja sigue VIVA y provisionSuspendedLine queda seteado.
    const spy = vi
      .spyOn(DockerMailserverProvider.prototype, 'deleteMailbox')
      .mockRejectedValueOnce(new Error('down'));
    const s = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/cv%40cleverty.info',
      headers: H(),
      payload: { active: false },
    });
    expect(s.statusCode).toBe(502);
    spy.mockRestore();
    // cambiar password en ese estado parcial → reescribe el hash guardado (200, no 502).
    const pw = await app.inject({
      method: 'PUT',
      url: '/api/provision/mailboxes/cv%40cleverty.info/password',
      headers: H(),
      payload: { password: 'nueva-clave-xyz' },
    });
    expect(pw.statusCode).toBe(200);
    // reactivar → addRawLine debe REEMPLAZAR la línea vieja por el hash nuevo (convergencia real).
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/cv%40cleverty.info',
      headers: H(),
      payload: { active: true },
    });
    expect(r.statusCode).toBe(200);
    const acct = await fs.readFile(accountsFile, 'utf8');
    const hNew = acct.match(/cv@cleverty\.info\|(\S+)/)?.[1];
    expect(hNew).toBeTruthy();
    expect(hNew).not.toBe(hOld);
    // La password NUEVA autentica y la VIEJA ya no (no basta con que el hash cambie).
    expect(passwordMatches(acct, 'cv@cleverty.info', 'nueva-clave-xyz')).toBe(true);
    expect(passwordMatches(acct, 'cv@cleverty.info', 'vieja')).toBe(false);
  });

  it('doble suspend es idempotente (segundo PATCH active:false → 200, sigue suspendido)', async () => {
    await create('ds@cleverty.info');
    await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/ds%40cleverty.info',
      headers: H(),
      payload: { active: false },
    });
    const second = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/ds%40cleverty.info',
      headers: H(),
      payload: { active: false },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('suspended');
    expect(await fs.readFile(accountsFile, 'utf8')).not.toContain('ds@cleverty.info|');
  });

  it('MED-5: un alias que ya pertenece a otro buzón → 409 (unicidad global)', async () => {
    await create('uno@cleverty.info');
    await create('dos@cleverty.info');
    // uno se queda con ventas@
    await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/uno%40cleverty.info',
      headers: H(),
      payload: { aliases: ['ventas@cleverty.info'] },
    });
    // dos intenta el MISMO alias → conflicto
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/dos%40cleverty.info',
      headers: H(),
      payload: { aliases: ['ventas@cleverty.info'] },
    });
    expect(res.statusCode).toBe(409);
    // virtual.cf no quedó con el alias duplicado apuntando a dos
    const virt = await fs.readFile(path.join(dir, 'postfix-virtual.cf'), 'utf8');
    expect(virt).not.toContain('ventas@cleverty.info dos@cleverty.info');
  });

  it('MED-6: cambiar la password de un buzón SUSPENDIDO → 200 y aplica al reactivar (no 502 engañoso)', async () => {
    await create('sp@cleverty.info', { password: 'vieja' });
    const hOld = (await fs.readFile(accountsFile, 'utf8')).match(/sp@cleverty\.info\|(\S+)/)?.[1];
    // suspender
    await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/sp%40cleverty.info',
      headers: H(),
      payload: { active: false },
    });
    // cambiar password estando suspendido → debe ser 200 (el buzón existe), no 502
    const pw = await app.inject({
      method: 'PUT',
      url: '/api/provision/mailboxes/sp%40cleverty.info/password',
      headers: H(),
      payload: { password: 'nueva-clave-abc' },
    });
    expect(pw.statusCode).toBe(200);
    // reactivar → la línea vuelve con el hash NUEVO (no el viejo)
    await app.inject({
      method: 'PATCH',
      url: '/api/provision/mailboxes/sp%40cleverty.info',
      headers: H(),
      payload: { active: true },
    });
    const hNew = (await fs.readFile(accountsFile, 'utf8')).match(/sp@cleverty\.info\|(\S+)/)?.[1];
    expect(hNew).toBeTruthy();
    expect(hNew).not.toBe(hOld);
  });
});
