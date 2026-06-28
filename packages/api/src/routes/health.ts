import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { redis } from '../config/redis.js';
import { Account } from '../models/Account.js';

async function checkDeps(): Promise<{ mongoHealthy: boolean; redisHealthy: boolean }> {
  const mongoHealthy = mongoose.connection.readyState === mongoose.ConnectionStates.connected;
  let redisHealthy = false;
  try {
    await redis.ping();
    redisHealthy = true;
  } catch {
    redisHealthy = false;
  }
  return { mongoHealthy, redisHealthy };
}

export default function healthRoutes(fastify: FastifyInstance) {
  // Liveness: el proceso atiende y sus dependencias DURAS (Mongo/Redis) responden.
  fastify.get('/', { config: { requiresAuth: false } }, async (_request, reply) => {
    const { mongoHealthy, redisHealthy } = await checkDeps();
    const healthy = mongoHealthy && redisHealthy;
    void reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        mongodb: mongoHealthy ? 'connected' : 'disconnected',
        redis: redisHealthy ? 'connected' : 'disconnected',
      },
    });
  });

  // Readiness: además de las deps duras, expone la SALUD DEL SYNC IMAP — un pod podía estar "healthy"
  // sin poder sincronizar correo (re-auditoría, HIGH de D). La salud IMAP se deriva de Account.status
  // (que el barrido de fondo actualiza periódicamente: active/syncing/error + lastSyncedAt), NO de un
  // connect IMAP EN VIVO: este endpoint es PÚBLICO/no-autenticado y un connect saliente a demanda
  // sería un vector de abuso/SSRF (forzar conexiones repetidas al IMAP del usuario → lockout del
  // proveedor) y flaky para una probe de k8s. Se exponen CONTEOS y antigüedad, NO `lastError` crudo
  // (evita info-leak de detalles del servidor en un endpoint público).
  fastify.get('/ready', { config: { requiresAuth: false } }, async (_request, reply) => {
    const { mongoHealthy, redisHealthy } = await checkDeps();

    let sync = {
      accounts: 0,
      active: 0,
      syncing: 0,
      error: 0,
      neverSynced: 0,
      stalestMinutes: null as number | null,
    };
    try {
      const aggs = await Account.aggregate<{
        accounts: number;
        active: number;
        syncing: number;
        error: number;
        neverSynced: number;
        oldest: Date | null;
      }>([
        { $match: { status: { $ne: 'disabled' } } },
        {
          $group: {
            _id: null,
            accounts: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            syncing: { $sum: { $cond: [{ $eq: ['$status', 'syncing'] }, 1, 0] } },
            error: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
            neverSynced: { $sum: { $cond: [{ $eq: ['$lastSyncedAt', null] }, 1, 0] } },
            oldest: { $min: '$lastSyncedAt' },
          },
        },
      ]);
      const agg = aggs.at(0);
      if (agg) {
        const stalestMinutes = agg.oldest
          ? Math.round((Date.now() - new Date(agg.oldest).getTime()) / 60000)
          : null;
        sync = {
          accounts: agg.accounts,
          active: agg.active,
          syncing: agg.syncing,
          error: agg.error,
          neverSynced: agg.neverSynced,
          stalestMinutes,
        };
      }
    } catch {
      /* si Mongo está caído ya se refleja en mongoHealthy; el bloque sync queda en 0. */
    }

    // Readiness (status code) depende SÓLO de las deps duras: con Mongo/Redis arriba el pod PUEDE
    // servir (UI + correo ya sincronizado). Errores de sync son por-cuenta/transitorios y NO deben
    // sacar el pod de rotación; se exponen para monitoreo/alertas (sync.status 'degraded').
    const ready = mongoHealthy && redisHealthy;
    const syncDegraded =
      sync.error > 0 || (sync.accounts > 0 && sync.neverSynced === sync.accounts);
    void reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      timestamp: new Date().toISOString(),
      services: {
        mongodb: mongoHealthy ? 'connected' : 'disconnected',
        redis: redisHealthy ? 'connected' : 'disconnected',
      },
      sync: { status: syncDegraded ? 'degraded' : 'ok', ...sync },
    });
  });
}
