import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, buildTestApp } from '../../../test/integration-helper.js';

describe('setup', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('reports that setup is not required when env vars are present', async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.setupRequired).toBe(false);
    expect(body.missing).toEqual([]);
  });
});
