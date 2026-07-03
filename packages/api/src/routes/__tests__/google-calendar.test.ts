import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';

/**
 * Endpoints de Google Calendar (F-gcal G2). En el entorno de test la feature NO está configurada
 * (sin GOOGLE_*), así que se verifica el FEATURE-GATE, la protección de sesión y que el callback es
 * público (requiresAuth:false) y SIEMPRE redirige (nunca filtra un error crudo al navegador).
 */
describe('/api/calendar/google (F-gcal G2)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => await resetState());

  it('GET /status sin sesión → 401', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/calendar/google/status' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /status autenticado (feature apagada) → configured:false, connected:false', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'g1@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/calendar/google/status',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, connected: false });
  });

  it('GET /connect con la feature apagada → 503 (no se expone)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'g2@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/calendar/google/connect',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET /callback es público y SIEMPRE redirige (error de Google → ?google=error)', async () => {
    const app = await buildTestApp();
    // Sin headers de sesión: no debe dar 401 (requiresAuth:false).
    const res = await app.inject({
      method: 'GET',
      url: '/api/calendar/google/callback?error=access_denied',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('google=error');
  });

  it('POST /disconnect es idempotente (sin conexión previa → ok)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'g3@test.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/calendar/google/disconnect',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
});
