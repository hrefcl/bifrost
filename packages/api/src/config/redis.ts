import { Redis as RealRedis } from 'ioredis';
import { createRequire } from 'node:module';
import { env } from './env.js';

function buildRedis(): RealRedis {
  if (env.REDIS_URL === 'mock') {
    // `ioredis-mock` es SÓLO para tests/E2E (devDependency). Se carga de forma PEREZOSA
    // (sólo cuando REDIS_URL=mock) para que NO entre al grafo de imports de producción:
    // así un Dockerfile multi-stage con `pnpm install --prod` (sin devDeps) no rompe el
    // boot por este import. Producción con Redis real nunca toca el paquete.
    const RedisMock = createRequire(import.meta.url)('ioredis-mock') as typeof RealRedis;
    return new RedisMock();
  }
  // Antes `maxRetriesPerRequest: null` → si Redis no volvía, los comandos quedaban colgados
  // PARA SIEMPRE (health/refresh/sync/cache zombis). Finito + timeouts → degrada rápido
  // (error/503) en vez de colgar. (BullMQ, cuando se sume en #16, usará su PROPIA conexión
  // con maxRetriesPerRequest:null.)
  return new RealRedis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 10000,
    commandTimeout: 5000,
  });
}

export const redis = buildRedis();

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
