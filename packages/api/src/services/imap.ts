import {
  ImapFlow,
  type FetchQueryObject,
  type FetchMessageObject,
  type MessageAddressObject,
} from 'imapflow';
import PostalMime from 'postal-mime';
import type { IAccount } from '../models/Account.js';
import { Account } from '../models/Account.js';
import { Folder } from '../models/Folder.js';
import { Email } from '../models/Email.js';
import { redis } from '../config/redis.js';
import { createImapClient } from './mail-transport.js';

// Tamaño de lote para comandos IMAP/Mongo (evita rangos UID/$in gigantes).
const SYNC_CHUNK = 200;

// Tamaño de lote para la reconciliación de flags: a lo sumo este número de headers del
// servidor se procesan a la vez (find por $in + bulkWrite). Acota la memoria del paso de
// flags independientemente del tamaño del folder. Clamp defensivo: un env no-finito/<1 cae
// al default; el techo 50000 evita que un valor absurdo (o Infinity) permita buffers gigantes.
const SYNC_WINDOW = (() => {
  const raw = Number(process.env.SYNC_WINDOW);
  if (!Number.isFinite(raw) || raw < 1) return 5000;
  return Math.min(Math.floor(raw), 50000);
})();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Mutex en-proceso por folder: serializa syncs concurrentes del mismo folder para
// que no se intercalen wipe/upsert/flag-update/save (stale state). Para multi-instancia
// haría falta además un lock distribuido (Redis) — ver tech-debt.
const folderSyncLocks = new Map<string, Promise<unknown>>();
import type { Address, SpecialUse } from '@webmail6/shared';

// Tope de tamaño de un mensaje a procesar en memoria (defensa anti-OOM).
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  inline: boolean;
  contentId?: string;
  size: number;
  content: ArrayBuffer | Uint8Array | string;
}

export interface ParsedMessage {
  text?: string;
  html?: string;
  attachments: ParsedAttachment[];
}

function attachmentSize(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === 'string') return Buffer.byteLength(content);
  if (content instanceof Uint8Array) return content.byteLength;
  return content.byteLength;
}

// imapflow tipa uidValidity/uidNext como `number | bigint`; normalizamos a number.
function toNum(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

interface StoredFlags {
  seen: boolean;
  answered: boolean;
  flagged: boolean;
  deleted: boolean;
  draft: boolean;
}

function toFlags(flags?: Set<string>): StoredFlags {
  return {
    seen: flags?.has('\\Seen') ?? false,
    answered: flags?.has('\\Answered') ?? false,
    flagged: flags?.has('\\Flagged') ?? false,
    deleted: flags?.has('\\Deleted') ?? false,
    draft: flags?.has('\\Draft') ?? false,
  };
}

function flagsChanged(stored: Partial<StoredFlags> | undefined, current?: Set<string>): boolean {
  const c = toFlags(current);
  return (
    (stored?.seen ?? false) !== c.seen ||
    (stored?.answered ?? false) !== c.answered ||
    (stored?.flagged ?? false) !== c.flagged ||
    (stored?.deleted ?? false) !== c.deleted ||
    (stored?.draft ?? false) !== c.draft
  );
}

export interface SyncStats {
  foldersListed: number;
  messagesSynced: number;
}

function buildClient(account: IAccount): ImapFlow {
  const password = account.getImapCredentials();
  return createImapClient({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: {
      user: account.imap.authUser,
      pass: password,
    },
    logger: false,
    emitLogs: false,
  });
}

async function withClient<T>(account: IAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = buildClient(account);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
}

function normalizeAddress(addr?: MessageAddressObject): Address | undefined {
  if (!addr?.address) return undefined;
  return { address: addr.address, name: addr.name };
}

function normalizeAddresses(addrs?: MessageAddressObject[]): Address[] {
  if (!Array.isArray(addrs)) return [];
  return addrs.map(normalizeAddress).filter((a): a is Address => Boolean(a));
}

function parseSpecialUse(specialUse?: string): SpecialUse | undefined {
  if (!specialUse) return undefined;
  const map: Record<string, SpecialUse> = {
    '\\Inbox': 'inbox',
    '\\Sent': 'sent',
    '\\Drafts': 'drafts',
    '\\Trash': 'trash',
    '\\Junk': 'junk',
    '\\Archive': 'archive',
  };
  return map[specialUse];
}

export async function listAndSyncFolders(account: IAccount): Promise<number> {
  return withClient(account, async (client) => {
    const mailboxes = await client.list();
    let count = 0;

    for (const box of mailboxes) {
      if (!box.path) continue;
      const delimiter = box.delimiter;
      const parentPath = box.parentPath;

      await Folder.findOneAndUpdate(
        { accountId: account._id.toString(), path: box.path },
        {
          // Campos descriptivos: se refrescan en cada listado.
          $set: {
            accountId: account._id.toString(),
            name: box.name,
            path: box.path,
            delimiter,
            displayName: box.name,
            parentPath,
            flags: [...box.flags],
            specialUse: parseSpecialUse(box.specialUse),
            syncedAt: new Date(),
          },
          // Estado de sync: sólo en insert, para NO pisar uidValidity/uidNext/contadores
          // reales que pobló syncFolderHeaders (antes se reseteaban a 0 en cada listado).
          $setOnInsert: {
            uidValidity: 0,
            uidNext: 1,
            totalMessages: 0,
            unseenMessages: 0,
            subscribed: true,
            sortOrder: 0,
            expanded: false,
          },
        },
        { upsert: true, new: true }
      );
      count++;
    }

    await Account.updateOne({ _id: account._id }, { $set: { lastSyncedAt: new Date() } });
    return count;
  });
}

/**
 * Sincronización incremental de un folder:
 *  1. Chequea UIDVALIDITY: si cambió, los UID guardados ya no son válidos → wipe + resync.
 *  2. Recorre los UID del servidor con un fetch liviano (uid+flags, sin envelope/body),
 *     reconciliando: nuevos → fetch completo + insert; existentes → update de flags si cambiaron.
 *  3. Expunged (en DB pero ya no en el servidor) → delete + invalidación de caché.
 *  4. Persiste el estado real del folder (uidValidity/uidNext/totalMessages/unseenMessages).
 * Devuelve la cantidad de mensajes NUEVOS insertados.
 */
export async function syncFolderHeaders(account: IAccount, folderId: string): Promise<number> {
  // Serializa por folder: encadena sobre el sync previo (si lo hay) y limpia el lock al terminar.
  const key = `${account._id.toString()}:${folderId}`;
  const prev = folderSyncLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => syncFolderHeadersInner(account, folderId));
  folderSyncLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (folderSyncLocks.get(key) === run) folderSyncLocks.delete(key);
  }
}

async function syncFolderHeadersInner(account: IAccount, folderId: string): Promise<number> {
  const folder = await Folder.findById(folderId);
  if (!folder) {
    throw new Error('Folder not found');
  }
  if (folder.accountId.toString() !== account._id.toString()) {
    throw new Error('Folder does not belong to account');
  }
  const accountId = account._id.toString();
  const folderIdStr = folder._id.toString();

  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock(folder.path);
    try {
      const mailbox = client.mailbox;
      const serverUidValidity = mailbox ? toNum(mailbox.uidValidity) : 0;

      // (1) UIDVALIDITY cambió → wipe + resync (los UID viejos apuntan a otros mensajes).
      // Cursor (no .find().lean() del folder entero) para invalidar caché con memoria O(1).
      if (folder.uidValidity && serverUidValidity && folder.uidValidity !== serverUidValidity) {
        const staleCursor = Email.find({ accountId, folderId: folderIdStr })
          .select('_id')
          .lean()
          .cursor();
        for await (const e of staleCursor) {
          await redis.del(`emailbody:${(e as { _id: { toString(): string } })._id.toString()}`);
        }
        await Email.deleteMany({ accountId, folderId: folderIdStr });
      }

      const query: FetchQueryObject = {
        uid: true,
        flags: true,
        size: true,
        internalDate: true,
        envelope: true,
        bodyStructure: true,
      };

      // uidNext del servidor (próximo UID a asignar): se persiste como estado del folder.
      const uidNext = mailbox ? toNum(mailbox.uidNext) : 0;

      // Diseño anti-OOM y SIN asumir orden de UIDs del servidor (RFC 9051: un sequence-set
      // puede responderse en cualquier orden; imapflow no reordena). El único estado O(N) es
      // `serverUids`, un Set de ENTEROS — la información mínima e inevitable para detectar
      // expunges (locales que el servidor ya no lista). No se cargan documentos locales
      // completos en RAM en ningún momento. Para folders verdaderamente masivos (millones),
      // el camino O(cambios) es CONDSTORE/HIGHESTMODSEQ → ver TD-SYNC-CONDSTORE.
      const serverUids = new Set<number>();
      const newUids: number[] = [];
      let count = 0;
      let unseen = 0;
      let totalMessages = 0;

      // PASO 1 — stream liviano `1:*` {uid,flags}: registra cada UID del servidor y reconcilia
      // flags por lotes de SYNC_WINDOW. El lookup local es por `$in` de UIDs EXPLÍCITOS del
      // buffer (no por rango) → independiente del orden. Los nuevos se anotan; el fetch del
      // envelope va en el PASO 3 (anidar un fetch dentro del iterador del scan deadlockearía:
      // imapflow serializa comandos y el scan no avanza hasta consumirlo).
      let buf: { uid: number; flags?: Set<string> }[] = [];
      const flushFlags = async (): Promise<void> => {
        if (buf.length === 0) return;
        const bufUids = buf.map((m) => m.uid);
        const locals = await Email.find({
          accountId,
          folderId: folderIdStr,
          uid: { $in: bufUids },
        })
          .select('uid flags')
          .lean();
        const localByUid = new Map(locals.map((e) => [e.uid, e]));
        const flagOps: Parameters<typeof Email.bulkWrite>[0] = [];
        for (const m of buf) {
          const known = localByUid.get(m.uid);
          if (!known) {
            newUids.push(m.uid);
          } else if (flagsChanged(known.flags, m.flags)) {
            flagOps.push({
              updateOne: {
                filter: { accountId, folderId: folderIdStr, uid: m.uid },
                update: { $set: { flags: toFlags(m.flags) } },
              },
            });
          }
        }
        for (const batch of chunk(flagOps, SYNC_CHUNK)) {
          await Email.bulkWrite(batch);
        }
        buf = [];
      };

      for await (const m of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
        totalMessages++;
        serverUids.add(m.uid);
        if (!(m.flags?.has('\\Seen') ?? false)) unseen++;
        buf.push({ uid: m.uid, flags: m.flags });
        if (buf.length >= SYNC_WINDOW) {
          // Sólo toca Mongo (seguro durante la iteración IMAP: es otra conexión).
          await flushFlags();
        }
      }
      await flushFlags();

      // PASO 2 — expunged: recorre los locales con un CURSOR (memoria O(1), nunca el folder
      // entero en RAM) y borra los que el servidor ya no lista. Cubre CUALQUIER uid (incluidos
      // locales corruptos con uid ≥ uidNext). Caché Redis + deleteMany en lotes (no 1×1).
      // Orden Mongo→Redis a propósito: se borra primero la fuente de verdad (Mongo) y luego la
      // caché. Si `redis.del` falla tras el deleteMany, la entrada de body queda huérfana pero
      // es inofensiva (GET /body resuelve por _id → 404 sin tocar la caché) y expira por TTL. El
      // orden inverso podría dejar el doc en Mongo si fallara la caché, reapareciendo el mensaje.
      const delUids: number[] = [];
      const delCacheKeys: string[] = [];
      const flushDeletes = async (): Promise<void> => {
        if (delUids.length > 0) {
          await Email.deleteMany({ accountId, folderId: folderIdStr, uid: { $in: delUids } });
          delUids.length = 0;
        }
        if (delCacheKeys.length > 0) {
          await redis.del(...delCacheKeys);
          delCacheKeys.length = 0;
        }
      };
      const localCursor = Email.find({ accountId, folderId: folderIdStr })
        .select('uid')
        .lean()
        .cursor();
      for await (const e of localCursor) {
        const local = e as unknown as { _id: { toString(): string }; uid: number };
        if (!serverUids.has(local.uid)) {
          delUids.push(local.uid);
          delCacheKeys.push(`emailbody:${local._id.toString()}`);
          if (delUids.length >= SYNC_CHUNK) await flushDeletes();
        }
      }
      await flushDeletes();

      // PASO 3 — ya con el scan `1:*` drenado, traemos envelope/bodyStructure SÓLO de los UIDs
      // nuevos, en sub-lotes IMAP de SYNC_CHUNK (sin anidar comandos). En un sync incremental
      // newUids ≈ 0; sólo el primer sync de un folder grande acumula la lista (enteros), el
      // mínimo bookkeeping inevitable para enumerar lo que hay que traer.
      for (const batch of chunk(newUids, SYNC_CHUNK)) {
        for await (const msg of client.fetch(batch.join(','), query, { uid: true })) {
          await upsertMessage(account, folder, msg);
          count++;
        }
      }

      // $set dirigido (no save() del doc entero) para no pisar campos concurrentes.
      await Folder.updateOne(
        { _id: folder._id },
        {
          $set: {
            uidValidity: serverUidValidity || folder.uidValidity,
            uidNext: uidNext || folder.uidNext,
            totalMessages,
            unseenMessages: unseen,
            syncedAt: new Date(),
          },
        }
      );
      return count;
    } finally {
      lock.release();
    }
  });
}

/** Marca/desmarca un mensaje como leído (flag \Seen) por UID. */
export async function setEmailSeen(
  account: IAccount,
  folderPath: string,
  uid: number,
  seen: boolean
): Promise<void> {
  await withClient(account, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    try {
      if (seen) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  });
}

/** Mueve un mensaje (por uid) desde `folderPath` a `targetPath` vía IMAP MOVE. */
export async function moveEmailToFolder(
  account: IAccount,
  folderPath: string,
  uid: number,
  targetPath: string
): Promise<void> {
  await withClient(account, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    try {
      await client.messageMove(String(uid), targetPath, { uid: true });
    } finally {
      lock.release();
    }
  });
}

/** Mueve un mensaje a la carpeta Trash (por specialUse; fallback 'Trash'). */
export async function moveEmailToTrash(
  account: IAccount,
  folderPath: string,
  uid: number
): Promise<void> {
  const trash = await Folder.findOne({
    accountId: account._id.toString(),
    specialUse: 'trash',
  });
  const trashPath = trash?.path ?? 'Trash';
  await moveEmailToFolder(account, folderPath, uid, trashPath);
}

/**
 * Hace APPEND del mensaje enviado (raw) a la carpeta Sent de la cuenta (por
 * specialUse; fallback 'Sent'). Best-effort: el caller no debe fallar el envío si esto falla.
 */
export async function appendToSent(account: IAccount, raw: Buffer): Promise<void> {
  const sent = await Folder.findOne({
    accountId: account._id.toString(),
    specialUse: 'sent',
  });
  const path = sent?.path ?? 'Sent';
  await withClient(account, async (client) => {
    await client.append(path, raw, ['\\Seen']);
  });
}

async function upsertMessage(
  account: IAccount,
  folder: import('../models/Folder.js').IFolder,
  msg: FetchMessageObject
): Promise<void> {
  const env = msg.envelope;
  const from = normalizeAddress(env?.from?.[0]);
  const replyTo = normalizeAddress(env?.replyTo?.[0]);
  const to = normalizeAddresses(env?.to);
  const cc = normalizeAddresses(env?.cc);
  const subject = env?.subject ?? '(no subject)';
  const date = env?.date ? new Date(env.date).toISOString() : new Date().toISOString();
  const internalDate = msg.internalDate
    ? new Date(msg.internalDate).toISOString()
    : new Date().toISOString();
  const size = typeof msg.size === 'number' ? msg.size : 0;
  const attachments = msg.bodyStructure?.childNodes?.some(
    (n: { disposition?: string; type?: string }) =>
      n.disposition === 'attachment' || n.type === 'application/octet-stream'
  );

  const doc = await Email.findOneAndUpdate(
    {
      accountId: account._id.toString(),
      folderId: folder._id.toString(),
      uid: msg.uid,
    },
    {
      accountId: account._id.toString(),
      folderId: folder._id.toString(),
      uid: msg.uid,
      messageId: env?.messageId ?? `unknown-${String(msg.uid)}`,
      inReplyTo: env?.inReplyTo,
      references: undefined,
      threadId: undefined,
      from,
      replyTo,
      to,
      cc,
      subject,
      date,
      internalDate,
      size,
      preview: undefined,
      flags: {
        seen: msg.flags?.has('\\Seen') ?? false,
        answered: msg.flags?.has('\\Answered') ?? false,
        flagged: msg.flags?.has('\\Flagged') ?? false,
        deleted: msg.flags?.has('\\Deleted') ?? false,
        draft: msg.flags?.has('\\Draft') ?? false,
      },
      hasAttachments: attachments,
      attachmentCount: 0,
      bodyCached: false,
    },
    { upsert: true, new: true }
  );
  // Invalidar la caché del body al re-sincronizar (el source pudo cambiar; evita
  // servir un body cacheado con metadata reseteada).
  await redis.del(`emailbody:${doc._id.toString()}`);
}

/**
 * Trae el mensaje por UID (abriendo el mailbox correcto del folder — los UID son
 * por-carpeta) y lo parsea con postal-mime a text/html/adjuntos reales.
 */
export async function fetchAndParseMessage(
  account: IAccount,
  folderPath: string,
  uid: number
): Promise<ParsedMessage> {
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      // Miss real (UID inexistente/stale, mensaje borrado server-side): NO se debe
      // cachear ni pisar metadata como si fuera un cuerpo vacío legítimo. Se lanza
      // 404 para que la ruta no marque el email como bodyCached con preview vacío.
      if (!msg || !msg.source) {
        throw Object.assign(new Error('Message not found on server'), { statusCode: 404 });
      }
      if (msg.source.length > MAX_MESSAGE_BYTES) {
        throw Object.assign(new Error('Message too large to process'), { statusCode: 413 });
      }
      const parsed = await PostalMime.parse(msg.source);
      const attachments: ParsedAttachment[] = parsed.attachments.map((a) => ({
        filename: a.filename ?? 'attachment',
        mimeType: a.mimeType,
        inline: a.disposition === 'inline',
        contentId: a.contentId,
        size: attachmentSize(a.content),
        content: a.content,
      }));
      return { text: parsed.text, html: parsed.html, attachments };
    } finally {
      lock.release();
    }
  });
}
