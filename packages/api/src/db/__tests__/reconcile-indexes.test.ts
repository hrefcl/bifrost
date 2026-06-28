import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  reconcileLegacyIndexes,
  reconcileEmailUidIndex,
  reconcileEmailTextIndex,
} from '../reconcile-indexes.js';
import { EMAIL_TEXT_INDEX } from '../../models/email-indexes.js';

describe('reconcileLegacyIndexes (F3.2 / H-DATA-TTL)', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  it('dropea el índice TTL legado users.createdAt_1', async () => {
    const coll = mongoose.connection.db!.collection('users');
    await coll.createIndex({ createdAt: 1 }, { expireAfterSeconds: 63072000 });
    expect((await coll.indexes()).some((i) => i.name === 'createdAt_1')).toBe(true);

    await reconcileLegacyIndexes();

    expect((await coll.indexes()).some((i) => i.name === 'createdAt_1')).toBe(false);
  });

  it('NO toca un índice no-TTL con el mismo nombre', async () => {
    const coll = mongoose.connection.db!.collection('drafts');
    // índice normal (sin expireAfterSeconds) sobre lastModifiedAt
    await coll.createIndex({ lastModifiedAt: 1 });
    expect((await coll.indexes()).some((i) => i.name === 'lastModifiedAt_1')).toBe(true);

    await reconcileLegacyIndexes();

    // sigue presente: sólo se dropean índices TTL reales
    expect((await coll.indexes()).some((i) => i.name === 'lastModifiedAt_1')).toBe(true);
  });

  it('es idempotente / no falla si la colección no existe', async () => {
    await expect(reconcileLegacyIndexes()).resolves.toBeUndefined();
  });

  it('reconcileEmailUidIndex dedupea {accountId,folderId,uid} y crea el índice único', async () => {
    const coll = mongoose.connection.db!.collection('emails');
    // Quitar el índice único si existe, para poder insertar duplicados legacy.
    try {
      await coll.dropIndex('accountId_1_folderId_1_uid_1');
    } catch {
      /* no existe aún */
    }
    const accountId = new mongoose.Types.ObjectId();
    const folderId = new mongoose.Types.ObjectId();
    await coll.insertMany([
      { accountId, folderId, uid: 1, subject: 'dup-a' },
      { accountId, folderId, uid: 1, subject: 'dup-b' },
      { accountId, folderId, uid: 2, subject: 'unique' },
    ]);
    expect(await coll.countDocuments({ accountId, folderId })).toBe(3);

    await reconcileEmailUidIndex();

    // El duplicado (uid:1) quedó colapsado a 1; uid:2 intacto.
    expect(await coll.countDocuments({ accountId, folderId, uid: 1 })).toBe(1);
    expect(await coll.countDocuments({ accountId, folderId })).toBe(2);
    // El índice único existe.
    const idx = await coll.indexes();
    const unique = idx.find((i) => i.name === 'accountId_1_folderId_1_uid_1');
    expect(unique?.unique).toBe(true);
  });

  it('reconcileEmailTextIndex: dropea un email_text_search legado (sin from.name) y recrea la spec actual', async () => {
    const coll = mongoose.connection.db!.collection('emails');
    try {
      await coll.dropIndex(EMAIL_TEXT_INDEX.name);
    } catch {
      /* no existe aún */
    }
    // Índice de texto LEGADO: sin from.name y con pesos antiguos.
    await coll.createIndex(
      { accountId: 1, subject: 'text', preview: 'text', 'from.address': 'text' },
      { name: EMAIL_TEXT_INDEX.name, weights: { subject: 10, preview: 5, 'from.address': 3 } }
    );
    const legacy = (await coll.indexes()).find((i) => i.name === EMAIL_TEXT_INDEX.name);
    expect(legacy?.weights?.['from.name']).toBeUndefined();

    await reconcileEmailTextIndex();

    // Tras reconciliar: el índice tiene la spec actual, incluido from.name con su peso.
    const after = (await coll.indexes()).find((i) => i.name === EMAIL_TEXT_INDEX.name);
    expect(after?.weights?.['from.name']).toBe(EMAIL_TEXT_INDEX.weights['from.name']);
  });

  it('reconcileEmailTextIndex: NO toca un índice ya actualizado (idempotente)', async () => {
    const coll = mongoose.connection.db!.collection('emails');
    try {
      await coll.dropIndex(EMAIL_TEXT_INDEX.name);
    } catch {
      /* no existe */
    }
    await coll.createIndex(EMAIL_TEXT_INDEX.key as Record<string, 1 | 'text'>, {
      name: EMAIL_TEXT_INDEX.name,
      weights: EMAIL_TEXT_INDEX.weights,
    });
    const before = (await coll.indexes()).find((i) => i.name === EMAIL_TEXT_INDEX.name);

    await reconcileEmailTextIndex();

    const after = (await coll.indexes()).find((i) => i.name === EMAIL_TEXT_INDEX.name);
    // Mismos pesos (no se recreó innecesariamente).
    expect(after?.weights).toEqual(before?.weights);
  });
});
