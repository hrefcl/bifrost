import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

const h = vi.hoisted(() => ({ lastRaw: '' }));

vi.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: (opts: { raw?: Buffer | string }) => {
      h.lastRaw = opts.raw?.toString() ?? '';
      return Promise.resolve({ messageId: '<smtp@test>' });
    },
    close: () => undefined,
  }),
}));

vi.mock('imapflow', () => {
  class ImapFlow {
    constructor(_o: unknown) {}
    connect(): Promise<void> {
      return Promise.resolve();
    }
    logout(): Promise<void> {
      return Promise.resolve();
    }
    append(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ImapFlow };
});

import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';

const attDir = path.join(tmpdir(), `bifrost-draft-att-${randomUUID()}`);

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

async function upload(app: FastifyInstance, userId: string, filename: string, content: Buffer) {
  const mp = multipart(filename, 'application/octet-stream', content);
  const res = await app.inject({
    method: 'POST',
    url: '/api/attachments',
    headers: { ...authHeaders(app, userId), 'content-type': mp.contentType },
    payload: mp.body,
  });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { id: string }).id;
}

describe('adjuntos en drafts + envío (PR-C2)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.ATTACHMENTS_DIR = attDir;
    await setupTestDb();
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    await rm(attDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetState();
    h.lastRaw = '';
  });

  it('crea draft con attachmentIds propios → persiste metadata + providerType', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const uid = user._id.toString();
    const blobId = await upload(app, uid, 'doc.pdf', Buffer.from('hola adjunto'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: authHeaders(app, uid),
      payload: {
        accountId: account._id.toString(),
        to: [{ address: 'x@test.com' }],
        attachmentIds: [blobId],
      },
    });
    expect(res.statusCode).toBe(200);
    const draft = JSON.parse(res.body) as {
      attachments: Record<string, unknown>[];
    };
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0].filename).toBe('doc.pdf');
    expect(draft.attachments[0].blobId).toBe(blobId);
    // El DTO público NO debe filtrar localizadores internos de storage.
    expect(draft.attachments[0].storageKey).toBeUndefined();
    expect(draft.attachments[0].providerType).toBeUndefined();
  });

  it('DEDUP: el mismo blobId repetido se adjunta UNA sola vez', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const uid = user._id.toString();
    const blobId = await upload(app, uid, 'a.txt', Buffer.from('aaa'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: authHeaders(app, uid),
      payload: {
        accountId: account._id.toString(),
        to: [{ address: 'x@test.com' }],
        attachmentIds: [blobId, blobId, blobId],
      },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { attachments: unknown[] }).attachments).toHaveLength(1);
  });

  it('MASS-ASSIGNMENT: filename/size/storageKey/attachments en el body se ignoran', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const uid = user._id.toString();
    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: authHeaders(app, uid),
      payload: {
        accountId: account._id.toString(),
        to: [{ address: 'x@test.com' }],
        // Intento de inyectar adjuntos sin pasar por attachmentIds/ownership.
        attachments: [{ filename: 'evil.sh', size: 9, storageKey: '../../etc/passwd' }],
        storageKey: 'hack',
      },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { attachments: unknown[] }).attachments).toHaveLength(0);
  });

  it('OWNERSHIP: adjuntar el blob de OTRO usuario → 404 (sin filtrar existencia)', async () => {
    const { user: owner } = await seedUserWithAccount({ email: 'owner@test.com' });
    const { user: other, account: otherAcc } = await seedUserWithAccount({
      email: 'other@test.com',
    });
    const foreignBlob = await upload(app, owner._id.toString(), 'secreto.txt', Buffer.from('x'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: authHeaders(app, other._id.toString()),
      payload: {
        accountId: otherAcc._id.toString(),
        to: [{ address: 'x@test.com' }],
        attachmentIds: [foreignBlob],
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH attachmentIds=[] limpia los adjuntos del draft', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const uid = user._id.toString();
    const blobId = await upload(app, uid, 'a.txt', Buffer.from('aaa'));
    const created = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: authHeaders(app, uid),
      payload: {
        accountId: account._id.toString(),
        to: [{ address: 'x@test.com' }],
        attachmentIds: [blobId],
      },
    });
    const draftId = (JSON.parse(created.body) as { id: string }).id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/drafts/${draftId}`,
      headers: authHeaders(app, uid),
      payload: { attachmentIds: [] },
    });
    expect(patched.statusCode).toBe(200);
    expect((JSON.parse(patched.body) as { attachments: unknown[] }).attachments).toHaveLength(0);
  });

  it('LEASE: no se puede adjuntar un blob que el GC marcó "deleting" → 404', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'lease@test.com' });
    const uid = user._id.toString();
    const blobId = await upload(app, uid, 'x.txt', Buffer.from('x'));
    // El GC tomó el lease del blob (status deleting).
    const { AttachmentBlob } = await import('../../models/AttachmentBlob.js');
    await AttachmentBlob.updateOne({ _id: blobId }, { $set: { status: 'deleting' } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: authHeaders(app, uid),
      payload: {
        accountId: account._id.toString(),
        to: [{ address: 'x@test.com' }],
        attachmentIds: [blobId],
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('ANTI-DoS: más de 25 attachmentIds → 400 (gate del schema, antes de tocar la DB)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const uid = user._id.toString();
    // 26 ObjectIds válidos pero inexistentes: el schema .max(25) corta antes del lookup.
    const ids = Array.from({ length: 26 }, (_, i) => i.toString(16).padStart(24, '0'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: authHeaders(app, uid),
      payload: {
        accountId: account._id.toString(),
        to: [{ address: 'x@test.com' }],
        attachmentIds: ids,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SEND: el raw incluye el adjunto (filename + bytes del provider de origen)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const uid = user._id.toString();
    const content = Buffer.from('ATTACH-ME-PAYLOAD-1234567890');
    const blobId = await upload(app, uid, 'reporte.bin', content);
    const created = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: authHeaders(app, uid),
      payload: {
        accountId: account._id.toString(),
        to: [{ address: 'dest@test.com' }],
        subject: 's',
        bodyText: 'cuerpo',
        attachmentIds: [blobId],
      },
    });
    const draftId = (JSON.parse(created.body) as { id: string }).id;

    const sent = await app.inject({
      method: 'POST',
      url: `/api/drafts/${draftId}/send`,
      headers: authHeaders(app, uid),
    });
    expect(sent.statusCode).toBe(200);
    // MailComposer codifica el adjunto en base64 dentro del raw MIME.
    expect(h.lastRaw).toContain('reporte.bin');
    expect(h.lastRaw).toContain(content.toString('base64'));
  });
});
