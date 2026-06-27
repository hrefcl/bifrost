import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';

const attDir = path.join(tmpdir(), `bifrost-att-test-${randomUUID()}`);

function multipart(filename: string, contentType: string, content: Buffer) {
  const boundary = '----biftest';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('adjuntos: upload + download (PR-C1)', () => {
  beforeAll(async () => {
    process.env.ATTACHMENTS_DIR = attDir; // storage local en un tmp aislado
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
    await rm(attDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetState();
  });

  it('upload → crea blob dueño del usuario; download propio devuelve los bytes + headers seguros', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'owner@test.com' });
    const headers = authHeaders(app, user._id.toString());
    const content = Buffer.from('contenido del adjunto 📎', 'utf-8');
    const mp = multipart('reporte.pdf', 'application/pdf', content);

    const up = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...headers, 'content-type': mp.contentType },
      payload: mp.body,
    });
    expect(up.statusCode).toBe(200);
    const blob = JSON.parse(up.body) as { id: string; filename: string; size: number };
    expect(blob.filename).toBe('reporte.pdf');
    expect(blob.size).toBe(content.length);

    const dl = await app.inject({ method: 'GET', url: `/api/attachments/${blob.id}`, headers });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(content)).toBe(true);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toContain('attachment');
    await app.close();
  });

  it('IDOR: un usuario NO puede bajar el adjunto de otro (404)', async () => {
    const app = await buildTestApp();
    const { user: owner } = await seedUserWithAccount({ email: 'a@test.com' });
    const { user: other } = await seedUserWithAccount({ email: 'b@test.com' });
    const mp = multipart('secreto.txt', 'text/plain', Buffer.from('top secret'));
    const up = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...authHeaders(app, owner._id.toString()), 'content-type': mp.contentType },
      payload: mp.body,
    });
    const blobId = (JSON.parse(up.body) as { id: string }).id;
    const dl = await app.inject({
      method: 'GET',
      url: `/api/attachments/${blobId}`,
      headers: authHeaders(app, other._id.toString()),
    });
    expect(dl.statusCode).toBe(404);
    await app.close();
  });

  it('requiere auth: upload/download sin token → 401', async () => {
    const app = await buildTestApp();
    const mp = multipart('x.txt', 'text/plain', Buffer.from('x'));
    const up = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { 'content-type': mp.contentType },
      payload: mp.body,
    });
    expect(up.statusCode).toBe(401);
    await app.close();
  });
});
