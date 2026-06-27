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

  it('sin token → /api/admin/whoami responde 401 (auth corre antes que requireAdmin)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/admin/whoami' });
    expect(res.statusCode).toBe(401);
    await app.close();
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

  it('GET /api/admin/config/storage → default local; PATCH lo persiste con updatedBy', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'cfg@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const headers = authHeaders(app, user._id.toString());

    const get = await app.inject({ method: 'GET', url: '/api/admin/config/storage', headers });
    expect(get.statusCode).toBe(200);
    expect((JSON.parse(get.body) as { providerType: string }).providerType).toBe('local');

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers,
      payload: { providerType: 'local' },
    });
    expect(patch.statusCode).toBe(200);
    expect((JSON.parse(patch.body) as { updatedBy: string }).updatedBy).toBe(user._id.toString());
  });

  it('PATCH config/storage con providerType no implementado (s3) → 400', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'cfg2@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
      payload: { providerType: 's3' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('config/storage requiere admin: usuario normal → 403', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'cfg3@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('el auto-registro por login NO crea admins (role default = user)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'auto@test.com' });
    const fresh = await User.findById(user._id).lean();
    expect(fresh?.role).toBe('user');
    await app.close();
  });

  it('PATCH config/storage s3 → 200, persiste el secret CIFRADO y la respuesta lo OMITE (PR-D)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
      payload: {
        providerType: 's3',
        s3: {
          endpoint: 'https://minio.test',
          bucket: 'b',
          region: 'us-east-1',
          accessKeyId: 'AKIA',
          secretAccessKey: 'el-secreto-no-debe-volver',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { s3?: { secretConfigured?: boolean } };
    expect(body.s3?.secretConfigured).toBe(true);
    // El secret en claro NUNCA vuelve en la respuesta.
    expect(res.body).not.toContain('el-secreto-no-debe-volver');

    // GET tampoco lo expone.
    const get = await app.inject({
      method: 'GET',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(get.body).not.toContain('el-secreto-no-debe-volver');
    await app.close();
  });

  it('PATCH config/storage s3 con campos faltantes → 400', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3bad@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
      payload: { providerType: 's3', s3: { bucket: 'b' } }, // falta region/accessKeyId/secret
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PATCH config/storage s3 rechaza endpoint/región peligrosos → 400 (anti-SSRF/inyección)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3ssrf@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const headers = authHeaders(app, user._id.toString());
    const base = { bucket: 'b', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 's' };
    const bad = [
      { ...base, endpoint: 'http://169.254.169.254/' }, // metadata cloud
      { ...base, endpoint: 'ftp://example.com' }, // esquema no http(s)
      { ...base, endpoint: 'https://u:p@example.com' }, // userinfo
      { ...base, endpoint: 'https://example.com/foo?x=1' }, // query/path (hijack de concat)
      { ...base, region: 'us-east-1/../evil' }, // región con charset inválido
    ];
    for (const s3 of bad) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/config/storage',
        headers,
        payload: { providerType: 's3', s3 },
      });
      expect(res.statusCode, JSON.stringify(s3)).toBe(400);
    }
    // En cambio, un MinIO interno (http + host privado, sin path) SÍ se acepta.
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers,
      payload: { providerType: 's3', s3: { ...base, endpoint: 'http://minio:9000' } },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});
