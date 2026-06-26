import type { FastifyInstance } from 'fastify';
import { renderMetrics } from '../lib/metrics.js';

export default function metricsRoutes(fastify: FastifyInstance) {
  // Público (sin auth): un scraper de Prometheus no tiene JWT. Restringir por red en prod.
  fastify.get('/', { config: { requiresAuth: false } }, (_request, reply) => {
    void reply.header('Content-Type', 'text/plain; version=0.0.4');
    return renderMetrics();
  });
}
