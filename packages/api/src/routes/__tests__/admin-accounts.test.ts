import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// IMAP mock: el alta de cuenta verifica credenciales reales (connect/logout) → las resolvemos.
vi.mock('imapflow', () => {
  class ImapFlow {
    constructor(_opts: unknown) {}
    async connect(): Promise<void> {}
    async logout(): Promise<void> {}
  }
  return { ImapFlow };
});

import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { User } from '../../models/User.js';
import { Role } from '../../models/Role.js';
import { Account } from '../../models/Account.js';
import { Draft } from '../../models/Draft.js';
import { Contact } from '../../models/Contact.js';
import { CalendarEvent } from '../../models/CalendarEvent.js';

const newAccountBody = (email: string) => ({
  email,
  password: 'pw-123',
  displayName: 'Nuevo Usuario',
  imapHost: 'imap.empresa.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.empresa.com',
  smtpPort: 465,
  smtpSecure: true,
  quotaBytes: 50 * 1024 * 1024,
});

async function seedAdmin(app: Awaited<ReturnType<typeof buildTestApp>>) {
  const { user, account } = await seedUserWithAccount({ email: 'admin@test.com' });
  await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
  return { headers: authHeaders(app, user._id.toString()), user, account };
}

describe('admin: gestión de cuentas + branding (PM-03/PM-04)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('anti-escalada (RBAC F8): el alta desde el panel NUNCA crea un admin, aunque no haya admin', async () => {
    const app = await buildTestApp();
    // Delegado con accounts.manage y NINGÚN admin en la instancia (p. ej. borrado fuera de banda).
    const { user } = await seedUserWithAccount({ email: 'delegate@test.com' });
    const role = await Role.create({ name: 'altas', permissions: ['accounts.manage'] });
    await User.updateOne({ _id: user._id }, { $set: { customRoleId: role._id } });
    expect(await User.exists({ role: 'admin' })).toBeNull();

    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers: authHeaders(app, user._id.toString()),
      payload: newAccountBody('nuevo@empresa.com'),
    });
    expect(create.statusCode).toBe(201);
    // Sin el fix, el bootstrap habría hecho admin a la cuenta creada. Debe ser 'user'.
    const created = await User.findOne({ primaryEmail: 'nuevo@empresa.com' }).select('role').lean();
    expect(created?.role).toBe('user');
    expect(await User.exists({ role: 'admin' })).toBeNull();
    await app.close();
  });

  it('POST /accounts crea una cuenta (verifica IMAP) y GET /accounts la lista con su cuota', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);
    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: newAccountBody('nuevo@empresa.com'),
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/admin/accounts', headers });
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.body) as {
      accounts: { email: string; quotaBytes: number; status: string }[];
    };
    const created = body.accounts.find((a) => a.email === 'nuevo@empresa.com');
    expect(created).toBeTruthy();
    expect(created?.quotaBytes).toBe(50 * 1024 * 1024);
    expect(created?.status).toBe('active');
    await app.close();
  });

  it('F6: cuota por defecto se aplica al crear sin quotaBytes; explícita la respeta; no migra existentes', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);
    const DEFAULT = 2 * 1024 * 1024 * 1024; // 2 GB

    // cuenta PRE-existente con cuota explícita (antes de tocar el default)
    await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: newAccountBody('pre@empresa.com'),
    });

    // fijar la cuota por defecto
    const setDef = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage-defaults',
      headers,
      payload: { defaultQuotaBytes: DEFAULT },
    });
    expect(setDef.statusCode).toBe(200);
    expect(JSON.parse(setDef.body).defaultQuotaBytes).toBe(DEFAULT);

    // la cuenta PRE-existente NO se migra: conserva su cuota original (review B-LOW)
    const afterDefault = await app.inject({ method: 'GET', url: '/api/admin/accounts', headers });
    const pre = (
      JSON.parse(afterDefault.body) as { accounts: { email: string; quotaBytes: number }[] }
    ).accounts.find((a) => a.email === 'pre@empresa.com');
    expect(pre?.quotaBytes).toBe(50 * 1024 * 1024);

    // crear SIN quotaBytes → toma el default
    const { quotaBytes: _omit, ...noQuota } = newAccountBody('sinquota@empresa.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: noQuota,
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).quotaBytes).toBe(DEFAULT);

    // crear CON quotaBytes explícita → respeta el valor enviado (no el default)
    const explicit = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: newAccountBody('conquota@empresa.com'),
    });
    expect(JSON.parse(explicit.body).quotaBytes).toBe(50 * 1024 * 1024);
    await app.close();
  });

  it('POST /accounts con email existente → 409', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);
    await seedUserWithAccount({ email: 'ya@empresa.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/accounts',
      headers,
      payload: newAccountBody('ya@empresa.com'),
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('PATCH /accounts/:id deshabilita y fija cuota; deshabilitar la propia cuenta admin → 400', async () => {
    const app = await buildTestApp();
    const { headers, account: adminAccount } = await seedAdmin(app);
    const { account } = await seedUserWithAccount({ email: 'target@empresa.com' });

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/admin/accounts/${account._id.toString()}`,
      headers,
      payload: { status: 'disabled', quotaBytes: 10 * 1024 * 1024 },
    });
    expect(patch.statusCode).toBe(200);
    const updated = await Account.findById(account._id).lean();
    expect(updated?.status).toBe('disabled');
    expect(updated?.quotaBytes).toBe(10 * 1024 * 1024);

    // Auto-bloqueo prohibido.
    const self = await app.inject({
      method: 'PATCH',
      url: `/api/admin/accounts/${adminAccount._id.toString()}`,
      headers,
      payload: { status: 'disabled' },
    });
    expect(self.statusCode).toBe(400);
    await app.close();
  });

  it('DELETE /accounts/:id elimina la cuenta, su usuario y CASCADA sus datos; borrar la propia → 400', async () => {
    const app = await buildTestApp();
    const { headers, account: adminAccount } = await seedAdmin(app);
    const { user, account } = await seedUserWithAccount({ email: 'borrar@empresa.com' });
    // Datos del usuario/cuenta que DEBEN borrarse en cascada (insertOne evita validaciones ajenas).
    await Draft.collection.insertOne({ userId: user._id, accountId: account._id, subject: 'x' });
    await CalendarEvent.collection.insertOne({
      userId: user._id,
      accountId: account._id,
      uid: 'u1',
    });
    await Contact.collection.insertOne({ userId: user._id, name: 'Juan' });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/accounts/${account._id.toString()}`,
      headers,
    });
    expect(del.statusCode).toBe(200);
    expect(await Account.findById(account._id).lean()).toBeNull();
    expect(await User.findById(user._id).lean()).toBeNull();
    // Sin huérfanos: drafts/eventos (accountId-bound) y contactos (userId-bound) eliminados.
    expect(await Draft.countDocuments({ accountId: account._id })).toBe(0);
    expect(await CalendarEvent.countDocuments({ accountId: account._id })).toBe(0);
    expect(await Contact.countDocuments({ userId: user._id })).toBe(0);

    const self = await app.inject({
      method: 'DELETE',
      url: `/api/admin/accounts/${adminAccount._id.toString()}`,
      headers,
    });
    expect(self.statusCode).toBe(400);
    await app.close();
  });

  it('una cuenta deshabilitada no puede iniciar sesión (403)', async () => {
    const app = await buildTestApp();
    const { account } = await seedUserWithAccount({ email: 'bloqueada@empresa.com' });
    await Account.updateOne({ _id: account._id }, { $set: { status: 'disabled' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'bloqueada@empresa.com',
        password: 'pw',
        imapHost: 'imap.x',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'smtp.x',
        smtpPort: 465,
        smtpSecure: true,
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('branding: PUT admin lo guarda y el GET público /api/branding lo devuelve (sin auth)', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/branding',
      headers,
      payload: { companyName: 'ACME Corp', accentColor: '#ff0000', tagline: 'Hola' },
    });
    expect(put.statusCode).toBe(200);

    const pub = await app.inject({ method: 'GET', url: '/api/branding' });
    expect(pub.statusCode).toBe(200);
    const body = JSON.parse(pub.body) as { companyName: string; accentColor: string };
    expect(body.companyName).toBe('ACME Corp');
    expect(body.accentColor).toBe('#ff0000');
    await app.close();
  });

  it('branding: rechaza color inválido (400)', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/branding',
      headers,
      payload: { accentColor: 'rojo' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('branding: iconWeight — default light, persiste un weight válido y rechaza uno inválido', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);

    // Default sin configurar: la vista pública expone 'light'.
    const pub0 = await app.inject({ method: 'GET', url: '/api/branding' });
    expect((JSON.parse(pub0.body) as { iconWeight: string }).iconWeight).toBe('light');

    // Guarda un weight válido → se expone.
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/branding',
      headers,
      payload: { iconWeight: 'duotone' },
    });
    expect(ok.statusCode).toBe(200);
    const pub = await app.inject({ method: 'GET', url: '/api/branding' });
    expect((JSON.parse(pub.body) as { iconWeight: string }).iconWeight).toBe('duotone');

    // Un weight fuera del enum → 400 (anti valor arbitrario).
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/branding',
      headers,
      payload: { iconWeight: 'sparkles' },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('branding extendido (F1): guarda domainUrl/phone/socials/logoWidthPx/lockAccentColor y los expone', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/branding',
      headers,
      payload: {
        companyName: 'Aulion',
        domainUrl: 'https://aulion.app',
        phone: '+56 9 1234 5678',
        address: 'Santiago, CL',
        socialLinks: { linkedin: 'https://linkedin.com/company/aulion', instagram: '' },
        logoWidthPx: 140,
        lockAccentColor: true,
      },
    });
    expect(put.statusCode).toBe(200);

    const pub = await app.inject({ method: 'GET', url: '/api/branding' });
    const body = JSON.parse(pub.body);
    expect(body.domainUrl).toBe('https://aulion.app');
    expect(body.phone).toBe('+56 9 1234 5678');
    expect(body.logoWidthPx).toBe(140);
    expect(body.lockAccentColor).toBe(true);
    // El social vacío se limpia; el válido queda.
    expect(body.socialLinks).toEqual({ linkedin: 'https://linkedin.com/company/aulion' });
    await app.close();
  });

  it('branding extendido (F1): rechaza URLs no-http (javascript:/data:) en domainUrl y socials (H1)', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);
    const badDomain = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/branding',
      headers,
      payload: { domainUrl: 'javascript:alert(1)' },
    });
    expect(badDomain.statusCode).toBe(400);
    const badSocial = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/branding',
      headers,
      payload: { socialLinks: { linkedin: 'data:text/html,<script>alert(1)</script>' } },
    });
    expect(badSocial.statusCode).toBe(400);
    await app.close();
  });
});
