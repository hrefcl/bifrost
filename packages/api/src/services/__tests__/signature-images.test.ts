import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetState } from '../../../test/integration-helper.js';
import { storeDataImage, externalizeDataImages, MAX_IMG_BYTES } from '../signature-images.js';
import { SignatureImage } from '../../models/SignatureImage.js';

const BASE = 'https://mail.example.com';
const UID = '507f1f77bcf86cd799439011'; // ObjectId hex válido (el modelo tipa userId como ObjectId)
const rasterB64 = (seed: string) => Buffer.from(`raster-${seed}`).toString('base64');
const dataImg = (seed: string) => `data:image/png;base64,${rasterB64(seed)}`;

describe('signature-images: storeDataImage', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => await resetState());

  it('acepta data:image ráster → URL interna /api/signature-images/:id', async () => {
    const url = await storeDataImage(UID, dataImg('ok'), BASE);
    expect(url).toMatch(/^https:\/\/mail\.example\.com\/api\/signature-images\/[a-f0-9]{24}$/);
  });

  it('RECHAZA una URL remota (H2: nunca un tracker externo) → null', async () => {
    expect(await storeDataImage(UID, 'https://evil.com/pixel.png', BASE)).toBeNull();
    expect(await storeDataImage(UID, '//evil.com/pixel.png', BASE)).toBeNull();
  });

  it('RECHAZA data: no-ráster (svg/text/html) → null', async () => {
    expect(
      await storeDataImage(
        UID,
        'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
        BASE
      )
    ).toBeNull();
    expect(
      await storeDataImage(
        UID,
        'data:text/html;base64,' + Buffer.from('<script>').toString('base64'),
        BASE
      )
    ).toBeNull();
  });

  it('RECHAZA imágenes > MAX_IMG_BYTES → null', async () => {
    const big = Buffer.alloc(MAX_IMG_BYTES + 1).toString('base64');
    expect(await storeDataImage(UID, `data:image/png;base64,${big}`, BASE)).toBeNull();
  });

  it('dedup: el mismo contenido no crea dos docs', async () => {
    const a = await storeDataImage(UID, dataImg('dup'), BASE);
    const b = await storeDataImage(UID, dataImg('dup'), BASE);
    expect(a).toBe(b);
    expect(await SignatureImage.countDocuments({ userId: UID })).toBe(1);
  });
});

describe('signature-images: externalizeDataImages', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => await resetState());

  it('reemplaza el data: ráster embebido por una URL hosteada', async () => {
    const html = `<img src="${dataImg('embed')}" alt="logo"/>`;
    const out = await externalizeDataImages(UID, html, BASE);
    expect(out).not.toContain('data:image/png;base64');
    expect(out).toMatch(/\/api\/signature-images\/[a-f0-9]{24}/);
    expect(await SignatureImage.countDocuments({ userId: UID })).toBe(1);
  });

  it('respeta el tope anti-DoS de 10 imágenes embebidas', async () => {
    const imgs = Array.from({ length: 11 }, (_, i) => `<img src="${dataImg(String(i))}"/>`).join(
      ''
    );
    const out = await externalizeDataImages(UID, imgs, BASE);
    // Sólo 10 se externalizan (se persisten); la 11ª queda como data: en el HTML.
    expect(await SignatureImage.countDocuments({ userId: UID })).toBe(10);
    expect(out).toContain('data:image/png;base64');
  });

  it('salta las imágenes no-ráster y las sobre-tamaño (no las persiste)', async () => {
    const big = Buffer.alloc(MAX_IMG_BYTES + 1).toString('base64');
    const html =
      `<img src="data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}"/>` +
      `<img src="data:image/png;base64,${big}"/>`;
    const out = await externalizeDataImages(UID, html, BASE);
    expect(await SignatureImage.countDocuments({ userId: UID })).toBe(0);
    // El svg queda como estaba (el sanitizer de salida lo filtra después).
    expect(out).toContain('svg+xml');
  });
});
