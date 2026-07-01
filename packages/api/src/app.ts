import Fastify from 'fastify';
import { ZodError } from 'zod';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { env } from './config/env.js';
import { loggerOptions } from './config/logger.js';
import authPlugin from './plugins/auth.js';
import complianceGatePlugin from './plugins/compliance-gate.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import setupRoutes from './routes/setup.js';
import accountRoutes from './routes/accounts.js';
import emailRoutes from './routes/emails.js';
import draftRoutes from './routes/drafts.js';
import contactRoutes from './routes/contacts.js';
import calendarRoutes from './routes/calendar.js';
import scheduleRoutes from './routes/schedule.js';
import schedulePublicRoutes from './routes/schedule-public.js';
import adminRoutes from './routes/admin.js';
import brandingRoutes from './routes/branding.js';
import configRoutes from './routes/config.js';
import signatureImageRoutes from './routes/signature-images.js';
import attachmentRoutes from './routes/attachments.js';
import metricsRoutes from './routes/metrics.js';
import meetRoutes, { meetAdminRoutes } from './routes/meet.js';
import complianceRoutes from './routes/compliance.js';
import { counters, observeDuration } from './lib/metrics.js';

export async function buildApp() {
  const app = Fastify({
    // Logger compartido (estructurado + redacción de secretos). Fastify agrega reqId.
    logger: loggerOptions,
    trustProxy: true,
  });

  // Los handlers de error/404 se definen ANTES de registrar las rutas: por la
  // encapsulación de Fastify, un setErrorHandler posterior NO aplica a los plugins
  // ya registrados (los ZodError de las rutas saldrían como 500 en vez de 400).
  app.setErrorHandler((error, _request, reply) => {
    // Errores de validación (z.parse) → 400, no 500.
    if (error instanceof ZodError) {
      void reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues: error.issues,
      });
      return;
    }
    const err = error as Error & { statusCode?: number; code?: string };
    const statusCode = err.statusCode ?? 500;
    // Sólo los 5xx son errores reales del servidor; 4xx no deben ensuciar los logs de error.
    if (statusCode >= 500) {
      app.log.error(err);
    } else {
      app.log.warn({ err: err.message, statusCode });
    }
    const message =
      statusCode >= 500 && env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message;
    // `code` (string) se incluye si el error lo trae (p.ej. ComplianceError: VERSION_STALE,
    // COMPLIANCE_REQUIRED) → el frontend puede discriminar sin parsear el mensaje. No para 5xx en prod.
    const code =
      typeof err.code === 'string' && !(statusCode >= 500 && env.NODE_ENV === 'production')
        ? err.code
        : undefined;
    void reply.code(statusCode).send({
      statusCode,
      error: err.name,
      message,
      ...(code ? { code } : {}),
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Route not found',
    });
  });

  // Contadores globales para /metrics.
  app.addHook('onResponse', (_request, reply, done) => {
    counters.requests++;
    if (reply.statusCode >= 500) counters.errors5xx++;
    observeDuration(reply.elapsedTime / 1000); // elapsedTime viene en ms
    done();
  });

  // CSP. Cuando Meet está PROVISIONADO (flag deploy-time `MEET_PROVISIONED`, lo setea el provisioner al
  // habilitar la capacidad Meet — NO depende del wsUrl ni del toggle DB), `connect-src` suma `wss:` para
  // permitir que el admin apunte a CUALQUIER LiveKit (bundled/externo/Cloud) EN RUNTIME sin redeploy
  // (review F3.7 B-H1/D-H1). `script-src 'self'` ya contiene el vector XSS real → el aflojamiento a `wss:`
  // es marginal y deploy-gated. Meet NO provisionado → `'self'` byte-idéntico. Esta CSP de helmet aplica a
  // respuestas del API; la del SPA (nginx) es la que realmente habilita el wss del documento — NO alinearlas.
  const meetProvisioned = (process.env.MEET_PROVISIONED ?? '').trim().length > 0;
  const connectSrc = ["'self'", ...(meetProvisioned ? ['wss:'] : [])];
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc,
      },
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);

  // Upload de adjuntos: cap de tamaño a nivel plugin (defensa anti-OOM/DoS) + 1 archivo por request.
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // Rate limit global por IP. Configurable por env para no estrangular el harness E2E (suite
  // serial completa desde una sola IP = localhost, ~cientos de requests en una ventana de 1min);
  // en prod el default 100/min se mantiene. NO afecta a los límites por-ruta de auth (login/refresh).
  // Validamos el env: un valor no numérico (typo) NO debe caer al default interno de fastify
  // (1000/min) ni dejar el límite inoperante — cae al 100 declarado (review B+D).
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? '100');
  await app.register(rateLimit, {
    max: Number.isFinite(rateLimitMax) && rateLimitMax > 0 ? rateLimitMax : 100,
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    skipOnError: true,
  });

  await app.register(setupRoutes, { prefix: '/api/setup' });
  await app.register(authPlugin);
  // El gate de compliance se registra INMEDIATAMENTE después de authPlugin: su hook onRequest corre
  // tras el de auth (orden de registro) → request.user ya está poblado (DESIGN §3.4).
  await app.register(complianceGatePlugin);

  await app.register(healthRoutes, { prefix: '/api/health' });
  await app.register(metricsRoutes, { prefix: '/api/metrics' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(accountRoutes, { prefix: '/api/accounts' });
  await app.register(emailRoutes, { prefix: '/api/emails' });
  await app.register(draftRoutes, { prefix: '/api/drafts' });
  await app.register(contactRoutes, { prefix: '/api/contacts' });
  await app.register(calendarRoutes, { prefix: '/api/calendar' });
  await app.register(scheduleRoutes, { prefix: '/api/schedule' });
  await app.register(schedulePublicRoutes, { prefix: '/api/schedule/public' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(brandingRoutes, { prefix: '/api/branding' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(signatureImageRoutes, { prefix: '/api/signature-images' });
  await app.register(attachmentRoutes, { prefix: '/api/attachments' });
  await app.register(meetRoutes, { prefix: '/api/meet' });
  await app.register(meetAdminRoutes, { prefix: '/api/admin/meet' });
  await app.register(complianceRoutes, { prefix: '/api/compliance' });

  return app;
}
