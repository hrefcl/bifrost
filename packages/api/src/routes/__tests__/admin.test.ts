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

describe('admin role + requireAdmin (PR-A)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('usuario normal → /api/admin/whoami responde 403 (feature-gate backend)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'normal@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/whoami',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('admin → /api/admin/whoami responde 200', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'admin@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/whoami',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ role: 'admin' });
    await app.close();
  });

  it('requireAdmin consulta la DB: cambiar el rol en DB invalida el acceso aunque el token siga', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'demote@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const headers = authHeaders(app, user._id.toString());
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/whoami', headers })).statusCode
    ).toBe(200);
    // Degradado en DB (mismo token) → 403.
    await User.updateOne({ _id: user._id }, { $set: { role: 'user' } });
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/whoami', headers })).statusCode
    ).toBe(403);
    await app.close();
  });

  it('el auto-registro por login NO crea admins (role default = user)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'auto@test.com' });
    const fresh = await User.findById(user._id).lean();
    expect(fresh?.role).toBe('user');
    await app.close();
  });
});
