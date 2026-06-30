import { Account, type IAccount } from '../models/Account.js';
import { Folder } from '../models/Folder.js';
import { withLock } from '../lib/withLock.js';
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

// El lock distribuido se generalizó a `lib/withLock.ts` (reutilizado por la agenda — review B).
// `withAccountLock` queda como wrapper fino con la clave por-cuenta; MISMA semántica que antes
// (token único + heartbeat que renueva el TTL + release atómico Lua; `{skipped:true}` si otra
// instancia lo tiene; TTL 120s).
const lockKey = (accountId: string) => `sync:account:${accountId}`;

/**
 * Ejecuta `fn` con el LOCK DISTRIBUIDO de la cuenta tomado. Si otra instancia ya lo tiene, devuelve
 * `{skipped:true}` sin correr `fn`. Lo usan TANTO el barrido de fondo COMO el sync manual, para que
 * no se pisen (multi-instancia) — review B+D.
 */
export async function withAccountLock<T>(
  accountId: string,
  fn: () => Promise<T>
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  return withLock(lockKey(accountId), fn, { ttlSeconds: 120 });
}

export async function syncAccount(
  account: IAccount
): Promise<{ skipped?: boolean; synced: number }> {
  const r = await withAccountLock(account._id.toString(), async () => {
    await Account.updateOne({ _id: account._id }, { status: 'syncing' });
    try {
      await listAndSyncFolders(account); // descubre/actualiza la lista de carpetas
      const folders = await Folder.find({ accountId: account._id, subscribed: true }).select('_id');
      let synced = 0;
      for (const f of folders) {
        synced += await syncFolderHeaders(account, f._id.toString());
      }
      // lastSyncedAt = último sync COMPLETO exitoso (se setea acá, no en listAndSyncFolders, que
      // corre antes de los headers y mentiría si éstos fallan — review B).
      await Account.updateOne(
        { _id: account._id },
        { status: 'active', lastSyncedAt: new Date(), $unset: { lastError: '' } }
      );
      return synced;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await Account.updateOne(
        { _id: account._id },
        { status: 'error', lastError: message.slice(0, 500) }
      );
      throw err;
    }
  });
  if (r.skipped) return { skipped: true, synced: 0 };
  return { synced: r.result };
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
