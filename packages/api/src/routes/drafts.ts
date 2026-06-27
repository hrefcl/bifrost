import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Draft } from '../models/Draft.js';
import { Account } from '../models/Account.js';
import { AttachmentBlob } from '../models/AttachmentBlob.js';
import { sendDraft } from '../services/smtp.js';
import { appendToSent } from '../services/imap.js';
import { randomToken } from '../config/crypto.js';
import { requireOwnedAccount, requireOwnedEmail, OwnershipError } from '../lib/authz.js';
import { sanitizeEmailHtml, plainTextFromHtml } from '../lib/sanitizeHtml.js';
import type { StoredDraftAttachment } from '../models/Draft.js';
import type { Draft as DraftDto } from '@webmail6/shared';

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);

// Topes de recursos del draft: sin esto, un cliente puede mandar miles de attachmentIds
// válidos → el envío los carga TODOS en RAM a la vez (Promise.all en smtp). Con 25MB/archivo
// eso es un DoS de memoria. Acotamos cantidad y tamaño TOTAL (típico límite de mensaje SMTP).
const MAX_ATTACHMENTS = 25;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

class PayloadTooLargeError extends Error {
  statusCode = 413;
}

/**
 * Resuelve ids de AttachmentBlob a DraftAttachment[] VALIDANDO OWNERSHIP: todos los blobs
 * deben ser del usuario (si alguno no existe/no es suyo → 404, sin filtrar existencia). El
 * draft guarda la metadata + storageKey + providerType (provider-bound), nunca confía en datos
 * de adjunto que mande el cliente directamente. Acota cantidad y tamaño total (anti-DoS).
 */
async function resolveAttachments(
  userId: string,
  ids?: string[]
): Promise<StoredDraftAttachment[]> {
  if (!ids || ids.length === 0) return [];
  // DEDUP: un blob aparece como mucho una vez en el draft (ids repetidos no duplican el
  // adjunto en el raw). Set preserva el orden de primera aparición.
  const unique = [...new Set(ids)];
  // Defensa en profundidad: el schema ya acota con .max(), pero re-validamos acá por si
  // se llama el helper desde otro path.
  if (unique.length > MAX_ATTACHMENTS) {
    throw new PayloadTooLargeError(`Too many attachments (max ${String(MAX_ATTACHMENTS)})`);
  }
  const blobs = await AttachmentBlob.find({ _id: { $in: unique }, userId }).lean();
  if (blobs.length !== unique.length) {
    throw new OwnershipError('Attachment not found');
  }
  const byId = new Map(blobs.map((b) => [b._id.toString(), b]));
  let totalBytes = 0;
  const resolved = unique.map((id) => {
    const b = byId.get(id);
    if (!b) throw new OwnershipError('Attachment not found');
    totalBytes += b.size;
    return {
      blobId: b._id.toString(),
      filename: b.filename,
      contentType: b.contentType,
      size: b.size,
      storageKey: b.storageKey,
      providerType: b.providerType,
    };
  });
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new PayloadTooLargeError('Attachments exceed total size limit (25MB)');
  }
  return resolved;
}

const addressSchema = z.object({
  name: z.string().optional(),
  address: z.string().email(),
});

const draftBodySchema = z.object({
  accountId: objectIdSchema,
  to: z.array(addressSchema).default([]),
  cc: z.array(addressSchema).optional(),
  bcc: z.array(addressSchema).optional(),
  subject: z.string().default(''),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  replyToEmailId: objectIdSchema.optional(),
  replyToMessageId: z.string().optional(),
  replyToReferences: z.array(z.string()).optional(),
  // ids de AttachmentBlob ya subidos (POST /api/attachments). El backend resuelve y valida
  // ownership; el cliente NUNCA manda filename/size/storageKey de adjunto directamente.
  // .max() acota la cantidad ANTES de tocar la DB (gate barato anti-DoS).
  attachmentIds: z.array(objectIdSchema).max(MAX_ATTACHMENTS).optional(),
});

function serializeDraft(doc: import('../models/Draft.js').IDraft): DraftDto {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    accountId: doc.accountId.toString(),
    to: doc.to,
    cc: doc.cc,
    bcc: doc.bcc,
    subject: doc.subject,
    bodyHtml: doc.bodyHtml,
    bodyText: doc.bodyText,
    // DTO público: sólo metadata + blobId. storageKey/providerType quedan server-side.
    attachments: doc.attachments.map((a) => ({
      blobId: a.blobId,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })),
    replyTo: doc.replyTo
      ? {
          emailId: doc.replyTo.emailId?.toString() ?? '',
          messageId: doc.replyTo.messageId,
          references: doc.replyTo.references,
        }
      : undefined,
    includeSignature: doc.includeSignature,
    status: doc.status,
    lastModifiedAt: doc.lastModifiedAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
  };
}

export default function draftRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request) => {
    // Sólo borradores accionables: los 'sent' ya viven en la carpeta Sent.
    const drafts = await Draft.find({
      userId: request.user.userId,
      status: { $in: ['editing', 'failed'] },
    }).sort({ lastModifiedAt: -1 });
    return drafts.map(serializeDraft);
  });

  fastify.post('/', async (request) => {
    const body = draftBodySchema.parse(request.body);
    await requireOwnedAccount(request.user.userId, body.accountId);
    // Si referencia un email para reply/forward, debe ser del propio usuario.
    if (body.replyToEmailId) {
      await requireOwnedEmail(request.user.userId, body.replyToEmailId);
    }

    const html = body.bodyHtml ? sanitizeEmailHtml(body.bodyHtml) : undefined;
    const attachments = await resolveAttachments(request.user.userId, body.attachmentIds);
    const draft = await Draft.create({
      userId: request.user.userId,
      accountId: body.accountId,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      bodyHtml: html,
      bodyText: body.bodyText ?? (html ? plainTextFromHtml(html) : undefined),
      attachments,
      replyTo: body.replyToMessageId
        ? {
            emailId: body.replyToEmailId,
            messageId: body.replyToMessageId,
            references: body.replyToReferences ?? [],
          }
        : undefined,
      status: 'editing',
      lastModifiedAt: new Date(),
    });
    return serializeDraft(draft);
  });

  fastify.get('/:draftId', async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    objectIdSchema.parse(draftId);
    const draft = await Draft.findOne({ _id: draftId, userId: request.user.userId });
    if (!draft) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Draft not found' });
    }
    return serializeDraft(draft);
  });

  fastify.patch('/:draftId', async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    objectIdSchema.parse(draftId);
    // accountId NO es editable por PATCH (se omite del schema → no mass-assignment).
    const body = draftBodySchema.omit({ accountId: true }).partial().parse(request.body);

    const draft = await Draft.findOne({ _id: draftId, userId: request.user.userId });
    if (!draft) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Draft not found' });
    }
    // No editar mientras se está enviando: revertir 'sending'→'editing' y limpiar el
    // sentMessageId reabriría la ventana de doble envío (otro /send podría reclamarlo).
    if (draft.status === 'sending') {
      return reply
        .code(409)
        .send({ statusCode: 409, error: 'Conflict', message: 'Draft is being sent' });
    }

    if (body.to !== undefined) draft.to = body.to;
    if (body.cc !== undefined) draft.cc = body.cc;
    if (body.bcc !== undefined) draft.bcc = body.bcc;
    if (body.subject !== undefined) draft.subject = body.subject;
    if (body.bodyHtml !== undefined) draft.bodyHtml = sanitizeEmailHtml(body.bodyHtml);
    if (body.bodyText !== undefined) draft.bodyText = body.bodyText;
    if (body.attachmentIds !== undefined) {
      draft.attachments = await resolveAttachments(request.user.userId, body.attachmentIds);
    }
    // Editar un draft 'sent'/'failed' lo vuelve editable (y descarta el sentMessageId
    // viejo para que un nuevo envío genere uno fresco).
    if (draft.status !== 'editing') {
      draft.status = 'editing';
      draft.sentMessageId = undefined;
      draft.sentAt = undefined;
    }
    draft.lastModifiedAt = new Date();
    await draft.save();
    return serializeDraft(draft);
  });

  fastify.delete('/:draftId', async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    objectIdSchema.parse(draftId);
    // No borrar un draft que se está enviando (race: borrarlo mientras /send lo procesa
    // dejaría el envío sin registro). El filtro excluye 'sending'.
    const result = await Draft.deleteOne({
      _id: draftId,
      userId: request.user.userId,
      status: { $ne: 'sending' },
    });
    if (result.deletedCount === 0) {
      const exists = await Draft.exists({ _id: draftId, userId: request.user.userId });
      if (exists) {
        return reply
          .code(409)
          .send({ statusCode: 409, error: 'Conflict', message: 'Draft is being sent' });
      }
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Draft not found' });
    }
    return { ok: true };
  });

  fastify.post('/:draftId/send', async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    objectIdSchema.parse(draftId);
    const userId = request.user.userId;

    // Transición ATÓMICA editing|failed → sending: si no matchea, el draft ya está
    // en 'sending' (en curso) o 'sent' (enviado) → evita el doble envío por concurrencia
    // o por reintento de un draft ya enviado.
    const claimed = await Draft.findOneAndUpdate(
      { _id: draftId, userId, status: { $in: ['editing', 'failed'] } },
      { $set: { status: 'sending', sendingSince: new Date() } },
      { new: true }
    );
    if (!claimed) {
      const existing = await Draft.findOne({ _id: draftId, userId });
      if (!existing) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Draft not found' });
      }
      if (existing.status === 'sent') {
        // Idempotente: ya se envió; devolvemos el messageId persistido.
        return { ok: true, alreadySent: true, messageId: existing.sentMessageId };
      }
      return reply
        .code(409)
        .send({ statusCode: 409, error: 'Conflict', message: 'Draft is already being sent' });
    }

    // Debe tener al menos un destinatario.
    const recipients = claimed.to.length + (claimed.cc?.length ?? 0) + (claimed.bcc?.length ?? 0);
    if (recipients === 0) {
      await Draft.updateOne(
        { _id: claimed._id },
        { $set: { status: 'editing' }, $unset: { sendingSince: 1 } }
      );
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'Draft has no recipients' });
    }

    const account = await Account.findOne({ _id: claimed.accountId, userId });
    if (!account) {
      await Draft.updateOne(
        { _id: claimed._id },
        { $set: { status: 'failed' }, $unset: { sendingSince: 1 } }
      );
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Account not found' });
    }

    // Message-ID determinista, persistido ANTES de enviar (dedupe en reintentos).
    const domain = account.email.split('@')[1] ?? 'localhost';
    const messageId = claimed.sentMessageId ?? `<${randomToken(16)}@${domain}>`;
    if (!claimed.sentMessageId) {
      await Draft.updateOne({ _id: claimed._id }, { $set: { sentMessageId: messageId } });
    }

    try {
      const result = await sendDraft(account, claimed, messageId);
      await Draft.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: 'sent',
            sentAt: new Date(),
            sentMessageId: result.messageId,
            lastModifiedAt: new Date(),
          },
          $unset: { sendingSince: 1 },
        }
      );
      // Copia a Sent: best-effort, no debe fallar el envío.
      try {
        await appendToSent(account, result.raw);
      } catch (appendErr) {
        request.log.warn({ err: appendErr }, 'append to Sent failed');
      }
      return { ok: true, messageId: result.messageId };
    } catch (err) {
      await Draft.updateOne(
        { _id: claimed._id },
        { $set: { status: 'failed' }, $unset: { sendingSince: 1 } }
      );
      throw err;
    }
  });
}

/**
 * Reclama borradores colgados en 'sending' (proceso murió a mitad de envío) y los
 * revierte a 'failed' para que el usuario pueda reintentar. Pensado para un barrido periódico.
 */
export async function recoverStuckDrafts(maxAgeMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const res = await Draft.updateMany(
    { status: 'sending', sendingSince: { $lt: cutoff } },
    { $set: { status: 'failed' }, $unset: { sendingSince: 1 } }
  );
  return res.modifiedCount;
}
