import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { AttachmentBlob } from '../../models/AttachmentBlob.js';
import { Draft } from '../../models/Draft.js';
import { cleanupOrphanAttachments } from '../drafts.js';

const attDir = path.join(tmpdir(), `bifrost-gc-test-${randomUUID()}`);

async function makeBlob(
  userId: string,
  opts: { ageMs?: number; providerType?: 'local' | 's3' } = {}
) {
  const blob = await AttachmentBlob.create({
    storageKey: randomUUID(),
    providerType: opts.providerType ?? 'local',
    userId,
    filename: 'f.txt',
    contentType: 'text/plain',
    size: 1,
    refCount: 1,
  });
  if (opts.ageMs) {
    // Driver nativo: mongoose ignora un $set de createdAt (campo gestionado por timestamps).
    await AttachmentBlob.collection.updateOne(
      { _id: blob._id },
      { $set: { createdAt: new Date(Date.now() - opts.ageMs) } }
    );
  }
  return blob;
}

async function makeDraft(
  userId: string,
  accountId: string,
  status: 'editing' | 'failed' | 'sending' | 'sent',
  blobId: string
) {
  return Draft.create({
    userId,
    accountId,
    to: [{ address: 'x@test.com' }],
    subject: 's',
    status,
    lastModifiedAt: new Date(),
    attachments: [
      {
        blobId,
        filename: 'f.txt',
        contentType: 'text/plain',
        size: 1,
        storageKey: randomUUID(),
        providerType: 'local',
      },
    ],
  });
}

describe('cleanupOrphanAttachments — mark-and-sweep de blobs huérfanos', () => {
  beforeAll(async () => {
    process.env.ATTACHMENTS_DIR = attDir;
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
    await rm(attDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetState();
  });

  it('huérfano viejo (sin draft) → se borra', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000 });
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(1);
    expect(await AttachmentBlob.findById(blob._id)).toBeNull();
  });

  it('huérfano RECIENTE (dentro de la gracia) → NO se borra', async () => {
    const { user } = await seedUserWithAccount({ email: 'b@test.com' });
    const blob = await makeBlob(user._id.toString(), { ageMs: 0 });
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(0);
    expect(await AttachmentBlob.findById(blob._id)).not.toBeNull();
  });

  it('referenciado por un draft editing → NO se borra (aunque sea viejo)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'c@test.com' });
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000 });
    await makeDraft(user._id.toString(), account._id.toString(), 'editing', blob._id.toString());
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(0);
    expect(await AttachmentBlob.findById(blob._id)).not.toBeNull();
  });

  it('referenciado SÓLO por un draft sent → se borra (la copia vive en IMAP Sent)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'd@test.com' });
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000 });
    await makeDraft(user._id.toString(), account._id.toString(), 'sent', blob._id.toString());
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(1);
    expect(await AttachmentBlob.findById(blob._id)).toBeNull();
  });

  it('referenciado por un draft sending → NO se borra (se está leyendo)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'e@test.com' });
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000 });
    await makeDraft(user._id.toString(), account._id.toString(), 'sending', blob._id.toString());
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(0);
    expect(await AttachmentBlob.findById(blob._id)).not.toBeNull();
  });

  it('best-effort: si el borrado del provider falla, el doc NO se elimina (reintenta luego)', async () => {
    const { user } = await seedUserWithAccount({ email: 'f@test.com' });
    // providerType 's3' sin s3 configurado → providerForType('s3') lanza → doc se conserva.
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000, providerType: 's3' });
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(0);
    expect(await AttachmentBlob.findById(blob._id)).not.toBeNull();
  });
});
