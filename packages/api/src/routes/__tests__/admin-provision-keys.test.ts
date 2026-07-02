import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { User } from '../../models/User.js';

let app: FastifyInstance;

async function seedAdmin() {
  const { user } = await seedUserWithAccount({ email: 'admin@cleverty.info' });
  await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
  return authHeaders(app, user._id.toString());
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
});

describe('admin: API-keys del provisioning', () => {
  it('POST genera una key y devuelve el token en claro UNA vez', async () => {
    const headers = await seedAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/provision-keys',
      headers,
      payload: { label: 'Vanir' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token.startsWith('bfp_')).toBe(true);
    expect(body.label).toBe('Vanir');
    expect(body.active).toBe(true);
  });

  it('GET lista las keys SIN el token/hash e informa si hay bootstrap', async () => {
    const headers = await seedAdmin();
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/provision-keys',
      headers,
      payload: { label: 'k1' },
    });
    const token = created.json().token;

    const list = await app.inject({ method: 'GET', url: '/api/admin/provision-keys', headers });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].label).toBe('k1');
    // El token real NUNCA vuelve a aparecer.
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain('tokenHash');
    expect(typeof body.bootstrapConfigured).toBe('boolean');
  });

  it('DELETE revoca la key (queda inactiva en la lista) y 404 si no existe', async () => {
    const headers = await seedAdmin();
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/provision-keys',
      headers,
      payload: { label: 'k' },
    });
    const id = created.json().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/provision-keys/${String(id)}`,
      headers,
    });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/admin/provision-keys', headers });
    expect(list.json().keys[0].active).toBe(false);

    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/admin/provision-keys/64b7f0000000000000000000',
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('un usuario sin accounts.manage no puede gestionar keys (403)', async () => {
    const { user } = await seedUserWithAccount({ email: 'plain@cleverty.info' });
    const headers = authHeaders(app, user._id.toString());
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/provision-keys',
      headers,
    });
    expect(res.statusCode).toBe(403);
  });
});
