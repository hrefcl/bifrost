import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { User } from '../../models/User.js';

let app: FastifyInstance;
const LOGO = 'data:image/png;base64,iVBORw0KGgo=';

async function seedAdmin() {
  const { user } = await seedUserWithAccount({ email: 'admin@cleverty.info' });
  await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
  return authHeaders(app, user._id.toString());
}

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

describe('admin: editor de firmas (settings combinado + preview + logo vertical)', () => {
  it('PUT /config/signature-settings guarda branding + política juntos', async () => {
    const headers = await seedAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/signature-settings',
      headers,
      payload: {
        branding: { accentColor: '#00aa55', companyName: 'ACME', logoVerticalDataUrl: LOGO },
        policy: { allowedTemplateIds: ['clasica'], lockTemplate: true },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.lockTemplate).toBe(true);
    // El branding se refleja en la vista pública, incluido el logo vertical.
    const pub = await app.inject({ method: 'GET', url: '/api/branding' });
    expect(pub.json().accentColor).toBe('#00aa55');
    expect(pub.json().logoVerticalDataUrl).toBe(LOGO);
  });

  it('ATÓMICO-FIRST: política inválida → 400 y el branding NO se toca', async () => {
    const headers = await seedAdmin();
    // branding conocido previo
    await app.inject({
      method: 'PUT',
      url: '/api/admin/config/branding',
      headers,
      payload: { accentColor: '#ff0000' },
    });
    // settings con política inválida (lockTemplate sin templates) + branding distinto
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/signature-settings',
      headers,
      payload: {
        branding: { accentColor: '#0000ff' },
        policy: { lockTemplate: true, allowedTemplateIds: [] },
      },
    });
    expect(res.statusCode).toBe(400);
    // El branding sigue siendo el previo → NO se escribió nada (validación antes del write).
    const pub = await app.inject({ method: 'GET', url: '/api/branding' });
    expect(pub.json().accentColor).toBe('#ff0000');
  });

  it('POST /config/signature-preview rinde con overrides sin guardar', async () => {
    const headers = await seedAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/config/signature-preview',
      headers,
      payload: { templateId: 'clasica', accentColor: '#123456', companyName: 'PreviewCo' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().html).toContain('PreviewCo');
    // El override NO se persiste (era preview).
    const pub = await app.inject({ method: 'GET', url: '/api/branding' });
    expect(pub.json().companyName).not.toBe('PreviewCo');
  });

  it('preview: acepta appStoreUrl/googlePlayUrl para previsualizar los badges del template Cleverty (HIGH de D)', async () => {
    const headers = await seedAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/config/signature-preview',
      headers,
      payload: {
        templateId: 'cleverty',
        appStoreUrl: 'https://apps.apple.com/app',
        googlePlayUrl: 'https://play.google.com/store/app',
      },
    });
    expect(res.statusCode).toBe(200); // antes: 400 por schema .strict() sin esos campos
    expect(res.json().html).toContain('App Store');
    expect(res.json().html).toContain('Google Play');
  });

  it('preview: signatureStyle oculta campos y reordena (firma componible)', async () => {
    const headers = await seedAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/signature-settings',
      headers,
      payload: {
        branding: {
          companyName: 'ACME',
          signatureStyle: {
            hidden: ['company', 'photo'],
            order: ['email', 'name'],
            fontFamily: 'Georgia',
          },
        },
        policy: { allowedTemplateIds: ['clasica'], lockTemplate: false },
      },
    });
    expect(res.statusCode).toBe(200);
    // El preview refleja el estilo: sin empresa, fuente Georgia.
    const prev = await app.inject({
      method: 'POST',
      url: '/api/admin/config/signature-preview',
      headers,
      payload: { templateId: 'clasica' },
    });
    expect(prev.statusCode).toBe(200);
    const html = prev.json().html as string;
    expect(html).toContain('Georgia'); // tipografía aplicada
    expect(html).not.toContain('ACME'); // empresa oculta
  });

  it('preview: rechaza signatureStyle inválido (fontFamily fuera del enum) → 400', async () => {
    const headers = await seedAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/config/signature-preview',
      headers,
      payload: { templateId: 'clasica', signatureStyle: { fontFamily: 'ComicSans' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('preview: acepta null para limpiar el logo (consistencia con branding)', async () => {
    const headers = await seedAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/config/signature-preview',
      headers,
      payload: { templateId: 'clasica', logoDataUrl: null, logoVerticalDataUrl: null },
    });
    expect(res.statusCode).toBe(200);
  });

  it('requiere branding.manage (un usuario plano → 403)', async () => {
    const { user } = await seedUserWithAccount({ email: 'plain@cleverty.info' });
    const headers = authHeaders(app, user._id.toString());
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/config/signature-settings',
      headers,
      payload: { branding: {}, policy: {} },
    });
    expect(res.statusCode).toBe(403);
  });
});
