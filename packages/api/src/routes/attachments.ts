import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AttachmentBlob } from '../models/AttachmentBlob.js';
import { getActiveStorage, providerForType, newStorageKey } from '../services/storage/index.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB (alineado con MAX_MESSAGE_BYTES del parseo IMAP)
const objectId = z.string().regex(/^[a-f0-9]{24}$/i);

/**
 * Cuota de blobs por usuario (anti disk-fill DoS): el cap de 25MB/archivo y el rate-limit
 * acotan el RITMO, no el TOTAL. Sin esto, un usuario autenticado podría subir blobs sin
 * adjuntarlos y la gracia del GC los retiene → llenar disco. Override por env (entero > 0;
 * valores inválidos/0/negativos caen al default). Se lee por request para ajustarlo/testearlo.
 */
function maxBlobsPerUser(): number {
  const n = Number(process.env.ATTACHMENTS_MAX_PER_USER);
  return Number.isInteger(n) && n > 0 ? n : 1000;
}

/** Content-Disposition seguro: SIEMPRE attachment + filename ASCII-saneado (anti header-injection). */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
  return `attachment; filename="${ascii}"`;
}

export default function attachmentRoutes(fastify: FastifyInstance) {
  /**
   * Sube un adjunto al storage ACTIVO y crea un AttachmentBlob dueño del usuario. Devuelve el
   * id del blob (NO el storageKey) — el cliente referencia adjuntos por id, nunca por key cruda.
   */
  fastify.post('/', async (request, reply) => {
    // Itera TODO el multipart (no sólo el primer file): exige EXACTAMENTE 1 file llamado
    // 'file' y RECHAZA fields o archivos extra. Recién guarda tras consumir/validar todo el
    // request — un 2º archivo (aunque sea >25MB) no se acepta ni deja un blob a medias.
    let buf: Buffer | undefined;
    let filename = '';
    let mimetype = 'application/octet-stream';
    let tooLarge = false;
    for await (const part of request.parts()) {
      if (part.type !== 'file') {
        return reply
          .code(400)
          .send({ statusCode: 400, error: 'Bad Request', message: 'Unexpected form field' });
      }
      if (buf !== undefined || part.fieldname !== 'file') {
        await part.toBuffer().catch(() => undefined); // drenar para no colgar el stream
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Expected exactly one file field named "file"',
        });
      }
      const b = await part.toBuffer();
      if (part.file.truncated || b.length > MAX_BYTES) tooLarge = true;
      buf = b;
      filename = part.filename;
      mimetype = part.mimetype || 'application/octet-stream';
    }
    if (buf === undefined) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'No file' });
    }
    if (tooLarge) {
      return reply
        .code(413)
        .send({ statusCode: 413, error: 'Payload Too Large', message: 'Attachment too large' });
    }

    const storageKey = newStorageKey();
    const active = await getActiveStorage();
    await active.put(storageKey, buf);

    const blob = await AttachmentBlob.create({
      storageKey,
      providerType: active.type,
      userId: request.user.userId,
      filename,
      contentType: mimetype,
      size: buf.length,
      refCount: 1,
    });

    // CUOTA anti disk-fill, OPTIMISTA con rollback (no un check-antes racy, ni un counter con
    // drift): tras crear el blob, contamos los blobs del usuario; si excede el cap, deshacemos
    // (borramos doc + bytes). Bajo N uploads concurrentes, todos crean y luego los que ven el
    // count por encima del cap hacen rollback → el estado CONVERGE a max (derivado del count
    // REAL, sin contador que pueda divergir). El cap cuenta TODOS los blobs del usuario (no sólo
    // 'active') porque todos ocupan disco. Ver review B/D del PR de cuota.
    const total = await AttachmentBlob.countDocuments({ userId: request.user.userId });
    if (total > maxBlobsPerUser()) {
      await AttachmentBlob.deleteOne({ _id: blob._id }).catch(() => undefined);
      await active.delete(storageKey).catch(() => undefined);
      return reply.code(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Attachment storage quota reached. Quitá adjuntos de borradores y reintentá.',
      });
    }

    return {
      id: blob._id.toString(),
      filename: blob.filename,
      contentType: blob.contentType,
      size: blob.size,
    };
  });

  /** Descarga un adjunto propio. Ownership (404 si ajeno) + lectura provider-bound + headers seguros. */
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    // status $ne 'deleting': un blob que el GC está reclamando no debe servirse (sus bytes
    // pueden desaparecer en cualquier momento). Defensa; en la práctica un blob descargable
    // está referenciado por un draft y nunca entra en lease.
    const blob = await AttachmentBlob.findOne({
      _id: id,
      userId: request.user.userId,
      status: { $ne: 'deleting' },
    });
    if (!blob) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Attachment not found' });
    }
    const provider = await providerForType(blob.providerType);
    const buf = await provider.get(blob.storageKey);
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Content-Type', blob.contentType || 'application/octet-stream');
    void reply.header('Content-Disposition', contentDisposition(blob.filename));
    return reply.send(buf);
  });
}
