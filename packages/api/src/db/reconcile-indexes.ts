import mongoose from 'mongoose';
import { EMAIL_TEXT_INDEX } from '../models/email-indexes.js';

type ObjectId = mongoose.Types.ObjectId;

/**
 * Reconciliación del índice de texto `email_text_search` (review B).
 *
 * El índice cambió de campos/pesos (se añadió `from.name`). Mongoose con autoIndex/createIndexes
 * NUNCA modifica un índice existente con el mismo nombre pero distinta definición: lanza
 * `IndexOptionsConflict` y deja el índice VIEJO activo. Resultado en upgrades: la búsqueda por
 * remitente no quedaría realmente habilitada. Esta función, de forma idempotente y sólo si la
 * definición existente difiere de la canónica, dropea el índice legado y recrea el actual.
 * En DB fresh es no-op (no existe el índice todavía; lo crea autoIndex/createIndexes).
 */
export async function reconcileEmailTextIndex(): Promise<void> {
  const coll = mongoose.connection.db?.collection('emails');
  if (!coll) return;

  let indexes;
  try {
    indexes = await coll.indexes();
  } catch (err) {
    if ((err as { codeName?: string }).codeName === 'NamespaceNotFound') return;
    throw err;
  }

  const existing = indexes.find((i) => i.name === EMAIL_TEXT_INDEX.name);
  if (!existing) return; // fresh: no hay índice → autoIndex/createIndexes lo crea con la spec actual.

  // El índice está actualizado sólo si coinciden TANTO los pesos de los campos de texto COMO el
  // prefijo no-texto (review B: comparar sólo `weights` dejaría pasar una deriva con mismos pesos
  // pero distinto prefijo). Mongo expone los campos de texto en `weights` y el prefijo escalar en
  // `key` (como `_fts: 'text', _ftsx: 1` + los campos de igualdad, p.ej. `accountId: 1`).
  const currentWeights = (existing.weights ?? {}) as Record<string, number>;
  const desiredWeights = EMAIL_TEXT_INDEX.weights as Record<string, number>;
  const sameWeights =
    Object.keys(desiredWeights).length === Object.keys(currentWeights).length &&
    Object.entries(desiredWeights).every(([k, v]) => currentWeights[k] === v);

  // Prefijo escalar = entradas numéricas de `key` (excluye el marcador interno `_fts`/`_ftsx`).
  const scalarPrefix = (key: Record<string, unknown>) =>
    Object.entries(key)
      .filter(([k, v]) => typeof v === 'number' && k !== '_ftsx')
      .map(([k, v]) => `${k}:${String(v)}`)
      .sort()
      .join(',');
  const samePrefix = scalarPrefix(existing.key) === scalarPrefix(EMAIL_TEXT_INDEX.key);

  if (sameWeights && samePrefix) return; // ya está actualizado.

  await coll.dropIndex(EMAIL_TEXT_INDEX.name);
  // No se pasa `background: true`: la opción está deprecada e IGNORADA desde MongoDB 4.2 — todas
  // las construcciones de índice usan ya el builder híbrido no-bloqueante (no toma el lock de
  // escritura sobre la colección durante el build). Pasarla no cambiaría nada.
  await coll.createIndex(EMAIL_TEXT_INDEX.key, {
    name: EMAIL_TEXT_INDEX.name,
    weights: EMAIL_TEXT_INDEX.weights,
  });
}

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
