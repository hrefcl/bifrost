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

describe('PATCH /api/auth/me/preferences (firma)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('guarda firma SANEADA + autoInclude, y /me lo refleja', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'sig@test.com' });
    const headers = authHeaders(app, user._id.toString());

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers,
      payload: {
        // El <script> debe quedar STRIPEADO por el sanitizador.
        defaultSignature: '<p>Saludos, <b>Ana</b></p><script>alert(1)</script>',
        autoIncludeSignature: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      defaultSignature: string;
      autoIncludeSignature: boolean;
    };
    expect(body.defaultSignature).toContain('<b>Ana</b>');
    expect(body.defaultSignature).not.toContain('<script>');
    expect(body.autoIncludeSignature).toBe(false);

    // Persistido: GET /me lo devuelve.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    const meBody = JSON.parse(me.body) as {
      preferences: { defaultSignature?: string; autoIncludeSignature: boolean };
    };
    expect(meBody.preferences.defaultSignature).not.toContain('<script>');
    expect(meBody.preferences.autoIncludeSignature).toBe(false);
    await app.close();
  });

  it('sanea vectores XSS en la firma: javascript:, handlers inline, iframe', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'xss@test.com' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: authHeaders(app, user._id.toString()),
      payload: {
        defaultSignature:
          '<a href="javascript:alert(1)">x</a>' +
          '<img src=x onerror="alert(1)">' +
          '<iframe src="https://evil"></iframe>' +
          '<b onclick="evil()">ok</b>',
      },
    });
    expect(res.statusCode).toBe(200);
    const sig = (JSON.parse(res.body) as { defaultSignature: string }).defaultSignature;
    expect(sig).not.toContain('javascript:');
    expect(sig).not.toContain('onerror');
    expect(sig).not.toContain('onclick');
    expect(sig).not.toContain('<iframe');
    await app.close();
  });

  it('rechaza claves inesperadas (.strict → 400, anti mass-assignment)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'sig2@test.com' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: authHeaders(app, user._id.toString()),
      payload: { autoIncludeSignature: true, isAdmin: true },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('User.save() con displayName vacío se auto-cura (pre-validate, no rompe required)', async () => {
    // Regresión del blocker que marcó B: el required corre antes de pre('save'); el hook
    // debe estar en pre('validate') para que un displayName vacío no tire ValidationError.
    const user = new User({ primaryEmail: 'nodisplay@test.com', displayName: '' });
    await expect(user.save()).resolves.toBeDefined();
    expect(user.displayName).toBe('nodisplay');
  });

  it('requiere auth (401 sin token)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      payload: { autoIncludeSignature: true },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // ── Perfil personal (firmas F3) ──
  // 1x1 PNG transparente (data: URL ráster válido, chico).
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('/me/profile: guarda cargo/depto/teléfono y /me lo refleja', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'prof@test.com' });
    const headers = authHeaders(app, user._id.toString());
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/profile',
      headers,
      payload: { jobTitle: 'Gerente', department: 'Comercial', phone: '+56 9 1111 2222' },
    });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    const body = JSON.parse(me.body);
    expect(body.jobTitle).toBe('Gerente');
    expect(body.department).toBe('Comercial');
    expect(body.phone).toBe('+56 9 1111 2222');
    await app.close();
  });

  it('/me/profile: la foto (data:) se EXTERNALIZA a URL interna, nunca queda el data: (H2)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'photo@test.com' });
    const headers = authHeaders(app, user._id.toString());
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/profile',
      headers,
      payload: { photoDataUrl: PNG_1PX },
    });
    expect(res.statusCode).toBe(200);
    const photoUrl = JSON.parse(res.body).photoUrl as string;
    expect(photoUrl).toContain('/api/signature-images/');
    expect(photoUrl).not.toContain('data:');
    await app.close();
  });

  it('/me/profile: rechaza foto inválida (no ráster) con 400', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'badphoto@test.com' });
    const headers = authHeaders(app, user._id.toString());
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/profile',
      headers,
      payload: { photoDataUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('/me/profile: string vacío LIMPIA el campo', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'clr@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { jobTitle: 'Viejo' } });
    const headers = authHeaders(app, user._id.toString());
    await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/profile',
      headers,
      payload: { jobTitle: '' },
    });
    const fresh = await User.findById(user._id).select('jobTitle').lean();
    expect(fresh?.jobTitle).toBeUndefined();
    await app.close();
  });
});
