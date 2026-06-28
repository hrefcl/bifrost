import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  fetchAndParseMessage,
  setEmailSeen,
  setEmailFlagged,
  moveEmailToTrash,
  moveEmailToFolder,
  type ParsedAttachment,
} from '../services/imap.js';
import { requireOwnedEmail, OwnershipError } from '../lib/authz.js';
import { Folder } from '../models/Folder.js';
import { Email } from '../models/Email.js';
import { Account } from '../models/Account.js';
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
    replyTo: email.replyTo,
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
  // Búsqueda global estilo Gmail: usa el índice de TEXTO (email_text_search) sobre
  // asunto/remitente/preview en TODAS las cuentas del usuario (owner-bound). $text escala con
  // índice (a diferencia de un $regex sin ancla, que era un COLLSCAN O(n) — review B+D). Cap 50.
  //
  // IMPORTANTE (review B): el índice de texto es COMPUESTO con prefijo `accountId`. MongoDB exige
  // IGUALDAD sobre el prefijo de un índice $text; `accountId: {$in: [...]}` NO es igualdad y el
  // planner falla con `NoQueryExecutionPlans` → 500 en cuanto el usuario tiene 2+ cuentas (los
  // tests con 1 cuenta lo ocultaban). Por eso lanzamos UNA query indexada por cuenta (igualdad,
  // tenant-aislada) y fusionamos por textScore. El caso común (1 cuenta) sigue siendo 1 query.
  const searchSchema = z.object({ q: z.string().trim().min(1).max(200) });
  fastify.get('/search', async (request, reply) => {
    const parsed = searchSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'q inválido (1-200 chars)' });
    }
    const accounts = await Account.find({ userId: request.user.userId }).select('_id');
    const accountIds = accounts.map((a) => a._id);
    if (accountIds.length === 0) return { data: [] };
    const q = parsed.data.q;
    const perAccount = await Promise.all(
      accountIds.map((accountId) =>
        Email.find({ accountId, $text: { $search: q } }, { score: { $meta: 'textScore' } })
          .sort({ score: { $meta: 'textScore' }, date: -1 })
          .limit(50)
      )
    );
    // Fusión global por relevancia (textScore desc, luego fecha desc) y cap 50.
    //
    // Sobre la comparabilidad del textScore entre cuentas (objeción D): el textScore de MongoDB es
    // Σ(frecuencia_del_término × peso_del_campo) del DOCUMENTO; NO aplica IDF ni normalización a
    // nivel de colección/resultado. Como aquí TODAS las sub-queries usan el MISMO término y los
    // MISMOS pesos del índice, el score de un documento depende sólo del documento y es directamente
    // comparable entre cuentas (la advertencia de la doc aplica a queries/términos DISTINTOS).
    // Además el cap es correcto globalmente: un documento del top-50 global está necesariamente en
    // el top-50 de su propia cuenta, así que pedir 50 por cuenta y recortar a 50 no pierde resultados.
    const merged = perAccount
      .flat()
      .sort((a, b) => {
        const sa = (a.get('score') as number | undefined) ?? 0;
        const sb = (b.get('score') as number | undefined) ?? 0;
        return sb - sa || b.date.getTime() - a.date.getTime();
      })
      .slice(0, 50);
    return { data: merged.map(serializeEmail) };
  });

  // Pospuestos (snooze): emails del usuario que SIGUEN pospuestos (snoozedUntil futuro).
  fastify.get('/snoozed', async (request) => {
    const accounts = await Account.find({ userId: request.user.userId }).select('_id');
    const accountIds = accounts.map((a) => a._id);
    if (accountIds.length === 0) return { data: [] };
    const emails = await Email.find({
      accountId: { $in: accountIds },
      snoozedUntil: { $gt: new Date() },
    })
      .sort({ snoozedUntil: 1 })
      .limit(100);
    return { data: emails.map(serializeEmail) };
  });

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

  // Acepta `seen` y/o `flagged` (estrella de Gmail). Al menos uno requerido.
  const flagsSchema = z
    .object({ seen: z.boolean().optional(), flagged: z.boolean().optional() })
    .refine((b) => b.seen !== undefined || b.flagged !== undefined, {
      message: 'seen o flagged requerido',
    });

  fastify.patch('/:emailId/flags', async (request) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const body = flagsSchema.parse(request.body);
    const { email, account } = await requireOwnedEmail(request.user.userId, emailId);
    const folderPath = await resolveFolderPath(email);
    const set: Record<string, boolean> = {};
    if (body.seen !== undefined) {
      await setEmailSeen(account, folderPath, email.uid, body.seen);
      set['flags.seen'] = body.seen;
    }
    if (body.flagged !== undefined) {
      await setEmailFlagged(account, folderPath, email.uid, body.flagged);
      set['flags.flagged'] = body.flagged;
    }
    await Email.updateOne({ _id: email._id }, { $set: set });
    return { ok: true, ...body };
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

  // Mover/archivar un email a otra carpeta (Gmail: Archivar, Spam, mover a carpeta). El destino
  // se resuelve OWNER-BOUND: por specialUse de la cuenta, o por folderId propio. Como el uid
  // cambia en el destino, quitamos el doc local (se re-sincroniza al sincronizar el destino),
  // mismo patrón que el move-a-trash.
  const moveSchema = z
    .object({
      specialUse: z.enum(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive']).optional(),
      folderId: objectIdSchema.optional(),
    })
    .refine((b) => Boolean(b.specialUse ?? b.folderId), {
      message: 'specialUse o folderId requerido',
    });

  fastify.post('/:emailId/move', async (request, reply) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const body = moveSchema.parse(request.body);
    const { email, account } = await requireOwnedEmail(request.user.userId, emailId);

    const target = body.folderId
      ? await Folder.findOne({ _id: body.folderId, accountId: account._id.toString() })
      : await Folder.findOne({ accountId: account._id.toString(), specialUse: body.specialUse });
    if (!target) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Target folder not found' });
    }
    if (target._id.toString() === email.folderId.toString()) {
      return { ok: true }; // ya está en esa carpeta
    }

    const folderPath = await resolveFolderPath(email);
    await moveEmailToFolder(account, folderPath, email.uid, target.path);
    await Email.deleteOne({ _id: email._id });
    await redis.del(`emailbody:${email._id.toString()}`);
    return { ok: true };
  });

  // Posponer (snooze): ocultar el email hasta `until` (futuro). Reaparece solo al pasar la hora
  // (la query de la carpeta lo excluye mientras snoozedUntil > now). Owner-bound.
  const snoozeSchema = z.object({ until: z.string().datetime() });
  fastify.post('/:emailId/snooze', async (request, reply) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const { until } = snoozeSchema.parse(request.body);
    const untilDate = new Date(until);
    if (untilDate.getTime() <= Date.now()) {
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'until must be in the future' });
    }
    const { email } = await requireOwnedEmail(request.user.userId, emailId);
    await Email.updateOne({ _id: email._id }, { $set: { snoozedUntil: untilDate } });
    return { ok: true, snoozedUntil: untilDate.toISOString() };
  });

  fastify.post('/:emailId/unsnooze', async (request) => {
    const { emailId } = request.params as { emailId: string };
    objectIdSchema.parse(emailId);
    const { email } = await requireOwnedEmail(request.user.userId, emailId);
    await Email.updateOne({ _id: email._id }, { $unset: { snoozedUntil: '' } });
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
