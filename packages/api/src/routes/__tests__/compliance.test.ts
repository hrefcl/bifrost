import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
} from '../../../test/integration-helper.js';
import { User } from '../../models/User.js';

const FUTURE_OFF = () => new Date(Date.now() - 86_400_000).toISOString(); // ayer (vigente ya)

describe('compliance routes', () => {
  let app: FastifyInstance;
  let adminId: string;
  let userId: string;

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
    const admin = await User.create({
      primaryEmail: 'admin@test.com',
      displayName: 'Admin',
      role: 'admin',
    });
    const user = await User.create({
      primaryEmail: 'user@test.com',
      displayName: 'User',
      role: 'user',
    });
    adminId = admin._id.toString();
    userId = user._id.toString();
  });

  async function createPublishedBlockingDoc() {
    const create = await app.inject({
      method: 'POST',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, adminId),
      // audience role:user → bloquea al usuario (lo que testeamos) pero NO al admin que ejecuta las
      // operaciones admin (export/verify), que con el gate registrado quedaría bloqueado si fuera 'all'.
      payload: {
        key: 'terms-of-service',
        category: 'legal',
        title: 'Términos',
        enforcement: 'soft',
        audience: 'role:user',
      },
    });
    const docId = JSON.parse(create.body).document._id;
    const ver = await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/documents/${docId}/versions`,
      headers: authHeaders(app, adminId),
      payload: {
        contents: [{ locale: 'es', title: 'T', bodyMarkdown: '# Hola\n\nTexto.' }],
        effectiveAt: FUTURE_OFF(),
        requiresReacceptance: true,
      },
    });
    const versionId = JSON.parse(ver.body).version._id;
    await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/versions/${versionId}/publish`,
      headers: authHeaders(app, adminId),
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/compliance/admin/documents/${docId}`,
      headers: authHeaders(app, adminId),
      payload: { enforcement: 'block_full' },
    });
    return docId;
  }

  it('admin crea/publica documento; user lo ve pendiente, acepta y deja de estar pendiente', async () => {
    await createPublishedBlockingDoc();

    const pending1 = await app.inject({
      method: 'GET',
      url: '/api/compliance/pending',
      headers: authHeaders(app, userId),
    });
    const p1 = JSON.parse(pending1.body);
    expect(p1.enforcement).toBe('block_full');
    expect(p1.documents).toHaveLength(1);

    const accept = await app.inject({
      method: 'POST',
      url: '/api/compliance/accept',
      headers: authHeaders(app, userId),
      payload: { documentKey: 'terms-of-service', version: 1, locale: 'es' },
    });
    expect(accept.statusCode).toBe(200);

    const pending2 = await app.inject({
      method: 'GET',
      url: '/api/compliance/pending',
      headers: authHeaders(app, userId),
    });
    expect(JSON.parse(pending2.body).documents).toHaveLength(0);
  });

  it('GET /documents/:key devuelve bodyHtml saneado', async () => {
    await createPublishedBlockingDoc();
    const res = await app.inject({
      method: 'GET',
      url: '/api/compliance/documents/terms-of-service?locale=es',
      headers: authHeaders(app, userId),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).bodyHtml).toContain('<h1>Hola</h1>');
  });

  it('accept de versión equivocada → 409 con code VERSION_STALE', async () => {
    await createPublishedBlockingDoc();
    const res = await app.inject({
      method: 'POST',
      url: '/api/compliance/accept',
      headers: authHeaders(app, userId),
      payload: { documentKey: 'terms-of-service', version: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('VERSION_STALE');
  });

  it('un usuario NO admin no puede acceder a rutas admin → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, userId),
    });
    expect(res.statusCode).toBe(403);
  });

  it('export CSV de aceptaciones con header y guard de inyección', async () => {
    await createPublishedBlockingDoc();
    await app.inject({
      method: 'POST',
      url: '/api/compliance/accept',
      headers: authHeaders(app, userId),
      payload: { documentKey: 'terms-of-service', version: 1 },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/compliance/admin/acceptances?format=csv',
      headers: authHeaders(app, adminId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('userEmail,documentKey,version');
    expect(res.body).toContain('user@test.com');
  });

  it('verify de una aceptación → valid true', async () => {
    await createPublishedBlockingDoc();
    await app.inject({
      method: 'POST',
      url: '/api/compliance/accept',
      headers: authHeaders(app, userId),
      payload: { documentKey: 'terms-of-service', version: 1 },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/compliance/admin/acceptances',
      headers: authHeaders(app, adminId),
    });
    const accId = JSON.parse(list.body).acceptances[0]._id;
    const verify = await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/acceptances/${accId}/verify`,
      headers: authHeaders(app, adminId),
    });
    expect(JSON.parse(verify.body).valid).toBe(true);
  });

  it('PATCH a block_* sin versión publicada → 409 NO_PUBLISHED_VERSION', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, adminId),
      payload: { key: 'cookie-policy', category: 'cookies', title: 'Cookies' },
    });
    const docId = JSON.parse(create.body).document._id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/compliance/admin/documents/${docId}`,
      headers: authHeaders(app, adminId),
      payload: { enforcement: 'block_full' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('NO_PUBLISHED_VERSION');
  });

  it('requiere auth: sin token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/compliance/pending' });
    expect(res.statusCode).toBe(401);
  });

  it('non-admin no puede crear documento (write admin) → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, userId),
      payload: { key: 'x-policy', category: 'custom', title: 'X' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('un user NO puede ver ni aceptar un documento de audiencia role:admin → 404', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, adminId),
      payload: {
        key: 'admin-only',
        category: 'custom',
        title: 'Admin',
        enforcement: 'soft',
        audience: 'role:admin',
      },
    });
    const docId = JSON.parse(create.body).document._id;
    const ver = await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/documents/${docId}/versions`,
      headers: authHeaders(app, adminId),
      payload: {
        contents: [{ locale: 'es', title: 'T', bodyMarkdown: '# A' }],
        effectiveAt: FUTURE_OFF(),
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/versions/${JSON.parse(ver.body).version._id}/publish`,
      headers: authHeaders(app, adminId),
    });
    const view = await app.inject({
      method: 'GET',
      url: '/api/compliance/documents/admin-only',
      headers: authHeaders(app, userId),
    });
    expect(view.statusCode).toBe(404);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/compliance/accept',
      headers: authHeaders(app, userId),
      payload: { documentKey: 'admin-only', version: 1 },
    });
    expect(accept.statusCode).toBe(404);
  });

  it('CSV neutraliza inyección de fórmula en user-agent', async () => {
    await createPublishedBlockingDoc();
    await app.inject({
      method: 'POST',
      url: '/api/compliance/accept',
      headers: { ...authHeaders(app, userId), 'user-agent': '=cmd|calc!A1' },
      payload: { documentKey: 'terms-of-service', version: 1 },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/compliance/admin/acceptances?format=csv',
      headers: authHeaders(app, adminId),
    });
    // El user-agent malicioso queda neutralizado: prefijado con ' y entrecomillado por el `|`/`!`.
    expect(res.body).toContain("'=cmd");
    expect(res.body).not.toMatch(/,=cmd/); // nunca una celda que empiece con = sin prefijo
  });

  it('GET /documents NO enumera documentos de audiencia role:admin para un user (D-001)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, adminId),
      payload: {
        key: 'admin-secret',
        category: 'custom',
        title: 'Secreto',
        enforcement: 'soft',
        audience: 'role:admin',
      },
    });
    const ver = await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/documents/${JSON.parse(create.body).document._id}/versions`,
      headers: authHeaders(app, adminId),
      payload: {
        contents: [{ locale: 'es', title: 'T', bodyMarkdown: '# A' }],
        effectiveAt: FUTURE_OFF(),
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/versions/${JSON.parse(ver.body).version._id}/publish`,
      headers: authHeaders(app, adminId),
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/compliance/documents',
      headers: authHeaders(app, userId),
    });
    const keys = JSON.parse(list.body).documents.map((d: { key: string }) => d.key);
    expect(keys).not.toContain('admin-secret');
  });

  it('mass-assignment: campo extra (system) en crear documento → 400 (.strict)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, adminId),
      payload: { key: 'evil', category: 'custom', title: 'X', system: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validación: body inválido en crear documento → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, adminId),
      payload: { key: 'BAD KEY!', category: 'nope', title: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});
