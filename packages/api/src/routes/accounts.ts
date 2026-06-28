import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Account } from '../models/Account.js';
import { Folder } from '../models/Folder.js';
import { Email } from '../models/Email.js';
import { AttachmentBlob } from '../models/AttachmentBlob.js';
import { listAndSyncFolders, syncFolderHeaders } from '../services/imap.js';
import { requireOwnedAccount, requireOwnedFolder } from '../lib/authz.js';
import type {
  Account as AccountDto,
  Folder as FolderDto,
  Email as EmailDto,
  Paginated,
} from '@webmail6/shared';

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Filtro de la lista (estilo Gmail). Server-side: filtra TODA la carpeta, no sólo la página
  // cargada (un filtro client-side sobre 20 emails mostraría "0" aunque hubiera matches después).
  filter: z.enum(['unread', 'starred', 'attachments']).optional(),
});

function serializeAccount(account: import('../models/Account.js').IAccount): AccountDto {
  return {
    id: account._id.toString(),
    userId: account.userId.toString(),
    name: account.name,
    email: account.email,
    isPrimary: account.isPrimary,
    imap: {
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      authMethod: account.imap.authMethod,
      authUser: account.imap.authUser,
      authCredentials: '',
      compress: account.imap.compress,
      capabilities: account.imap.capabilities,
      hasCondstore: account.imap.hasCondstore,
      hasQresync: account.imap.hasQresync,
      hasIdle: account.imap.hasIdle,
      preferredProtocol: account.imap.preferredProtocol,
    },
    smtp: {
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      authMethod: account.smtp.authMethod,
      authUser: account.smtp.authUser,
      authCredentials: '',
    },
    caldav: account.caldav
      ? {
          baseUrl: account.caldav.baseUrl,
          username: account.caldav.username,
          password: '',
        }
      : undefined,
    status: account.status,
    lastError: account.lastError,
    lastSyncedAt: account.lastSyncedAt?.toISOString(),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

function serializeFolder(folder: import('../models/Folder.js').IFolder): FolderDto {
  return {
    id: folder._id.toString(),
    accountId: folder.accountId.toString(),
    name: folder.name,
    delimiter: folder.delimiter,
    displayName: folder.displayName,
    parentPath: folder.parentPath,
    flags: folder.flags,
    specialUse: folder.specialUse,
    uidValidity: folder.uidValidity,
    uidNext: folder.uidNext,
    totalMessages: folder.totalMessages,
    unseenMessages: folder.unseenMessages,
    subscribed: folder.subscribed,
    sortOrder: folder.sortOrder,
    expanded: folder.expanded,
    syncedAt: folder.syncedAt.toISOString(),
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  };
}

function serializeEmail(email: import('../models/Email.js').IEmail): EmailDto {
  return {
    id: email._id.toString(),
    accountId: email.accountId.toString(),
    folderId: email.folderId.toString(),
    uid: email.uid,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
    threadId: email.threadId,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    date: email.date.toISOString(),
    internalDate: email.internalDate.toISOString(),
    size: email.size,
    preview: email.preview,
    flags: email.flags,
    keywords: email.keywords,
    hasAttachments: email.hasAttachments,
    attachmentCount: email.attachmentCount,
    modseq: email.modseq,
    bodyCached: email.bodyCached,
    bodyCachedAt: email.bodyCachedAt?.toISOString(),
    snoozedUntil: email.snoozedUntil?.toISOString(),
    createdAt: email.createdAt.toISOString(),
    updatedAt: email.updatedAt.toISOString(),
  };
}

export default function accountRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request) => {
    const accounts = await Account.find({ userId: request.user.userId });
    return accounts.map(serializeAccount);
  });

  /**
   * Almacenamiento del usuario (para la barra del sidebar, estilo Gmail). `usedBytes` es REAL:
   * suma de los bytes de los adjuntos activos del usuario (lo que Bifrost almacena de verdad).
   * `limitBytes` es el cap configurable (STORAGE_LIMIT_BYTES, default 15 GB).
   */
  fastify.get('/storage', async (request) => {
    const agg = await AttachmentBlob.aggregate<{ bytes: number }>([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(request.user.userId),
          status: 'active',
        },
      },
      { $group: { _id: null, bytes: { $sum: '$size' } } },
    ]);
    const usedBytes = agg[0]?.bytes ?? 0;
    const DEFAULT_LIMIT = 15 * 1024 * 1024 * 1024; // 15 GB
    const envLimit = Number(process.env.STORAGE_LIMIT_BYTES ?? String(DEFAULT_LIMIT));
    const limitBytes = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : DEFAULT_LIMIT;
    return { usedBytes, limitBytes };
  });

  fastify.post('/:accountId/sync/folders', async (request) => {
    const { accountId } = request.params as { accountId: string };
    objectIdSchema.parse(accountId);
    const account = await requireOwnedAccount(request.user.userId, accountId);
    const count = await listAndSyncFolders(account);
    return { synced: count };
  });

  fastify.get('/:accountId/folders', async (request) => {
    const { accountId } = request.params as { accountId: string };
    objectIdSchema.parse(accountId);
    await requireOwnedAccount(request.user.userId, accountId);
    const folders = await Folder.find({ accountId }).sort({ sortOrder: 1, name: 1 });

    // Badge de no-leídos AUTORITATIVO (paridad Gmail): se cuenta directamente cuántos emails están
    // VISIBLES y no-leídos por carpeta (flags.seen=false Y no pospuestos), exactamente el mismo
    // criterio que la lista de la carpeta. Así el badge refleja al instante mark-read, delete, move,
    // snooze y unsnooze, porque cuenta documentos Email reales. (NO se usa Folder.unseenMessages: ese
    // viene del sync IMAP y NO se actualiza al marcar leído/borrar/mover hasta el próximo sync, lo
    // que dejaba el badge inflado de forma persistente — review B.) `snoozedUntil {$not:{$gt:now}}`
    // incluye ausente/null/vencido en una sola condición, igual que el filtro de la lista.
    const unread = await Email.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      {
        $match: {
          accountId: new mongoose.Types.ObjectId(accountId),
          'flags.seen': false,
          snoozedUntil: { $not: { $gt: new Date() } },
        },
      },
      { $group: { _id: '$folderId', n: { $sum: 1 } } },
    ]);
    const unreadByFolder = new Map(unread.map((u) => [u._id.toString(), u.n]));

    return folders.map((folder) => {
      const dto = serializeFolder(folder);
      return { ...dto, unseenMessages: unreadByFolder.get(dto.id) ?? 0 };
    });
  });

  fastify.post('/:accountId/folders/:folderId/sync', async (request) => {
    const { accountId, folderId } = request.params as { accountId: string; folderId: string };
    objectIdSchema.parse(accountId);
    objectIdSchema.parse(folderId);
    const { account } = await requireOwnedFolder(request.user.userId, accountId, folderId);
    const synced = await syncFolderHeaders(account, folderId);
    return { synced };
  });

  fastify.get('/:accountId/folders/:folderId/emails', async (request) => {
    const { accountId, folderId } = request.params as { accountId: string; folderId: string };
    objectIdSchema.parse(accountId);
    objectIdSchema.parse(folderId);
    await requireOwnedFolder(request.user.userId, accountId, folderId);
    const { page, limit, filter: listFilter } = paginationSchema.parse(request.query);
    const skip = (page - 1) * limit;

    // Pospuestos (snooze): ocultar los que siguen en snooze (snoozedUntil futuro). Al pasar la
    // hora reaparecen solos (no hace falta scheduler: es una condición de query).
    // `$not {$gt}` (en vez de un $or) incluye ausente/null/<=now en UNA condición: deja que el
    // índice ESR {accountId,folderId,date,uid} sirva igualdad+sort y aplica esto como filtro
    // residual sobre la carpeta ya acotada (el $or rompía el plan); además cubre null (review B+D).
    const filter: Record<string, unknown> = {
      accountId,
      folderId,
      snoozedUntil: { $not: { $gt: new Date() } },
    };
    // Filtro de la lista (server-side → filtra toda la carpeta, conteo `total` honesto).
    if (listFilter === 'unread') filter['flags.seen'] = false;
    else if (listFilter === 'starred') filter['flags.flagged'] = true;
    else if (listFilter === 'attachments') filter.hasAttachments = true;
    const [data, total] = await Promise.all([
      Email.find(filter).sort({ date: -1, uid: -1 }).skip(skip).limit(limit),
      Email.countDocuments(filter),
    ]);

    const response: Paginated<EmailDto> = {
      data: data.map(serializeEmail),
      pagination: { page, limit, total, hasMore: skip + data.length < total },
    };
    return response;
  });
}
