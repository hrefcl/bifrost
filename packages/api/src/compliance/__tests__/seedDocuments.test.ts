import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { ComplianceDocument } from '../../models/ComplianceDocument.js';
import { ComplianceVersion } from '../../models/ComplianceVersion.js';
import { seedComplianceDocuments } from '../seedDocuments.js';
import { getPendingForUser } from '../../services/compliance.js';

describe('seedComplianceDocuments', () => {
  let server: MongoMemoryServer;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
  });

  it('siembra 7 documentos system con una versión publicada, soft (no bloquea)', async () => {
    const created = await seedComplianceDocuments();
    expect(created).toBe(7);
    const docs = await ComplianceDocument.find({ system: true }).lean();
    expect(docs).toHaveLength(7);
    for (const d of docs) {
      expect(d.enforcement).toBe('soft');
      expect(d.currentVersionNumber).toBe(1);
      expect(d.system).toBe(true);
    }
    // Términos tiene ambas locales con HTML saneado.
    const terms = await ComplianceVersion.findOne({
      documentKey: 'terms-of-service',
      status: 'published',
    }).lean();
    expect(terms!.contents.map((c) => c.locale).sort()).toEqual(['en', 'es']);
    expect(terms!.contents[0].bodyHtml).toContain('<h1>');
  });

  it('es idempotente: re-sembrar no crea duplicados', async () => {
    await seedComplianceDocuments();
    const again = await seedComplianceDocuments();
    expect(again).toBe(0);
    expect(await ComplianceDocument.countDocuments()).toBe(7);
  });

  it('el seed NO bloquea a ningún usuario (todo soft, enforcement none efectivo)', async () => {
    await seedComplianceDocuments();
    const user = { id: new mongoose.Types.ObjectId(), role: 'user' as const };
    const res = await getPendingForUser('default', user);
    expect(res.enforcement).toBe('none'); // ningún bloqueante
    // Aparecen como soft informativos.
    expect(res.documents.every((d) => d.blocking === false)).toBe(true);
  });
});
