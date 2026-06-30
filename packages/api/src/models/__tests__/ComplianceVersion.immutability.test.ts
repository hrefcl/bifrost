import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { ComplianceVersion, ComplianceImmutabilityError } from '../ComplianceVersion.js';

/**
 * Inmutabilidad e indelebilidad de versiones publicadas (DESIGN §2.2; fixes D-001..D-004).
 * Cubre: transición ilegal en save(), TOCTOU evitado por acotado atómico a draft, paths de borrado.
 */
describe('ComplianceVersion immutability/indelibility', () => {
  let server: MongoMemoryServer;
  const docId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    await ComplianceVersion.deleteMany({ status: 'draft' });
    await mongoose.connection.db!.collection('complianceversions').deleteMany({});
  });

  async function makePublished(version = 1) {
    const v = await ComplianceVersion.create({
      tenantId: 'default',
      documentId: docId,
      documentKey: 'terms-of-service',
      version,
      status: 'draft',
      contents: [{ locale: 'es', title: 'T', bodyMarkdown: 'A', bodyHtml: '<p>A</p>' }],
      contentHash: 'h1',
      effectiveAt: new Date('2026-01-01T00:00:00Z'),
    });
    v.status = 'published';
    v.publishedAt = new Date();
    await v.save(); // draft→published permitido
    return v._id;
  }

  it('draft: permite editar contenido', async () => {
    const v = await ComplianceVersion.create({
      tenantId: 'default',
      documentId: docId,
      documentKey: 'terms-of-service',
      version: 1,
      status: 'draft',
      contents: [{ locale: 'es', title: 'T', bodyMarkdown: 'A', bodyHtml: '' }],
      contentHash: 'h1',
      effectiveAt: new Date('2026-01-01T00:00:00Z'),
    });
    v.contents[0].bodyMarkdown = 'B';
    await expect(v.save()).resolves.toBeDefined();
  });

  it('published: save() con mutación de contenido lanza ComplianceImmutabilityError', async () => {
    const id = await makePublished();
    const v = await ComplianceVersion.findById(id);
    v!.contents[0].bodyMarkdown = 'HACKED';
    await expect(v!.save()).rejects.toBeInstanceOf(ComplianceImmutabilityError);
  });

  it('published: save() intentando volver a draft lanza error', async () => {
    const id = await makePublished();
    const v = await ComplianceVersion.findById(id);
    v!.status = 'draft';
    await expect(v!.save()).rejects.toBeInstanceOf(ComplianceImmutabilityError);
  });

  it('published→archived (sin tocar contenido) está permitido', async () => {
    const id = await makePublished();
    const v = await ComplianceVersion.findById(id);
    v!.status = 'archived';
    await expect(v!.save()).resolves.toBeDefined();
  });

  it('published: updateOne con cambio de contenido NO muta (acotado atómico a draft)', async () => {
    const id = await makePublished();
    const res = await ComplianceVersion.updateOne({ _id: id }, { $set: { contentHash: 'TAMPER' } });
    expect(res.matchedCount).toBe(0);
    const after = await ComplianceVersion.findById(id).lean();
    expect(after!.contentHash).toBe('h1');
  });

  it('published: findOneAndUpdate des-publicando NO muta', async () => {
    const id = await makePublished();
    const res = await ComplianceVersion.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'draft' } },
      { new: true }
    );
    expect(res).toBeNull();
    const after = await ComplianceVersion.findById(id).lean();
    expect(after!.status).toBe('published');
  });

  it('published: deleteOne (query) NO borra (indeleble)', async () => {
    const id = await makePublished();
    const res = await ComplianceVersion.deleteOne({ _id: id });
    expect(res.deletedCount).toBe(0);
    expect(await ComplianceVersion.findById(id)).not.toBeNull();
  });

  it('published: doc.deleteOne() (document) lanza error', async () => {
    const id = await makePublished();
    const v = await ComplianceVersion.findById(id);
    await expect(v!.deleteOne()).rejects.toBeInstanceOf(ComplianceImmutabilityError);
    expect(await ComplianceVersion.findById(id)).not.toBeNull();
  });

  it('deleteMany sobre filtro mixto sólo borra drafts (D-004), no publicadas', async () => {
    const pubId = await makePublished(1);
    await ComplianceVersion.create({
      tenantId: 'default',
      documentId: docId,
      documentKey: 'terms-of-service',
      version: 2,
      status: 'draft',
      contents: [{ locale: 'es', title: 'T', bodyMarkdown: 'D', bodyHtml: '' }],
      contentHash: 'h2',
      effectiveAt: new Date('2026-02-01T00:00:00Z'),
    });
    // Filtro amplio (todas las del documento): el hook lo acota a draft.
    const res = await ComplianceVersion.deleteMany({ documentId: docId });
    expect(res.deletedCount).toBe(1); // sólo la draft
    expect(await ComplianceVersion.findById(pubId)).not.toBeNull(); // la publicada sobrevive
  });

  it('published: aggregation-pipeline update NO muta (D P0b residual #1)', async () => {
    const id = await makePublished();
    const res = await ComplianceVersion.updateOne({ _id: id }, [
      { $set: { contentHash: 'PIPELINE_TAMPER' } },
    ]);
    expect(res.matchedCount).toBe(0);
    const after = await ComplianceVersion.findById(id).lean();
    expect(after!.contentHash).toBe('h1');
  });

  it('published: doc.deleteOne() tras mutar status=draft en memoria lanza error (D P0b residual #2)', async () => {
    const id = await makePublished();
    const v = await ComplianceVersion.findById(id);
    v!.status = 'draft'; // intento de bypass mutando el valor en memoria
    await expect(v!.deleteOne()).rejects.toBeInstanceOf(ComplianceImmutabilityError);
    expect(await ComplianceVersion.findById(id)).not.toBeNull();
  });

  it('published: bypasses por operador NO mutan (dot-path/$unset/$inc/$push) — B P0c HIGH-1', async () => {
    const id = await makePublished();
    await ComplianceVersion.updateOne({ _id: id }, { $set: { 'contents.0.bodyHtml': '<x>' } });
    await ComplianceVersion.updateOne({ _id: id }, { $unset: { contentHash: '' } });
    await ComplianceVersion.updateOne({ _id: id }, { $inc: { version: 1 } });
    await ComplianceVersion.updateOne({ _id: id }, { $set: { documentKey: 'other' } });
    const after = await ComplianceVersion.findById(id).lean();
    expect(after!.contentHash).toBe('h1');
    expect(after!.version).toBe(1);
    expect(after!.documentKey).toBe('terms-of-service');
    expect(after!.contents[0].bodyHtml).toBe('<p>A</p>');
  });

  it('published: save() cambiando un campo NO-contenido lanza (freeze total) — B P0c HIGH-2', async () => {
    const id = await makePublished();
    const v = await ComplianceVersion.findById(id);
    v!.authorEmail = 'attacker@evil.test';
    await expect(v!.save()).rejects.toBeInstanceOf(ComplianceImmutabilityError);
    const v2 = await ComplianceVersion.findById(id);
    v2!.pipelineVersion = 'tampered';
    await expect(v2!.save()).rejects.toBeInstanceOf(ComplianceImmutabilityError);
  });

  it('archived es terminal: ningún cambio permitido', async () => {
    const id = await makePublished();
    const v = await ComplianceVersion.findById(id);
    v!.status = 'archived';
    await v!.save(); // published→archived OK
    const a = await ComplianceVersion.findById(id);
    a!.status = 'published'; // intento de revivir
    await expect(a!.save()).rejects.toBeInstanceOf(ComplianceImmutabilityError);
  });

  it('un draft SÍ se puede actualizar y borrar', async () => {
    const v = await ComplianceVersion.create({
      tenantId: 'default',
      documentId: docId,
      documentKey: 'terms-of-service',
      version: 9,
      status: 'draft',
      contents: [{ locale: 'es', title: 'T', bodyMarkdown: 'X', bodyHtml: '' }],
      contentHash: 'h9',
      effectiveAt: new Date('2026-03-01T00:00:00Z'),
    });
    const upd = await ComplianceVersion.updateOne({ _id: v._id }, { $set: { contentHash: 'h9b' } });
    expect(upd.matchedCount).toBe(1);
    const del = await ComplianceVersion.deleteOne({ _id: v._id });
    expect(del.deletedCount).toBe(1);
  });
});
