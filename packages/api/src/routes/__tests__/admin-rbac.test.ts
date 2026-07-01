import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

/**
 * F8 RBAC — pruebas de seguridad (negativas). El modelo: admin=superusuario, capa aditiva, default-deny
 * por `config.permission`, regla de subconjunto anti-escalación, cascade-unset anti-lockout.
 */
describe('admin RBAC (F8)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  /** Crea un usuario con un rol custom que otorga `perms`, devuelve {app, userId, headers}. */
  async function seedRoleHolder(app: Awaited<ReturnType<typeof buildTestApp>>, perms: string[]) {
    const { user } = await seedUserWithAccount({
      email: `holder-${perms.join('_') || 'none'}@test.com`,
    });
    const role = await Role.create({
      name: `role-${perms.join('-') || 'empty'}`,
      permissions: perms,
    });
    await User.updateOne({ _id: user._id }, { $set: { customRoleId: role._id } });
    return {
      userId: user._id.toString(),
      roleId: role._id.toString(),
      headers: authHeaders(app, user._id.toString()),
    };
  }
  async function seedAdmin(app: Awaited<ReturnType<typeof buildTestApp>>) {
    const { user } = await seedUserWithAccount({ email: 'admin@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    return { userId: user._id.toString(), headers: authHeaders(app, user._id.toString()) };
  }

  it('default-deny: role-holder accede sólo a las rutas de su permiso, no a otras', async () => {
    const app = await buildTestApp();
    const { headers } = await seedRoleHolder(app, ['groups.manage']);
    // Tiene groups.manage → puede listar grupos.
    const ok = await app.inject({ method: 'GET', url: '/api/admin/groups', headers });
    expect(ok.statusCode).toBe(200);
    // NO tiene accounts.manage → /accounts prohibido.
    const denied = await app.inject({ method: 'GET', url: '/api/admin/accounts', headers });
    expect(denied.statusCode).toBe(403);
    // Ruta admin-only (sin config.permission) → prohibida para cualquier delegado.
    const version = await app.inject({ method: 'GET', url: '/api/admin/version', headers });
    expect(version.statusCode).toBe(403);
    await app.close();
  });

  it('whoami: role-holder recibe 200 con SUS permisos; sin permisos → 403', async () => {
    const app = await buildTestApp();
    const { headers } = await seedRoleHolder(app, ['groups.manage']);
    const res = await app.inject({ method: 'GET', url: '/api/admin/whoami', headers });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.role).toBe('user');
    expect(body.permissions).toEqual(['groups.manage']);

    const { headers: emptyHeaders } = await seedRoleHolder(app, []);
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/admin/whoami',
      headers: emptyHeaders,
    });
    expect(res2.statusCode).toBe(403);
    await app.close();
  });

  it('permisos stale (fuera del catálogo) se ignoran al resolver', async () => {
    const app = await buildTestApp();
    const { headers } = await seedRoleHolder(app, [
      'groups.manage',
      'bogus.permission',
      'accounts.delete_all',
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/admin/whoami', headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).permissions).toEqual(['groups.manage']);
    await app.close();
  });

  it('subset rule: un delegado no puede crear un rol con permisos que no tiene', async () => {
    const app = await buildTestApp();
    const { headers } = await seedRoleHolder(app, ['roles.manage', 'groups.manage']);
    // Intenta escalar creando un rol con accounts.manage (que él NO tiene).
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/roles',
      headers,
      payload: { name: 'escalado', permissions: ['groups.manage', 'accounts.manage'] },
    });
    expect(res.statusCode).toBe(403);
    // Un rol con permisos ⊆ los suyos SÍ se crea.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/admin/roles',
      headers,
      payload: { name: 'valido', permissions: ['groups.manage'] },
    });
    expect(ok.statusCode).toBe(201);
    await app.close();
  });

  it('subset rule: un delegado no puede ASIGNAR un rol con permisos que no tiene', async () => {
    const app = await buildTestApp();
    // admin crea un rol potente
    const { headers: adminHeaders } = await seedAdmin(app);
    const strong = await app.inject({
      method: 'POST',
      url: '/api/admin/roles',
      headers: adminHeaders,
      payload: { name: 'strong', permissions: ['accounts.manage', 'roles.manage'] },
    });
    const strongId = JSON.parse(strong.body).id;
    // delegado con sólo roles.manage intenta asignar el rol potente a una cuenta objetivo
    const { headers: delegHeaders } = await seedRoleHolder(app, ['roles.manage']);
    const { account } = await seedUserWithAccount({ email: 'target@test.com' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/accounts/${account._id.toString()}/role`,
      headers: delegHeaders,
      payload: { customRoleId: strongId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('cascade-unset: borrar un rol quita el acceso a sus portadores (anti dangling)', async () => {
    const app = await buildTestApp();
    const { headers: adminHeaders } = await seedAdmin(app);
    const { userId, roleId, headers } = await seedRoleHolder(app, ['groups.manage']);
    // Antes del borrado: tiene acceso.
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/groups', headers })).statusCode
    ).toBe(200);
    // El admin borra el rol.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/roles/${roleId}`,
      headers: adminHeaders,
    });
    expect(del.statusCode).toBe(200);
    // customRoleId quedó unset → el usuario ya no tiene acceso.
    const after = await app.inject({ method: 'GET', url: '/api/admin/groups', headers });
    expect(after.statusCode).toBe(403);
    const u = await User.findById(userId).select('customRoleId').lean();
    expect(u?.customRoleId).toBeUndefined();
    await app.close();
  });

  it('roles de sistema: un delegado no los edita ni borra; el admin sí', async () => {
    const app = await buildTestApp();
    const sysRole = await Role.create({
      name: 'sistema',
      permissions: ['groups.manage'],
      isSystem: true,
    });
    const { headers } = await seedRoleHolder(app, ['roles.manage']);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/admin/roles/${sysRole._id.toString()}`,
      headers,
      payload: { name: 'hackeado' },
    });
    expect(patch.statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/roles/${sysRole._id.toString()}`,
      headers,
    });
    expect(del.statusCode).toBe(403);
    await app.close();
  });

  it('admin es superusuario: pasa en toda ruta y whoami trae el catálogo completo', async () => {
    const app = await buildTestApp();
    const { headers } = await seedAdmin(app);
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/accounts', headers })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/groups', headers })).statusCode
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/roles', headers })).statusCode).toBe(
      200
    );
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/version', headers })).statusCode
    ).toBe(200);
    await app.close();
  });

  it('admin con customRoleId acotado sigue siendo superusuario (el rol se ignora)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'admin2@test.com' });
    const weak = await Role.create({ name: 'weak', permissions: ['groups.manage'] });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin', customRoleId: weak._id } });
    const headers = authHeaders(app, user._id.toString());
    // Aunque su rol custom sólo tiene groups.manage, como admin accede a accounts igual.
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/accounts', headers })).statusCode
    ).toBe(200);
    const who = await app.inject({ method: 'GET', url: '/api/admin/whoami', headers });
    expect(JSON.parse(who.body).role).toBe('admin');
    expect(JSON.parse(who.body).permissions).toContain('accounts.manage');
    await app.close();
  });

  it('/auth/me expone adminPermissions (admite/filtra el panel en el cliente)', async () => {
    const app = await buildTestApp();
    const { headers: adminHeaders } = await seedAdmin(app);
    const meAdmin = await app.inject({ method: 'GET', url: '/api/auth/me', headers: adminHeaders });
    expect(meAdmin.statusCode).toBe(200);
    expect(JSON.parse(meAdmin.body).adminPermissions).toContain('roles.manage');

    const { headers: holderHeaders } = await seedRoleHolder(app, ['groups.manage']);
    const meHolder = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: holderHeaders,
    });
    expect(JSON.parse(meHolder.body).adminPermissions).toEqual(['groups.manage']);

    const { user } = await seedUserWithAccount({ email: 'plain@test.com' });
    const mePlain = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(JSON.parse(mePlain.body).adminPermissions).toEqual([]);
    await app.close();
  });

  it('rol inexistente (customRoleId colgante) → permisos vacíos, sin crash', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'dangling@test.com' });
    const role = await Role.create({ name: 'temp', permissions: ['groups.manage'] });
    await User.updateOne({ _id: user._id }, { $set: { customRoleId: role._id } });
    await Role.deleteOne({ _id: role._id }); // borra el rol dejando el puntero colgante
    const headers = authHeaders(app, user._id.toString());
    const res = await app.inject({ method: 'GET', url: '/api/admin/whoami', headers });
    expect(res.statusCode).toBe(403); // sin permisos efectivos
    await app.close();
  });
});
