import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/authz.js';
import { getStorageConfigPublic, setStorageConfig } from '../services/storage/index.js';
import { isSafeS3Endpoint } from '../services/storage/s3.js';

// `local` (sin config) o `s3` (endpoint opcional + bucket/region/keys; el secret se cifra al
// persistir). Union discriminada → `.strict()` rechaza campos extra y mezclas inválidas.
const storageConfigSchema = z.discriminatedUnion('providerType', [
  z.object({ providerType: z.literal('local') }).strict(),
  z
    .object({
      providerType: z.literal('s3'),
      s3: z
        .object({
          // Endpoint estructuralmente seguro: sólo http/https, sin userinfo/query/fragment/path
          // ni IP de metadata cloud (ver isSafeS3Endpoint). Rechaza ftp://, file://, etc.
          endpoint: z.string().url().refine(isSafeS3Endpoint, 'endpoint S3 inválido').optional(),
          bucket: z.string().min(1),
          // region se interpola en la URL del host AWS por defecto → restringimos al charset
          // de región (evita inyección de host/query/path).
          region: z
            .string()
            .min(1)
            .regex(/^[a-z0-9-]+$/, 'región inválida'),
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
