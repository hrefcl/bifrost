import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AttachmentBlob } from '../models/AttachmentBlob.js';
import { getActiveStorage, providerForType, newStorageKey } from '../services/storage/index.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB (alineado con MAX_MESSAGE_BYTES del parseo IMAP)
const objectId = z.string().regex(/^[a-f0-9]{24}$/i);

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
    const blob = await AttachmentBlob.findOne({ _id: id, userId: request.user.userId });
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
