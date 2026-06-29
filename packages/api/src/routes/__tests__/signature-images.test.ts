import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { SignatureImage } from '../../models/SignatureImage.js';

// PNG 1x1 transparente (base64) — imagen ráster válida mínima.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('firma: externalizar imágenes data: + servirlas público', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('PATCH preferences con firma data:image → se reemplaza por URL hosteada + se sube', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'firma@test.com' });
    const sig = `<p>hola</p><img src="data:image/png;base64,${PNG_1X1}">`;
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers: authHeaders(app, user._id.toString()),
      payload: { defaultSignature: sig },
    });
    expect(res.statusCode).toBe(200);
    const saved = (JSON.parse(res.body) as { defaultSignature: string }).defaultSignature;
    // El data: ya NO está; quedó una URL pública /api/signature-images/<id>.
    expect(saved).not.toContain('data:image');
    expect(saved).toMatch(/\/api\/signature-images\/[a-f0-9]{24}/);
    // Se creó el SignatureImage del usuario.
    const imgs = await SignatureImage.find({ userId: user._id });
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.contentType).toBe('image/png');

    // La ruta pública sirve los bytes (sin auth).
    const id = imgs[0]?._id.toString();
    const img = await app.inject({ method: 'GET', url: `/api/signature-images/${id}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('dedup: la misma imagen guardada dos veces no duplica el SignatureImage', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'dedup@test.com' });
    const sig = `<img src="data:image/png;base64,${PNG_1X1}">`;
    const headers = authHeaders(app, user._id.toString());
    await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers,
      payload: { defaultSignature: sig },
    });
    await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/preferences',
      headers,
      payload: { defaultSignature: sig },
    });
    expect(await SignatureImage.countDocuments({ userId: user._id })).toBe(1);
    await app.close();
  });
});
