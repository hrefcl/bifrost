import { Account, type IAccount } from '../models/Account.js';
import { Folder } from '../models/Folder.js';
import { redis } from '../config/redis.js';
import { listAndSyncFolders, syncFolderHeaders } from './imap.js';

/**
 * Sync IMAP de FONDO (automático). Sin esto, el usuario no veía correo nuevo hasta pulsar "sync"
 * manualmente (re-auditoría holística, HIGH de producción de D). Aquí:
 *  - se sincronizan periódicamente las cuentas MÁS desactualizadas (no las deshabilitadas),
 *  - cada cuenta toma un LOCK DISTRIBUIDO en Redis (SET NX EX) para que en multi-instancia dos pods
 *    no sincronicen la misma cuenta a la vez (intercalando bulkWrite/deleteMany),
 *  - se registra el estado en `Account.status`/`lastSyncedAt`/`lastError` (observabilidad: antes el
 *    status nunca se actualizaba).
 */

// TTL del lock: debe superar la duración esperada de un sync de cuenta. Si una instancia muere a
// mitad, el lock expira y otra puede retomar en el próximo barrido.
const LOCK_TTL_SECONDS = 5 * 60;
const lockKey = (accountId: string) => `sync:account:${accountId}`;

export async function syncAccount(
  account: IAccount
): Promise<{ skipped?: boolean; synced: number }> {
  const id = account._id.toString();
  // Lock distribuido: sólo una instancia sincroniza esta cuenta a la vez.
  const acquired = await redis.set(lockKey(id), '1', 'EX', LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') return { skipped: true, synced: 0 };
  try {
    await Account.updateOne({ _id: account._id }, { status: 'syncing' });
    await listAndSyncFolders(account); // descubre/actualiza la lista de carpetas
    const folders = await Folder.find({ accountId: account._id, subscribed: true }).select('_id');
    let synced = 0;
    for (const f of folders) {
      synced += await syncFolderHeaders(account, f._id.toString());
    }
    await Account.updateOne(
      { _id: account._id },
      { status: 'active', lastSyncedAt: new Date(), $unset: { lastError: '' } }
    );
    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await Account.updateOne(
      { _id: account._id },
      { status: 'error', lastError: message.slice(0, 500) }
    );
    throw err;
  } finally {
    await redis.del(lockKey(id));
  }
}

/**
 * Barrido de fondo: sincroniza las `batchSize` cuentas más desactualizadas (lastSyncedAt más viejo;
 * las nunca-sincronizadas ordenan primero por ser null). En lotes para no saturar Mongo/IMAP con
 * miles de cuentas en un tick. Un error de una cuenta queda en su `status`/`lastError` y NO detiene
 * el barrido (las demás se sincronizan igual).
 */
export async function syncStaleAccounts(
  batchSize = 20
): Promise<{ accounts: number; synced: number }> {
  const accounts = await Account.find({ status: { $ne: 'disabled' } })
    .sort({ lastSyncedAt: 1 })
    .limit(batchSize);
  let synced = 0;
  let n = 0;
  for (const account of accounts) {
    try {
      const r = await syncAccount(account);
      if (!r.skipped) {
        synced += r.synced;
        n++;
      }
    } catch {
      // Ya registrado en Account.status='error'+lastError; continuar con las demás cuentas.
    }
  }
  return { accounts: n, synced };
}
