import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/authz.js';
import { getStorageConfigPublic, setStorageConfig } from '../services/storage/index.js';

// `local` (sin config) o `s3` (endpoint opcional + bucket/region/keys; el secret se cifra al
// persistir). Union discriminada → `.strict()` rechaza campos extra y mezclas inválidas.
const storageConfigSchema = z.discriminatedUnion('providerType', [
  z.object({ providerType: z.literal('local') }).strict(),
  z
    .object({
      providerType: z.literal('s3'),
      s3: z
        .object({
          endpoint: z.string().url().optional(),
          bucket: z.string().min(1),
          region: z.string().min(1),
          accessKeyId: z.string().min(1),
          secretAccessKey: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);

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
