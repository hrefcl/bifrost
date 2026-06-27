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
    // El GC filtra por lastReferencedAt. Driver nativo para createdAt (timestamps lo gestiona).
    const old = new Date(Date.now() - opts.ageMs);
    await AttachmentBlob.collection.updateOne(
      { _id: blob._id },
      { $set: { createdAt: old, lastReferencedAt: old } }
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

  it('referenciado por un draft sent → NO se borra (appendToSent es best-effort; no se asume copia)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'd@test.com' });
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000 });
    await makeDraft(user._id.toString(), account._id.toString(), 'sent', blob._id.toString());
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(0);
    expect(await AttachmentBlob.findById(blob._id)).not.toBeNull();
  });

  it('referenciado por un draft sending → NO se borra (se está leyendo)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'e@test.com' });
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000 });
    await makeDraft(user._id.toString(), account._id.toString(), 'sending', blob._id.toString());
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(0);
    expect(await AttachmentBlob.findById(blob._id)).not.toBeNull();
  });

  it('best-effort: si el provider falla, el doc se conserva y el lease vuelve a active (reintenta)', async () => {
    const { user } = await seedUserWithAccount({ email: 'f@test.com' });
    // providerType 's3' sin s3 configurado → providerForType('s3') lanza → doc se conserva.
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000, providerType: 's3' });
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(0);
    const after = await AttachmentBlob.findById(blob._id);
    expect(after).not.toBeNull();
    // El lease NO debe quedar colgado en 'deleting' (si no, nunca se reintentaría).
    expect(after?.status).toBe('active');
  });

  it('LEASE: un blob tocado por un attach (lastReferencedAt fresco) NO se borra aunque createdAt sea viejo', async () => {
    const { user } = await seedUserWithAccount({ email: 'g@test.com' });
    const blob = await makeBlob(user._id.toString(), { ageMs: 120_000 });
    // Simula el "claim" de resolveAttachments: bump de lastReferencedAt a ahora.
    await AttachmentBlob.updateOne({ _id: blob._id }, { $set: { lastReferencedAt: new Date() } });
    const n = await cleanupOrphanAttachments(60_000);
    expect(n).toBe(0);
    expect(await AttachmentBlob.findById(blob._id)).not.toBeNull();
  });
});
