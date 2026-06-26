import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../lib/authz.js';

/**
 * Rutas del panel de administración. TODO lo de acá exige rol `admin` (verificado en DB,
 * no por el claim del JWT). Por ahora sólo un endpoint de sondeo; los PRs siguientes suman
 * la config de providers (storage, provisión de buzones, etc.). El feature-gating real vive
 * acá (backend), no sólo en la UI.
 */
export default function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request) => {
    await requireAdmin(request.user.userId);
  });

  // Sondeo: confirma que el solicitante es admin (la UI lo usa para mostrar /admin).
  fastify.get('/whoami', () => {
    return { role: 'admin' as const };
  });
}
