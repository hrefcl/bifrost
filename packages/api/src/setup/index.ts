import Fastify from 'fastify';
import { ZodError } from 'zod';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { loggerOptions } from '../config/logger.js';
import { env } from '../config/env.js';
import setupRoutes from '../routes/setup.js';

export async function buildSetupApp() {
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: true,
  });

  // Handlers antes de registrar rutas (encapsulación Fastify).
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues: error.issues,
      });
      return;
    }
    const err = error as Error & { statusCode?: number };
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      app.log.error(err);
    } else {
      app.log.warn({ err: err.message, statusCode });
    }
    void reply.code(statusCode).send({
      statusCode,
      error: err.name,
      message: err.message,
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Application setup is required',
    });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
      },
    },
  });

  // CORS acotado al origen del frontend (no `origin: true`/cualquiera): aunque /api/setup sólo está
  // activo antes de configurar el sistema, reflejar cualquier origin permitía a una página hostil
  // interactuar con el wizard si la víctima la visitaba durante esa ventana (review D). Espeja app.ts.
  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(setupRoutes, { prefix: '/api/setup' });

  return app;
}
