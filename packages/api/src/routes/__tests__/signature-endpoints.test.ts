import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { setSignaturePolicy } from '../../services/signature-policy.js';

async function auth() {
  const app = await buildTestApp();
  const { user } = await seedUserWithAccount({ email: 'sig@test.com' });
  return { app, headers: authHeaders(app, user._id.toString()) };
}

describe('PATCH /api/auth/me/signature (elección de firma)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('200: guarda source/templateId/includePhoto válidos', async () => {
    const { app, headers } = await auth();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/signature',
      headers,
      payload: { source: 'template', templateId: 'horizontal', includePhoto: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('template');
    expect(body.templateId).toBe('horizontal');
    expect(body.includePhoto).toBe(false);
  });

  it('400: templateId inexistente', async () => {
    const { app, headers } = await auth();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/signature',
      headers,
      payload: { templateId: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400: templateId válido pero NO habilitado por la política', async () => {
    const { app, headers } = await auth();
    await setSignaturePolicy({ allowedTemplateIds: ['minimal'] });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/signature',
      headers,
      payload: { templateId: 'horizontal' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('no habilitado');
  });

  it('400: source=custom cuando la política lo prohíbe (fix L1)', async () => {
    const { app, headers } = await auth();
    await setSignaturePolicy({ allowCustomHtml: false });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/signature',
      headers,
      payload: { source: 'custom' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('personalizada');
  });

  it('200: source=custom cuando la política lo permite (default)', async () => {
    const { app, headers } = await auth();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/signature',
      headers,
      payload: { source: 'custom' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('custom');
  });

  it('400: rechaza campo extra (.strict anti mass-assign)', async () => {
    const { app, headers } = await auth();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/signature',
      headers,
      payload: { source: 'template', evil: true },
    });
    expect(res.statusCode).toBe(400);
  });
});
