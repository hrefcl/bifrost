import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  buildTestSetupApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';

describe('test harness (F3.0)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('buildSetupApp serves /setup/status', async () => {
    const app = await buildTestSetupApp();
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('seedUserWithAccount + authHeaders authenticates GET /accounts', async () => {
    const app = await buildTestApp();
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ id: string; email: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(account._id.toString());
    expect(body[0].email).toBe('owner@test.com');
    await app.close();
  });

  it('rejects unauthenticated request to /accounts', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/metrics expone métricas Prometheus (sin auth)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('webmail_requests_total');
    expect(res.body).toContain('webmail_uptime_seconds');
    // Histograma de latencia (señal SRE).
    expect(res.body).toContain('webmail_request_duration_seconds_bucket');
    expect(res.body).toContain('webmail_request_duration_seconds_count');
    await app.close();
  });

  it('rejects a validly-signed token without userId (defense-in-depth)', async () => {
    const app = await buildTestApp();
    // Token firmado por la app pero con payload sin userId.
    const token = app.jwt.sign({} as { userId: string });
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
