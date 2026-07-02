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
import { Group } from '../../models/Group.js';

describe('admin: grupos (F7)', () => {
  beforeAll(async () => {
    await setupTestDb();
    await Group.syncIndexes();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  async function seedAdmin(app: Awaited<ReturnType<typeof buildTestApp>>) {
    const { user } = await seedUserWithAccount({ email: 'admin@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    return authHeaders(app, user._id.toString());
  }

  it('CRUD + integridad de miembros + unicidad + gate admin', async () => {
    const app = await buildTestApp();
    const headers = await seedAdmin(app);
    const { user: u1 } = await seedUserWithAccount({ email: 'm1@test.com' });
    const { user: u2 } = await seedUserWithAccount({ email: 'm2@test.com' });
    const id1 = u1._id.toString();
    const id2 = u2._id.toString();
    const post = (url: string, payload: unknown) =>
      app.inject({ method: 'POST', url, headers, payload });
    const patch = (url: string, payload: unknown) =>
      app.inject({ method: 'PATCH', url, headers, payload });

    // gate admin: usuario normal → 403
    const { user: normal } = await seedUserWithAccount({ email: 'normal@test.com' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/groups',
          headers: authHeaders(app, normal._id.toString()),
        })
      ).statusCode
    ).toBe(403);

    // crear con un miembro existente
    const created = await post('/api/admin/groups', {
      name: 'Ventas',
      email: 'ventas@x.com',
      memberUserIds: [id1],
    });
    expect(created.statusCode).toBe(201);
    const g = JSON.parse(created.body) as { id: string; memberCount: number };
    expect(g.memberCount).toBe(1);

    // nombre duplicado → 409
    expect((await post('/api/admin/groups', { name: 'Ventas' })).statusCode).toBe(409);
    // email duplicado → 409
    expect(
      (await post('/api/admin/groups', { name: 'Otro', email: 'ventas@x.com' })).statusCode
    ).toBe(409);

    // crear con miembro inexistente → 400
    expect(
      (
        await post('/api/admin/groups', {
          name: 'Bad',
          memberUserIds: ['ffffffffffffffffffffffff'],
        })
      ).statusCode
    ).toBe(400);

    // añadir miembros (uno repetido → dedup por $addToSet)
    await patch(`/api/admin/groups/${g.id}/members`, { add: [id1, id2] });
    let fresh = await Group.findById(g.id);
    expect(fresh?.memberUserIds.map((x) => x.toString()).sort()).toEqual([id1, id2].sort());

    // quitar un miembro
    await patch(`/api/admin/groups/${g.id}/members`, { remove: [id1] });
    fresh = await Group.findById(g.id);
    expect(fresh?.memberUserIds.map((x) => x.toString())).toEqual([id2]);

    // patch metadata: vaciar email ('' → unset, libera el índice único)
    const meta = await patch(`/api/admin/groups/${g.id}`, { email: '', description: 'equipo' });
    expect(meta.statusCode).toBe(200);
    fresh = await Group.findById(g.id);
    expect(fresh?.email).toBeUndefined();
    // ahora otro grupo PUEDE usar ese email (ya liberado)
    expect(
      (await post('/api/admin/groups', { name: 'Reusa', email: 'ventas@x.com' })).statusCode
    ).toBe(201);

    // lectura filtra miembros a usuarios existentes: borrar u2 → el grupo lo deja de listar
    await User.deleteOne({ _id: u2._id });
    const list = await app.inject({ method: 'GET', url: '/api/admin/groups', headers });
    const ventas = (
      JSON.parse(list.body) as { groups: { id: string; memberCount: number }[] }
    ).groups.find((x) => x.id === g.id);
    expect(ventas?.memberCount).toBe(0); // u2 borrado → filtrado al leer

    // delete + 404 en inexistente
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/admin/groups/${g.id}`, headers })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/admin/groups/${g.id}`, headers })).statusCode
    ).toBe(404);
    await app.close();
  });

  it('validaciones: limpiar descripción, id inválido y payload de miembros excesivo', async () => {
    const app = await buildTestApp();
    const headers = await seedAdmin(app);
    const post = (url: string, payload: unknown) =>
      app.inject({ method: 'POST', url, headers, payload });
    const patch = (url: string, payload: unknown) =>
      app.inject({ method: 'PATCH', url, headers, payload });

    const created = await post('/api/admin/groups', { name: 'X', description: 'algo' });
    const gid = (JSON.parse(created.body) as { id: string }).id;

    // limpiar descripción: '' → queda vacía (review B-LOW)
    expect((await patch(`/api/admin/groups/${gid}`, { description: '' })).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/admin/groups', headers });
    const found = (
      JSON.parse(list.body) as { groups: { id: string; description?: string }[] }
    ).groups.find((x) => x.id === gid);
    expect(found?.description ?? '').toBe('');

    // id inválido → 400 (objectId.parse)
    expect((await patch('/api/admin/groups/notanid/members', { add: [] })).statusCode).toBe(400);

    // payload de miembros excesivo (>2000) → 400 por el .max del schema
    const big = Array.from({ length: 2001 }, () => '1'.repeat(24));
    expect((await patch(`/api/admin/groups/${gid}/members`, { add: big })).statusCode).toBe(400);
    await app.close();
  });
});
