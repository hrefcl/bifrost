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
import { _resetGateSnapshot } from '../compliance-gate.js';

const PAST = () => new Date(Date.now() - 86_400_000).toISOString();

describe('compliance gate', () => {
  let app: FastifyInstance;
  let userId: string;
  let adminId: string;

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
    _resetGateSnapshot();
    delete process.env.COMPLIANCE_ENFORCEMENT_DISABLED;
    const u = await User.create({ primaryEmail: 'u@t.com', displayName: 'U', role: 'user' });
    const a = await User.create({ primaryEmail: 'a@t.com', displayName: 'A', role: 'admin' });
    userId = u._id.toString();
    adminId = a._id.toString();
  });

  async function makeBlocking(enforcement: 'block_full' | 'block_partial') {
    const create = await app.inject({
      method: 'POST',
      url: '/api/compliance/admin/documents',
      headers: authHeaders(app, adminId),
      payload: { key: 'terms-of-service', category: 'legal', title: 'T', enforcement: 'soft' },
    });
    const docId = JSON.parse(create.body).document._id;
    const ver = await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/documents/${docId}/versions`,
      headers: authHeaders(app, adminId),
      payload: {
        contents: [{ locale: 'es', title: 'T', bodyMarkdown: '# A' }],
        effectiveAt: PAST(),
        requiresReacceptance: true,
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/compliance/admin/versions/${JSON.parse(ver.body).version._id}/publish`,
      headers: authHeaders(app, adminId),
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/compliance/admin/documents/${docId}`,
      headers: authHeaders(app, adminId),
      payload: { enforcement },
    });
    _resetGateSnapshot(); // el PATCH bumpea epoch; refrescamos el snapshot del gate en el test
  }

  it('sin documentos enforced: el gate no bloquea (fast-path)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/',
      headers: authHeaders(app, userId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('block_full pendiente: bloquea una ruta de negocio con 403 COMPLIANCE_REQUIRED', async () => {
    await makeBlocking('block_full');
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/',
      headers: authHeaders(app, userId),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('COMPLIANCE_REQUIRED');
  });

  it('block_full: las rutas de compliance (skipCompliance) NO se bloquean', async () => {
    await makeBlocking('block_full');
    const pending = await app.inject({
      method: 'GET',
      url: '/api/compliance/pending',
      headers: authHeaders(app, userId),
    });
    expect(pending.statusCode).toBe(200);
  });

  it('block_full: tras aceptar, la ruta de negocio deja de bloquearse', async () => {
    await makeBlocking('block_full');
    await app.inject({
      method: 'POST',
      url: '/api/compliance/accept',
      headers: authHeaders(app, userId),
      payload: { documentKey: 'terms-of-service', version: 1 },
    });
    _resetGateSnapshot();
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/',
      headers: authHeaders(app, userId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('block_partial: GET (read) pasa, POST (write) bloquea', async () => {
    await makeBlocking('block_partial');
    const get = await app.inject({
      method: 'GET',
      url: '/api/accounts/',
      headers: authHeaders(app, userId),
    });
    expect(get.statusCode).toBe(200);
    // POST a una ruta de negocio mutante → bloqueado (complianceEffect default 'write').
    const post = await app.inject({
      method: 'POST',
      url: '/api/accounts/',
      headers: authHeaders(app, userId),
      payload: {},
    });
    expect(post.statusCode).toBe(403);
    expect(JSON.parse(post.body).code).toBe('COMPLIANCE_REQUIRED');
  });

  it('kill-switch: COMPLIANCE_ENFORCEMENT_DISABLED=1 desactiva el gate', async () => {
    await makeBlocking('block_full');
    process.env.COMPLIANCE_ENFORCEMENT_DISABLED = '1';
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/',
      headers: authHeaders(app, userId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rutas públicas (requiresAuth:false) no se gatean aunque haya block_full', async () => {
    await makeBlocking('block_full');
    const res = await app.inject({ method: 'GET', url: '/api/config/mail-server' });
    expect(res.statusCode).toBe(200);
  });

  it('admin con block_full role:all también es bloqueado en rutas de negocio', async () => {
    await makeBlocking('block_full');
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/',
      headers: authHeaders(app, adminId),
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /auth/me NO se bloquea bajo block_full (anti-deadlock del restore, B P3)', async () => {
    await makeBlocking('block_full');
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeaders(app, userId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('block_partial: la caché por-usuario NO permite un POST tras un GET (D-003 correctness)', async () => {
    await makeBlocking('block_partial');
    // Primero un GET (read) que pasa; NO debe cachear al user como conforme (tiene partial pendiente).
    const get = await app.inject({
      method: 'GET',
      url: '/api/accounts/',
      headers: authHeaders(app, userId),
    });
    expect(get.statusCode).toBe(200);
    // El POST (write) inmediato sigue bloqueado (la caché no lo marcó conforme).
    const post = await app.inject({
      method: 'POST',
      url: '/api/accounts/',
      headers: authHeaders(app, userId),
      payload: {},
    });
    expect(post.statusCode).toBe(403);
  });
});
