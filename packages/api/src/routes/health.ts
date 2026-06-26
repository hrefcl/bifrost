import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { redis } from '../config/redis.js';

export default function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/', { config: { requiresAuth: false } }, async (_request, reply) => {
    const mongoState = mongoose.connection.readyState;
    const mongoHealthy = mongoState === mongoose.ConnectionStates.connected;
    let redisHealthy = false;
    try {
      await redis.ping();
      redisHealthy = true;
    } catch {
      redisHealthy = false;
    }

    const healthy = mongoHealthy && redisHealthy;
    const statusCode = healthy ? 200 : 503;

    void reply.code(statusCode).send({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        mongodb: mongoHealthy ? 'connected' : 'disconnected',
        redis: redisHealthy ? 'connected' : 'disconnected',
      },
    });
  });
}
