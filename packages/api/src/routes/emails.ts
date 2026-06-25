import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  fetchAndParseMessage,
  setEmailSeen,
  moveEmailToTrash,
  type ParsedAttachment,
} from '../services/imap.js';
import { requireOwnedEmail, OwnershipError } from '../lib/authz.js';
import { Folder } from '../models/Folder.js';
import { Email } from '../models/Email.js';
import { redis } from '../config/redis.js';
import { sanitizeEmailHtml, plainTextFromHtml } from '../lib/sanitizeHtml.js';
import type { Email as EmailDto, EmailBody } from '@webmail6/shared';
import type { IEmail } from '../models/Email.js';

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);
const BODY_CACHE_TTL = 3600; // 1h

function serializeEmail(email: IEmail): EmailDto {
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

function toBuffer(content: ArrayBuffer | Uint8Array | string): Buffer {
  if (typeof content === 'string') return Buffer.from(content);
  return Buffer.from(content as ArrayBuffer);
}

const MAX_BODY_CACHE_BYTES = 256 * 1024; // no cachear bodies enormes

/** Resuelve el folder dueño del email (su path es necesario para abrir el mailbox).
 *  Asserta que el folder pertenezca a la MISMA cuenta del email (defensa). */
async function resolveFolderPath(email: IEmail): Promise<string> {
  const folder = await Folder.findOne({ _id: email.folderId, accountId: email.accountId });
  if (!folder) throw new OwnershipError('Folder not found');
  return folder.path;
}

/** Content-Disposition seguro: siempre 'attachment' (no se renderiza en el origen),
 *  filename ASCII saneado + filename* RFC 5987 para UTF-8. */
function rfc5987(name: string): string {
  // encodeURIComponent deja sin escapar !'()* — RFC 5987 los requiere percent-encoded.
  return encodeURIComponent(name).replace(
    /['()*!]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(filename)}`;
}

export default function emailRoutes(fastify: FastifyInstance) {
  fastify.get('/:emailId', async (request) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const { email } = await requireOwnedEmail(request.user.userId, emailId);
    return serializeEmail(email);
  });

  fastify.get('/:emailId/body', async (request) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const { email, account } = await requireOwnedEmail(request.user.userId, emailId);

    const cacheKey = `emailbody:${emailId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as EmailBody;
      } catch {
        // Dato corrupto en Redis: descartar y re-fetchear en vez de 500.
        await redis.del(cacheKey);
      }
    }

    const folderPath = await resolveFolderPath(email);
    // fetchAndParseMessage lanza 404 si el mensaje no está en el servidor (no se
    // cachea ni se pisa metadata como si fuera un body vacío legítimo).
    const parsed = await fetchAndParseMessage(account, folderPath, email.uid);
    const sanitizedHtml = parsed.html ? sanitizeEmailHtml(parsed.html) : undefined;
    // PRODUCT DECISION: no devolvemos el `html` crudo (sólo `sanitizedHtml`) para
    // que un frontend descuidado no pueda renderizar HTML hostil sin sanitizar.
    // Incluimos la metadata de adjuntos para que el front NO tenga que hacer un 2º
    // fetch+parse IMAP completo a /attachments al abrir el email.
    const response: EmailBody = {
      text: parsed.text,
      sanitizedHtml,
      attachments: parsed.attachments.map((a: ParsedAttachment, i: number) => ({
        id: String(i),
        filename: a.filename,
        contentType: a.mimeType || 'application/octet-stream',
        size: a.size,
        inline: a.inline,
        contentId: a.contentId,
      })),
    };

    // Persistir metadata real ANTES de cachear. updateOne con $set (no save() del
    // doc entero) para no pisar updates concurrentes de flags/threadId/modseq.
    const previewSource = parsed.text ?? (parsed.html ? plainTextFromHtml(parsed.html) : '');
    await Email.updateOne(
      { _id: email._id },
      {
        $set: {
          preview: previewSource.slice(0, 200),
          hasAttachments: parsed.attachments.length > 0,
          attachmentCount: parsed.attachments.length,
          bodyCached: true,
          bodyCachedAt: new Date(),
        },
      }
    );

    const serialized = JSON.stringify(response);
    if (Buffer.byteLength(serialized) <= MAX_BODY_CACHE_BYTES) {
      await redis.set(cacheKey, serialized, 'EX', BODY_CACHE_TTL);
    }

    return response;
  });

  fastify.get('/:emailId/attachments', async (request) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const { email, account } = await requireOwnedEmail(request.user.userId, emailId);
    const folderPath = await resolveFolderPath(email);
    const parsed = await fetchAndParseMessage(account, folderPath, email.uid);
    return parsed.attachments.map((a: ParsedAttachment, i: number) => ({
      id: String(i),
      filename: a.filename,
      contentType: a.mimeType || 'application/octet-stream',
      size: a.size,
      inline: a.inline,
      contentId: a.contentId,
    }));
  });

  const flagsSchema = z.object({ seen: z.boolean() });

  fastify.patch('/:emailId/flags', async (request) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const { seen } = flagsSchema.parse(request.body);
    const { email, account } = await requireOwnedEmail(request.user.userId, emailId);
    const folderPath = await resolveFolderPath(email);
    await setEmailSeen(account, folderPath, email.uid, seen);
    await Email.updateOne({ _id: email._id }, { $set: { 'flags.seen': seen } });
    return { ok: true, seen };
  });

  fastify.delete('/:emailId', async (request) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const { email, account } = await requireOwnedEmail(request.user.userId, emailId);
    const folderPath = await resolveFolderPath(email);
    await moveEmailToTrash(account, folderPath, email.uid);
    await Email.deleteOne({ _id: email._id });
    await redis.del(`emailbody:${email._id.toString()}`);
    return { ok: true };
  });

  fastify.get('/:emailId/attachments/:attachmentId', async (request, reply) => {
    const { emailId, attachmentId } = request.params as { emailId: string; attachmentId: string };
    objectIdSchema.parse(emailId);
    const idx = Number(attachmentId);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'Invalid attachment id' });
    }
    const { email, account } = await requireOwnedEmail(request.user.userId, emailId);
    const folderPath = await resolveFolderPath(email);
    const parsed = await fetchAndParseMessage(account, folderPath, email.uid);
    const att = parsed.attachments.at(idx);
    if (!att) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Attachment not found' });
    }
    // Seguridad: SIEMPRE como descarga (nunca inline) + nosniff, para que un adjunto
    // text/html o svg malicioso no se ejecute en el origen de la API (XSS).
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Content-Type', att.mimeType || 'application/octet-stream');
    void reply.header('Content-Disposition', contentDisposition(att.filename));
    return reply.send(toBuffer(att.content));
  });
}
