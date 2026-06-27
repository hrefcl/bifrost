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
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  // Access token con TTL cómodo (en prod es 15m). ANTES era 3s para que el test del
  // interceptor de refresh esperara la expiración natural — pero eso hacía que CUALQUIER
  // test lento (p.ej. admin al final del spec serial) cruzara la expiración y dependiera del
  // refresh, con carreras intermitentes (flake real). Ahora el test del interceptor fuerza una
  // 401 determinista vía page.route, así ningún test depende de un TTL corto global.
  process.env.JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? '60s';
  // Rate limit global desactivado de hecho: la suite serial completa golpea desde una sola IP
  // (localhost) y excede las 100/min por defecto hacia el final del spec → 429 en los últimos
  // tests (p.ej. el PATCH de storage del admin). En prod el límite real (100/min) se mantiene.
  process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX ?? '100000';
  // Idem para los límites por-ruta de auth (login 10/min, refresh 30/min en prod): la suite
  // serial hace un login por test desde una sola IP y chocaría el techo al sumar specs.
  process.env.AUTH_LOGIN_RATE_MAX = process.env.AUTH_LOGIN_RATE_MAX ?? '100000';
  process.env.AUTH_REFRESH_RATE_MAX = process.env.AUTH_REFRESH_RATE_MAX ?? '100000';
  // Storage de adjuntos (provider local) en un tmp efímero, no en el repo.
  process.env.ATTACHMENTS_DIR =
    process.env.ATTACHMENTS_DIR ?? path.join(tmpdir(), 'bifrost-e2e-attachments');

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

  // Seed: un usuario admin pre-existente para los flujos de administración E2E.
  // loginOrRegister hace match por primaryEmail y NO toca `role` → al loguearse con este
  // email se entra como admin (el resto de usuarios se crean como 'user' al primer login).
  const { User } = await import('../src/models/User.js');
  await User.create({
    primaryEmail: 'admin-e2e@example.com',
    displayName: 'Admin E2E',
    role: 'admin',
  });

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
