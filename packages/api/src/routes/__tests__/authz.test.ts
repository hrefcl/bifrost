import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
  seedAccountFor,
  seedFolder,
  seedEmail,
} from '../../../test/integration-helper.js';
import type { FastifyInstance } from 'fastify';

/**
 * F3.1 — Aislamiento multi-tenant. Por cada endpoint que recibe un ID de
 * recurso, el usuario B NO debe acceder a recursos del usuario A (404, sin
 * filtrar existencia). El dueño mantiene 200.
 */
describe('authz multi-tenant (F3.1)', () => {
  let app: FastifyInstance;

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

  async function fixtures() {
    const a = await seedUserWithAccount({ email: 'alice@test.com' });
    const b = await seedUserWithAccount({ email: 'bob@test.com' });
    const folderA = await seedFolder(a.account._id);
    const emailA = await seedEmail(a.account._id, folderA._id, { uid: 10 });
    return { a, b, folderA, emailA };
  }

  it('GET /emails/:id — dueño 200, ajeno 404', async () => {
    const { a, b, emailA } = await fixtures();
    const own = await app.inject({
      method: 'GET',
      url: `/api/emails/${emailA._id.toString()}`,
      headers: authHeaders(app, a.user._id.toString()),
    });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: 'GET',
      url: `/api/emails/${emailA._id.toString()}`,
      headers: authHeaders(app, b.user._id.toString()),
    });
    expect(other.statusCode).toBe(404);
  });

  it('GET /accounts/:id/folders — dueño 200, ajeno 404', async () => {
    const { a, b } = await fixtures();
    const own = await app.inject({
      method: 'GET',
      url: `/api/accounts/${a.account._id.toString()}/folders`,
      headers: authHeaders(app, a.user._id.toString()),
    });
    expect(own.statusCode).toBe(200);
    expect(JSON.parse(own.body)).toHaveLength(1);

    const other = await app.inject({
      method: 'GET',
      url: `/api/accounts/${a.account._id.toString()}/folders`,
      headers: authHeaders(app, b.user._id.toString()),
    });
    expect(other.statusCode).toBe(404);
  });

  it('GET /accounts/:id/folders/:fid/emails — dueño 200, ajeno 404', async () => {
    const { a, b, folderA } = await fixtures();
    const own = await app.inject({
      method: 'GET',
      url: `/api/accounts/${a.account._id.toString()}/folders/${folderA._id.toString()}/emails`,
      headers: authHeaders(app, a.user._id.toString()),
    });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: 'GET',
      url: `/api/accounts/${a.account._id.toString()}/folders/${folderA._id.toString()}/emails`,
      headers: authHeaders(app, b.user._id.toString()),
    });
    expect(other.statusCode).toBe(404);
  });

  it('accountId propio + folderId de OTRA cuenta del mismo user → 404 (caso B)', async () => {
    const { a } = await fixtures();
    const account2 = await seedAccountFor(a.user._id, 'alice-2@test.com');
    const folder2 = await seedFolder(account2._id, { name: 'Work', path: 'Work' });

    // Pide con accountId de la cuenta 1 pero folderId de la cuenta 2 (ambas de Alice)
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${a.account._id.toString()}/folders/${folder2._id.toString()}/emails`,
      headers: authHeaders(app, a.user._id.toString()),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /calendar con accountId ajeno → 404', async () => {
    const { a, b } = await fixtures();
    const res = await app.inject({
      method: 'POST',
      url: '/api/calendar',
      headers: authHeaders(app, b.user._id.toString()),
      payload: {
        accountId: a.account._id.toString(),
        calendarId: 'c1',
        calendarName: 'Cal',
        uid: 'evt-1',
        summary: 'Hijack',
        startDate: '2026-01-01T10:00:00.000Z',
        endDate: '2026-01-01T11:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /accounts/:id/sync/folders ajeno → 404 (antes de tocar IMAP)', async () => {
    const { a, b } = await fixtures();
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${a.account._id.toString()}/sync/folders`,
      headers: authHeaders(app, b.user._id.toString()),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /accounts/:id/folders/:fid/sync ajeno → 404 (antes de tocar IMAP)', async () => {
    const { a, b, folderA } = await fixtures();
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${a.account._id.toString()}/folders/${folderA._id.toString()}/sync`,
      headers: authHeaders(app, b.user._id.toString()),
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /calendar/:id cambiando accountId a uno ajeno → 404', async () => {
    const { a, b } = await fixtures();
    // Evento legítimo de B
    const create = await app.inject({
      method: 'POST',
      url: '/api/calendar',
      headers: authHeaders(app, b.user._id.toString()),
      payload: {
        accountId: b.account._id.toString(),
        calendarId: 'c1',
        calendarName: 'Cal',
        uid: 'evt-b',
        summary: 'Mine',
        startDate: '2026-01-01T10:00:00.000Z',
        endDate: '2026-01-01T11:00:00.000Z',
      },
    });
    expect(create.statusCode).toBe(200);
    const eventId = (JSON.parse(create.body) as { id: string }).id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${eventId}`,
      headers: authHeaders(app, b.user._id.toString()),
      payload: { accountId: a.account._id.toString() },
    });
    expect(res.statusCode).toBe(404);
  });

  // Estos prueban que el setErrorHandler (ZodError→400) sí aplica a las rutas
  // bajo /api (regresión: antes salía 500 por orden de registro del handler).
  it('GET /api/emails/:id con ObjectId malformado → 400 (no 500)', async () => {
    const { a } = await fixtures();
    const res = await app.inject({
      method: 'GET',
      url: '/api/emails/not-an-object-id',
      headers: authHeaders(app, a.user._id.toString()),
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET folders/:fid/emails con paginación inválida → 400 (limit no numérico, no 500)', async () => {
    const { a, folderA } = await fixtures();
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${a.account._id.toString()}/folders/${folderA._id.toString()}/emails?limit=nan`,
      headers: authHeaders(app, a.user._id.toString()),
    });
    expect(res.statusCode).toBe(400);
  });
});
