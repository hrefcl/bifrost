import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { reconcileEmailTextIndex } from '../reconcile-indexes.js';
import { Email } from '../../models/Email.js';

/**
 * Regresión END-TO-END del upgrade del índice de texto (review B): no basta con que el reconcile
 * deje los pesos correctos — lo que importa es que, tras un upgrade desde una DB que ya tenía el
 * índice LEGADO (sin `from.name`), la BÚSQUEDA POR NOMBRE DEL REMITENTE realmente funcione. Antes
 * del fix, esa búsqueda devolvía 0 silenciosamente. Aquí se simula el upgrade y se busca de verdad.
 *
 * `autoIndex: false` para controlar los índices manualmente (si no, Mongoose intentaría crear el
 * índice canónico al conectar y chocaría con el legado que sembramos a propósito).
 */
describe('reconcileEmailTextIndex — búsqueda por remitente tras upgrade (regresión B)', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri(), { autoIndex: false });
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  it('upgrade de índice legado (sin from.name) → la búsqueda $text por from.name encuentra el email', async () => {
    const coll = mongoose.connection.db!.collection('emails');

    // DB EXISTENTE: índice de texto legado SIN from.name.
    await coll.createIndex(
      { accountId: 1, subject: 'text', preview: 'text', 'from.address': 'text' },
      { name: 'email_text_search', weights: { subject: 10, preview: 5, 'from.address': 3 } }
    );
    const accountId = new mongoose.Types.ObjectId();
    const folderId = new mongoose.Types.ObjectId();
    await coll.insertOne({
      accountId,
      folderId,
      uid: 1,
      messageId: 'm1',
      from: { name: 'Banco Galicia', address: 'no-reply@banco.com' },
      to: [],
      subject: 'Resumen mensual',
      preview: 'su resumen',
      date: new Date(),
      internalDate: new Date(),
      size: 1,
      flags: {},
      hasAttachments: false,
      attachmentCount: 0,
      bodyCached: false,
    });

    // Antes del reconcile: el índice legado NO indexa from.name → buscar por el nombre da 0.
    const before = await Email.find({ accountId, $text: { $search: 'Galicia' } });
    expect(before).toHaveLength(0);

    // Reconcile (lo que corre el arranque en una DB existente).
    await reconcileEmailTextIndex();

    // Ahora la búsqueda por NOMBRE del remitente sí encuentra el email.
    const after = await Email.find({ accountId, $text: { $search: 'Galicia' } });
    expect(after).toHaveLength(1);
    expect(after[0]?.subject).toBe('Resumen mensual');
  });
});
