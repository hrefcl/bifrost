import type { FastifyInstance } from 'fastify';
import { SignatureImage } from '../models/SignatureImage.js';

/**
 * Sirve PÚBLICAMENTE (sin auth) las imágenes de firma externalizadas: los clientes de correo del
 * destinatario (Gmail, etc.) las cargan sin credenciales al renderizar el correo. Sólo se sirven
 * bytes de imagen ráster (validados al subir) con `nosniff` + CSP restrictiva → sin riesgo de XSS.
 */
export default function signatureImageRoutes(fastify: FastifyInstance) {
  fastify.get('/:id', { config: { requiresAuth: false } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not found' });
    }
    const img = await SignatureImage.findById(id);
    if (!img) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not found' });
    }
    // `img.data` (findById, sin lean) es un Buffer Node → Fastify lo envía como bytes crudos.
    void reply
      .header('Content-Type', img.contentType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(img.data);
  });
}
