import { Redis as RealRedis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { env } from './env.js';

const useMock = env.REDIS_URL === 'mock';
const Redis = useMock ? RedisMock : RealRedis;

export const redis = useMock
  ? new Redis()
  : new RealRedis(env.REDIS_URL, {
      // Antes `maxRetriesPerRequest: null` → si Redis no volvía, los comandos quedaban
      // colgados PARA SIEMPRE (health/refresh/sync/cache zombis). Finito + timeouts →
      // degrada rápido (error/503) en vez de colgar. (BullMQ, cuando se sume en #16,
      // usará su PROPIA conexión con maxRetriesPerRequest:null.)
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 10000,
      commandTimeout: 5000,
    });

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
