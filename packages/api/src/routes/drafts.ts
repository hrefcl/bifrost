import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Draft } from '../models/Draft.js';
import { Account } from '../models/Account.js';
import { User } from '../models/User.js';
import { AttachmentBlob } from '../models/AttachmentBlob.js';
import { sendDraft } from '../services/smtp.js';
import { checkOutboundLimit, maxRecipientsPerMessage } from '../services/outbound-limit.js';
import { appendToSent, syncFolderHeaders } from '../services/imap.js';
import { autoSaveContacts } from '../services/contacts.js';
import { randomToken } from '../config/crypto.js';
import { requireOwnedAccount, requireOwnedEmail, OwnershipError } from '../lib/authz.js';
import { providerForType } from '../services/storage/index.js';
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
  // CLAIM atómico contra el GC: marca lastReferencedAt=now SÓLO en blobs propios y 'active'.
  // Si un blob no es del usuario, no existe, o el GC lo dejó en 'deleting', no matchea →
  // matchedCount < unique.length → rechazo. Esto cierra el lado "attach" del race del sweep:
  // un blob recién referenciado queda con lastReferencedAt fresco (el GC ya no lo elegirá), y
  // un blob que el GC está borrando ('deleting') no se puede adjuntar.
  const now = new Date();
  const claim = await AttachmentBlob.updateMany(
    { _id: { $in: unique }, userId, status: 'active' },
    { $set: { lastReferencedAt: now } }
  );
  if (claim.matchedCount !== unique.length) {
    throw new OwnershipError('Attachment not found');
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
    // 'sent' es TERMINAL: el correo ya salió (la copia canónica vive en IMAP Sent) y el GC
    // limpia sus adjuntos tras la gracia — reabrirlo a 'editing' podría dejar attachments
    // apuntando a blobs ya borrados (review B/D). Para re-enviar, se compone uno nuevo.
    if (draft.status === 'sent') {
      return reply
        .code(409)
        .send({ statusCode: 409, error: 'Conflict', message: 'Draft already sent' });
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
    // Editar un draft 'failed' lo vuelve editable para reintentar (descarta el sentMessageId
    // viejo para que un nuevo envío genere uno fresco). 'sent' ya se rechazó arriba.
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

    // Tope de destinatarios por MENSAJE (anti amplificación): sin esto un solo draft con miles de
    // destinatarios pasa el schema y agota el cupo de una. 400 (validación), revierte a editing. [D-MED]
    const maxPerMsg = maxRecipientsPerMessage();
    if (recipients > maxPerMsg) {
      request.log.warn(
        { accountId: String(claimed.accountId), userId, recipients, max: maxPerMsg },
        'outbound: mensaje con demasiados destinatarios RECHAZADO'
      );
      await Draft.updateOne(
        { _id: claimed._id },
        { $set: { status: 'editing' }, $unset: { sendingSince: 1 } }
      );
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Demasiados destinatarios en un mensaje (${String(recipients)}); el máximo es ${String(maxPerMsg)}. Dividí el envío.`,
      });
    }

    // Rate-limit de envío saliente POR BUZÓN (anti spam-cannon): acota destinatarios/ventana vía Redis.
    // Si se excede, revertimos el draft a 'editing' (lo reclamamos a 'sending' arriba) y devolvemos 429
    // con Retry-After. Guardrail del producto para que un abuso (cuenta comprometida) no escale a miles.
    const limit = await checkOutboundLimit(String(claimed.accountId), recipients);
    if (limit.degraded) {
      // Fail-open: Redis caído → el cap anti-abuso está OFF. El operador debe saberlo CON la causa raíz.
      request.log.error(
        { accountId: String(claimed.accountId), err: limit.degradedReason },
        'outbound rate-limit DEGRADED (Redis no disponible): envío permitido sin cap'
      );
    }
    if (!limit.allowed) {
      // Señal de posible abuso (cuenta comprometida / envío masivo) — visible para el operador.
      request.log.warn(
        {
          accountId: String(claimed.accountId),
          userId,
          scope: limit.scope,
          recipients,
          max: limit.limit,
        },
        'outbound rate-limit: envío BLOQUEADO por exceso de destinatarios'
      );
      await Draft.updateOne(
        { _id: claimed._id },
        { $set: { status: 'editing' }, $unset: { sendingSince: 1 } }
      );
      return reply
        .code(429)
        .header('Retry-After', String(limit.retryAfterSec ?? 60))
        .send({
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Límite de envío por ${limit.scope ?? 'ventana'} alcanzado (${String(limit.limit)} destinatarios). Reintentá en ${String(limit.retryAfterSec)}s.`,
        });
    }

    // Firma del usuario: se añade SERVER-SIDE al enviar (no al draft persistido) para preservar el
    // HTML rico que el editor TipTap del composer filtraría. Separador estándar "-- " (RFC 3676) que
    // marca el inicio de la firma. Se re-sanitiza el resultado (firma + cuerpo, ambos confiables).
    const user = await User.findById(userId).lean();
    const sig = user?.preferences.defaultSignature?.trim();
    if (user?.preferences.autoIncludeSignature && sig) {
      const sep = '<br><br><div data-bifrost-sig-sep="1">-- </div>';
      claimed.bodyHtml = sanitizeEmailHtml(`${claimed.bodyHtml ?? ''}${sep}${sig}`);
      claimed.bodyText = plainTextFromHtml(claimed.bodyHtml);
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
      // Copia a Sent: best-effort, no debe fallar el envío. El APPEND deja el mensaje en IMAP,
      // pero la vista Enviados lee de Mongo → hay que SINCRONIZAR el folder Sent para que el
      // mensaje recién enviado aparezca de inmediato (sin esto quedaba sólo en IMAP hasta el
      // próximo sync periódico: el usuario "no veía" su correo en Enviados).
      try {
        const sentFolderId = await appendToSent(account, result.raw);
        if (sentFolderId) {
          try {
            await syncFolderHeaders(account, sentFolderId);
          } catch (syncErr) {
            request.log.warn({ err: syncErr }, 'sync Sent after append failed');
          }
        }
      } catch (appendErr) {
        request.log.warn({ err: appendErr }, 'append to Sent failed');
      }
      // Auto-guardar destinatarios como contactos (estilo Gmail). Best-effort.
      try {
        await autoSaveContacts(userId, [
          ...claimed.to,
          ...(claimed.cc ?? []),
          ...(claimed.bcc ?? []),
        ]);
      } catch (contactErr) {
        request.log.warn({ err: contactErr }, 'auto-save contacts failed');
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

/**
 * Recolección de AttachmentBlobs huérfanos (MARK-AND-SWEEP con LEASE atómico, no refcount).
 *
 * Borra (bytes del provider + doc Mongo) los blobs que NO referencia ningún draft ACCIONABLE
 * (editing/failed/sending) y son más viejos que `maxAgeMs` (gracia desde el último uso).
 * Recupera: subidas descartadas, adjuntos de drafts borrados y de drafts 'sent' (terminal: el
 * envío SMTP ya construyó el MIME y no se relee — la copia vive en IMAP Sent; PATCH de 'sent'
 * se rechaza con 409, así que no hay re-edición que dependa del blob).
 *
 * Seguridad ante races (review B): el borrado NO es seguro si un attach concurrente referencia
 * el blob entre el "mark" y el "delete". Lo cerramos con un LEASE:
 *  1. CAS atómico active→deleting condicionado a lastReferencedAt < cutoff. Si un attach acaba
 *     de tocar el blob (lastReferencedAt=now), el CAS no matchea → se salta.
 *  2. Re-chequeo: ¿algún draft lo referencia ahora? Si sí → revertir a 'active', saltar.
 *  3. DOC-FIRST: borrar el DOC (deleteOne condicionado a 'deleting') ANTES que los bytes.
 *     resolveAttachments rechaza blobs 'deleting', así que ningún attach nuevo se engancha.
 * Orden de fallos: si deleteOne falla → bytes intactos, se revierte el lease para reintentar.
 * Si provider.delete falla DESPUÉS del deleteOne → el doc ya no existe: quedan bytes huérfanos
 * (leak inocuo, sin referencia), NO se revierte. Leases colgados por crash se recuperan por
 * deletingSince (ver más abajo).
 */
/** Un lease 'deleting' más viejo que esto se considera colgado (crash) y se recupera. */
const LEASE_TIMEOUT_MS = 10 * 60 * 1000;

export async function cleanupOrphanAttachments(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const now = Date.now();
  const cutoff = new Date(now - maxAgeMs);

  // (0a) Backfill defensivo de blobs pre-lease (sin status): tratarlos como 'active' con
  // lastReferencedAt=createdAt. Pipeline update (Mongo 4.2+). Tras la 1ª pasada no matchea nada.
  await AttachmentBlob.updateMany({ status: { $exists: false } }, [
    { $set: { status: 'active', lastReferencedAt: '$createdAt' } },
  ]);
  // (0b) Lease recovery: un blob 'deleting' viejo quedó colgado por un crash ANTES de borrar el
  // doc (en el orden doc-first los bytes aún existen) → reactivarlo para reintentar. Seguro:
  // nunca reactiva un blob cuyos bytes ya se borraron (en ese punto el doc ya no existe).
  await AttachmentBlob.updateMany(
    {
      status: 'deleting',
      $or: [
        { deletingSince: { $lt: new Date(now - LEASE_TIMEOUT_MS) } },
        { deletingSince: { $exists: false } }, // 'deleting' sin marca (bug/migración) → recuperar
      ],
    },
    { $set: { status: 'active' }, $unset: { deletingSince: 1 } }
  );

  // blobIds referenciados por un draft que AÚN podría leerlos: editing/failed (el usuario puede
  // enviarlo) o sending (se está leyendo). Los 'sent' SÍ se limpian (tras la gracia): el envío
  // SMTP ya construyó el MIME con el blob y nunca se vuelve a leer — appendToSent usa el raw, y
  // descargar un adjunto enviado va por IMAP Sent, no por el blob. Conservarlos para siempre era
  // peso muerto + bloqueaba la cuota por usuario (review B/D del PR de cuota). La gracia de
  // lastReferencedAt (seteado al adjuntar) da el margen de seguridad post-envío.
  const liveIds = await Draft.distinct('attachments.blobId', {
    status: { $in: ['editing', 'failed', 'sending'] },
  });
  const live = new Set(liveIds.map(String));

  const candidates = await AttachmentBlob.find({
    status: 'active',
    lastReferencedAt: { $lt: cutoff },
  })
    .select('_id storageKey providerType')
    .lean();

  let deleted = 0;
  for (const blob of candidates) {
    if (live.has(blob._id.toString())) continue;
    // (1) LEASE atómico: sólo si sigue 'active' Y no fue tocado por un attach reciente.
    const leased = await AttachmentBlob.findOneAndUpdate(
      { _id: blob._id, status: 'active', lastReferencedAt: { $lt: cutoff } },
      { $set: { status: 'deleting', deletingSince: new Date() } }
    );
    if (!leased) continue; // un attach lo tocó o ya está en borrado → saltar.

    // (2) Re-chequeo bajo lease: ¿apareció una referencia entre el snapshot inicial y el lease?
    let referenced: unknown;
    try {
      // Consistente con liveIds: un draft 'sent' NO protege (su blob ya es redundante).
      referenced = await Draft.exists({
        'attachments.blobId': blob._id.toString(),
        status: { $in: ['editing', 'failed', 'sending'] },
      });
    } catch {
      // No pudimos verificar → revertir el lease (bytes intactos) y reintentar luego.
      await AttachmentBlob.updateOne(
        { _id: blob._id, status: 'deleting' },
        { $set: { status: 'active' }, $unset: { deletingSince: 1 } }
      ).catch(() => undefined);
      continue;
    }
    if (referenced) {
      await AttachmentBlob.updateOne(
        { _id: blob._id },
        { $set: { status: 'active' }, $unset: { deletingSince: 1 } }
      ).catch(() => undefined);
      continue;
    }

    // (3) DOC-FIRST: borrar el documento ANTES que los bytes. El peor caso aceptable es un
    // leak de bytes huérfanos (inocuo), NO un doc 'active' apuntando a bytes inexistentes
    // (que sería adjuntable/descargable y rompería un envío). Si el deleteOne falla, los bytes
    // siguen intactos → revertimos el lease para reintentar.
    let delResult;
    try {
      // Condicionado a status:'deleting': si un lease recovery (o un proceso zombie reactivado)
      // ya devolvió el blob a 'active' o lo re-leaseó otro sweep, este delete NO matchea →
      // deletedCount 0 → no borramos sus bytes. Cierra el race del zombie (review D).
      delResult = await AttachmentBlob.deleteOne({ _id: blob._id, status: 'deleting' });
    } catch {
      await AttachmentBlob.updateOne(
        { _id: blob._id, status: 'deleting' },
        { $set: { status: 'active' }, $unset: { deletingSince: 1 } }
      ).catch(() => undefined);
      continue;
    }
    if (delResult.deletedCount === 0) continue; // el lease ya no es nuestro → no tocar bytes.
    deleted++;
    // (4) Bytes: best-effort. El doc ya no existe → si esto falla, quedan bytes huérfanos
    // (sin doc que los referencie ni que se pueda adjuntar/descargar). No revertimos nada.
    try {
      const provider = await providerForType(blob.providerType);
      await provider.delete(blob.storageKey);
    } catch {
      // Bytes huérfanos: leak inocuo (no hay ref). Se acepta como costo de no romper docs.
      continue;
    }
  }
  return deleted;
}
