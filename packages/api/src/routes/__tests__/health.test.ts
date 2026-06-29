import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { redis } from '../../config/redis.js';
import { Account } from '../../models/Account.js';

describe('health', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok when dependencies are healthy', async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.services.mongodb).toBe('connected');
    expect(body.services.redis).toBe('connected');
    // SEGURIDAD: /health es público → NO debe filtrar build/sha (anti fingerprinting de instalaciones).
    expect(body.version).toBeUndefined();
  });

  // Failure-path: el liveness probe DEBE devolver 503 (no 200) ante una dependencia caída,
  // o el orquestador nunca reiniciaría una instancia zombi (outage silencioso). Se mockea
  // la dependencia caída para fijar ese contrato y atrapar una regresión a "always-200".
  it('returns 503 when Redis is down', async () => {
    const app = await buildTestApp();
    vi.spyOn(redis, 'ping').mockRejectedValueOnce(new Error('redis down'));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('degraded');
    expect(body.services.redis).toBe('disconnected');
    expect(body.services.mongodb).toBe('connected');
  });

  // /health/ready: readiness con salud del sync IMAP derivada de Account.status (re-audit HIGH de D).
  it('/ready: 200 + sync.status=ok cuando las cuentas están active', async () => {
    const app = await buildTestApp();
    const { account } = await seedUserWithAccount({ email: 'rdy@test.com' });
    await Account.updateOne({ _id: account._id }, { status: 'active', lastSyncedAt: new Date() });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ready');
    expect(body.sync.status).toBe('ok');
    expect(body.sync.accounts).toBe(1);
    expect(body.sync.active).toBe(1);
    expect(body.sync.error).toBe(0);
  });

  it('/ready: sigue 200 pero sync.status=degraded si una cuenta está en error (no saca el pod de rotación)', async () => {
    const app = await buildTestApp();
    const ok = await seedUserWithAccount({ email: 'rdy-ok@test.com' });
    const bad = await seedUserWithAccount({ email: 'rdy-bad@test.com' });
    await Account.updateOne(
      { _id: ok.account._id },
      { status: 'active', lastSyncedAt: new Date() }
    );
    await Account.updateOne(
      { _id: bad.account._id },
      { status: 'error', lastError: 'IMAP auth failed' }
    );
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200); // Mongo/Redis OK → el pod PUEDE servir
    const body = JSON.parse(res.body);
    expect(body.sync.status).toBe('degraded');
    expect(body.sync.error).toBe(1);
    expect(body.sync.accounts).toBe(2);
    // NO se filtra lastError crudo en el endpoint público (info-leak).
    expect(JSON.stringify(body)).not.toContain('IMAP auth failed');
  });

  it('/ready: 503 si Redis está caído (dep dura)', async () => {
    const app = await buildTestApp();
    vi.spyOn(redis, 'ping').mockRejectedValueOnce(new Error('redis down'));
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).status).toBe('not-ready');
  });
});
