import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/authz.js';
import { getStorageConfigPublic, setStorageConfig } from '../services/storage/index.js';

// PR-B: sólo `local` (sin secretos). `s3` se habilita en PR-D (endpoint+bucket+keys cifradas).
const storageConfigSchema = z.object({ providerType: z.literal('local') }).strict();

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

  // Config del storage de adjuntos (wizard Paso 1). GET sin secretos.
  fastify.get('/config/storage', async () => {
    return getStorageConfigPublic();
  });

  fastify.patch('/config/storage', async (request) => {
    const body = storageConfigSchema.parse(request.body);
    return setStorageConfig(body, request.user.userId);
  });
}
