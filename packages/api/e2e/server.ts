/**
 * Servidor E2E full-stack (TD-E2E).
 *
 * Arranca la API REAL (`buildApp`) como un proceso normal, pero respaldada por
 * infraestructura efímera y determinista:
 *   - MongoDB  → mongodb-memory-server (datos en RAM, se descartan al salir).
 *   - Redis    → ioredis-mock (REDIS_URL=mock).
 *   - IMAP/SMTP→ fakes en-proceso inyectados por el seam services/mail-transport.
 *
 * Playwright lo levanta como `webServer` junto al dev server de la web (que proxya /api
 * hacia :3000), y maneja el flujo login → sync → leer → enviar contra esta API real.
 *
 * Las variables de entorno se fijan ANTES de importar cualquier módulo que lea `env`
 * (config/env valida con zod al importarse), por eso todo lo dependiente de env se carga
 * con import() dinámico tras setearlas.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const PORT = Number(process.env.E2E_API_PORT ?? 3000);

async function main(): Promise<void> {
  // 1) Infra efímera + env mínima (NODE_ENV != production → cookies no-Secure sobre http
  //    localhost, y mensajes de error verbosos).
  const mongo = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongo.getUri();
  process.env.REDIS_URL = 'mock';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'e2e-jwt-secret-e2e-jwt-secret-0123456789';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
  // Access token de vida corta para ejercitar el interceptor de refresh-on-401 del front
  // (en prod es 15m). El flujo feliz dura <1s; el test del interceptor espera a que expire.
  process.env.JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? '3s';

  // 2) Inyectar los transportes fake en el seam (antes de construir la app).
  const { setImapClientFactory, setSmtpTransportFactory } =
    await import('../src/services/mail-transport.js');
  const { FakeImapClient, FakeSmtpTransport } = await import('./fake-mail.js');
  // `as never`: los fakes implementan a propósito sólo el subconjunto de imapflow/nodemailer
  // que el código usa (ver fake-mail.ts). El cast queda confinado a este borde test-only.
  setImapClientFactory(() => new FakeImapClient() as never);
  setSmtpTransportFactory(() => new FakeSmtpTransport() as never);

  // 3) Conectar Mongo y levantar la app real.
  await mongoose.connect(process.env.MONGODB_URI);
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(
    `[e2e] API real escuchando en http://127.0.0.1:${PORT}/api (Mongo memory + Redis mock + IMAP/SMTP fake)`
  );

  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
      await mongoose.disconnect();
      await mongo.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('[e2e] fallo al arrancar el servidor E2E:', err);
  process.exit(1);
});
