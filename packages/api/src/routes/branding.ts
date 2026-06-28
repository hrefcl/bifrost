import type { FastifyInstance } from 'fastify';
import { getBranding, toPublicBranding } from '../services/branding.js';

/**
 * Branding PÚBLICO (sin auth): lo consume el cliente en el boot (incluida la pantalla de login,
 * antes de autenticarse) para aplicar nombre/logo/color de empresa. Sólo expone la vista pública
 * (sin metadatos de auditoría). La ESCRITURA vive en /api/admin/config/branding (requiere admin).
 */
export default function brandingRoutes(fastify: FastifyInstance) {
  fastify.get('/', { config: { requiresAuth: false } }, async () => {
    return toPublicBranding(await getBranding());
  });
}
