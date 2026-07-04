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
import { invalidateGoogleCredsCache } from '../../services/google/creds.js';

/**
 * Endpoints admin de config de Google Calendar (F-gcal admin-config). Verifica: gate requireAdmin, que el
 * secret NUNCA se expone, el patrón set/clear, y la validación de trío completo.
 */
describe('/api/admin/google-calendar', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => {
    await resetState();
    invalidateGoogleCredsCache();
  });

  async function seedAdmin(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<Record<string, string>> {
    const { user } = await seedUserWithAccount({ email: 'admin@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    return authHeaders(app, user._id.toString());
  }

  it('un usuario NO admin → 403', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'user@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/google-calendar/settings',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET admin (sin config) → source none, sin secret', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/google-calendar/settings',
      headers: await seedAdmin(app),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({
      clientId: '',
      hasClientSecret: false,
      source: 'none',
    });
  });

  it('PATCH trío completo → guarda; el secret NUNCA vuelve por la API', async () => {
    const app = await buildTestApp();
    const headers = await seedAdmin(app);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/google-calendar/settings',
      headers,
      payload: {
        clientId: 'my-client-id',
        redirectUri: 'https://webmail.example/api/calendar/google/callback',
        clientSecret: 'super-secret-value',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain('super-secret-value'); // ni plano
    expect(body).not.toMatch(/ciphertext/i); // ni ciphertext
    expect(res.json().settings).toMatchObject({
      clientId: 'my-client-id',
      redirectUri: 'https://webmail.example/api/calendar/google/callback',
      hasClientSecret: true,
      source: 'db',
    });
  });

  it('PATCH con secret pero SIN clientId/redirectUri → 400 (trío incompleto)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/google-calendar/settings',
      headers: await seedAdmin(app),
      payload: { clientSecret: 'orphan-secret' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH clientSecret="" limpia el secret (vuelve a no configurado)', async () => {
    const app = await buildTestApp();
    const headers = await seedAdmin(app);
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/google-calendar/settings',
      headers,
      payload: {
        clientId: 'id',
        redirectUri: 'https://x.example/api/calendar/google/callback',
        clientSecret: 's',
      },
    });
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/admin/google-calendar/settings',
      headers,
      payload: { clientSecret: '' },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().settings.hasClientSecret).toBe(false);
    expect(cleared.json().settings.source).toBe('none'); // trío incompleto → no db, sin env → none
  });

  it('limpiar clientId con un secret existente NO deja el secret huérfano (acople)', async () => {
    const app = await buildTestApp();
    const headers = await seedAdmin(app);
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/google-calendar/settings',
      headers,
      payload: {
        clientId: 'id',
        redirectUri: 'https://x.example/api/calendar/google/callback',
        clientSecret: 's',
      },
    });
    // Limpio SÓLO el clientId (sin tocar el secret): el secret debe caer también (sin huérfano).
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/google-calendar/settings',
      headers,
      payload: { clientId: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.hasClientSecret).toBe(false);
    expect(res.json().settings.source).toBe('none');
  });
});
