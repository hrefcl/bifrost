import mongoose from 'mongoose';

type ObjectId = mongoose.Types.ObjectId;

/**
 * Migración para el índice único {accountId, folderId, uid} de emails (F3.4 / TD-4):
 * deduplica filas legacy (deja una por clave) y crea el índice. Sin esto, en una DB
 * con duplicados preexistentes la creación del índice único fallaría al arrancar.
 * Idempotente; en DB fresh es un no-op.
 */
export async function reconcileEmailUidIndex(): Promise<void> {
  const coll = mongoose.connection.db?.collection('emails');
  if (!coll) return;

  const dups = (await coll
    .aggregate([
      {
        $group: {
          _id: { a: '$accountId', f: '$folderId', u: '$uid' },
          ids: { $push: '$_id' },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray()) as { ids: ObjectId[] }[];

  for (const d of dups) {
    const [, ...extra] = d.ids; // conservar el primero, borrar el resto
    if (extra.length > 0) await coll.deleteMany({ _id: { $in: extra } });
  }

  await coll.createIndex({ accountId: 1, folderId: 1, uid: 1 }, { unique: true });
}

/**
 * Dropea índices TTL legados que se eliminaron del esquema (H-DATA-TTL).
 *
 * Mongoose con autoIndex sólo CREA índices declarados; nunca dropea los que
 * existen en Mongo pero ya no están en el esquema. En despliegues que corrieron
 * con los TTL `users.createdAt_1` (2 años) y `drafts.lastModifiedAt_1` (30 días),
 * MongoDB seguiría borrando datos silenciosamente. Esta función los elimina —
 * de forma idempotente y sólo si efectivamente son índices TTL — al arrancar.
 */
export async function reconcileLegacyIndexes(): Promise<void> {
  const legacyTtl: { collection: string; index: string }[] = [
    { collection: 'users', index: 'createdAt_1' },
    { collection: 'drafts', index: 'lastModifiedAt_1' },
  ];

  const db = mongoose.connection.db;
  if (!db) return;

  for (const { collection, index } of legacyTtl) {
    const coll = db.collection(collection);
    let indexes;
    try {
      indexes = await coll.indexes();
    } catch (err) {
      // Sólo se ignora "colección inexistente" (DB fresh). Cualquier otro error
      // (conexión, permisos) propaga: no queremos enmascarar un TTL que sigue vivo.
      if ((err as { codeName?: string }).codeName === 'NamespaceNotFound') continue;
      throw err;
    }
    const ttl = indexes.find((i) => i.name === index && typeof i.expireAfterSeconds === 'number');
    if (ttl) {
      // No se traga el error: un TTL peligroso que no se pudo eliminar debe ser
      // visible al arrancar, no silenciado.
      await coll.dropIndex(index);
    }
  }
}
