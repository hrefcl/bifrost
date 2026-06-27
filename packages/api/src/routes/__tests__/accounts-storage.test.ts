import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { AttachmentBlob } from '../../models/AttachmentBlob.js';

/**
 * GET /api/accounts/storage — barra de almacenamiento del sidebar. `usedBytes` debe ser la suma
 * REAL de los adjuntos ACTIVOS del usuario, contando SÓLO los propios (per-user, no cross-tenant).
 */
describe('GET /api/accounts/storage', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  function blob(userId: string, size: number, status: 'active' | 'deleting' = 'active') {
    return {
      storageKey: `k-${userId}-${String(size)}-${status}`,
      providerType: 'local' as const,
      userId,
      filename: 'f.bin',
      contentType: 'application/octet-stream',
      size,
      status,
    };
  }

  it('suma sólo los bytes ACTIVOS del PROPIO usuario; respeta el límite configurable', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'me@test.com' });
    const { user: other } = await seedUserWithAccount({ email: 'other@test.com' });

    await AttachmentBlob.create([
      blob(user._id.toString(), 1000),
      blob(user._id.toString(), 500),
      blob(user._id.toString(), 9999, 'deleting'), // 'deleting' no cuenta como uso disponible
      blob(other._id.toString(), 7777), // de OTRO usuario → NO debe contarse
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/storage',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { usedBytes: number; limitBytes: number };
    expect(body.usedBytes).toBe(1500); // 1000 + 500 (ni el 'deleting' ni el de otro)
    expect(body.limitBytes).toBeGreaterThan(0);
    await app.close();
  });

  it('requiere autenticación', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/accounts/storage' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
