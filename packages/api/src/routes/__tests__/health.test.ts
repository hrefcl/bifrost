import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, buildTestApp } from '../../../test/integration-helper.js';
import { redis } from '../../config/redis.js';

describe('health', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
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
});
