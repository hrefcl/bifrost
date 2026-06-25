import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Account } from '../models/Account.js';
import { Folder } from '../models/Folder.js';
import { Email } from '../models/Email.js';
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
    createdAt: email.createdAt.toISOString(),
    updatedAt: email.updatedAt.toISOString(),
  };
}

export default function accountRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request) => {
    const accounts = await Account.find({ userId: request.user.userId });
    return accounts.map(serializeAccount);
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
    return folders.map(serializeFolder);
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
    const { page, limit } = paginationSchema.parse(request.query);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      Email.find({ accountId, folderId }).sort({ date: -1, uid: -1 }).skip(skip).limit(limit),
      Email.countDocuments({ accountId, folderId }),
    ]);

    const response: Paginated<EmailDto> = {
      data: data.map(serializeEmail),
      pagination: { page, limit, total, hasMore: skip + data.length < total },
    };
    return response;
  });
}
