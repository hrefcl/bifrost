import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { redis, closeRedis } from './config/redis.js';
import { buildApp } from './app.js';
import { buildSetupApp } from './setup/index.js';
import { reconcileLegacyIndexes, reconcileEmailUidIndex } from './db/reconcile-indexes.js';
import { env, isSetupMode } from './config/env.js';

let serverApp: Awaited<ReturnType<typeof buildApp>> | undefined;
let stuckSweep: ReturnType<typeof setInterval> | undefined;

async function main() {
  if (isSetupMode()) {
    const app = await buildSetupApp();
    serverApp = app;
    try {
      await app.listen({ port: env.PORT, host: env.HOST });
      app.log.info(`SETUP MODE listening on http://${env.HOST}:${String(env.PORT)}`);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
    return;
  }

  await connectDatabase();
  await reconcileLegacyIndexes();
  await reconcileEmailUidIndex();
  await redis.ping();

  const app = await buildApp();
  serverApp = app;

  // Barrido de recuperación: revierte borradores colgados en 'sending' a 'failed'.
  const { recoverStuckDrafts } = await import('./routes/drafts.js');
  // Una vez al boot (un crash previo pudo dejar drafts en 'sending').
  await recoverStuckDrafts().catch((err: unknown) => {
    app.log.error(err);
  });
  stuckSweep = setInterval(
    () => {
      void recoverStuckDrafts().then(
        (n) => {
          if (n > 0) app.log.warn(`recovered ${String(n)} stuck draft(s)`);
        },
        (err: unknown) => {
          app.log.error(err);
        }
      );
    },
    5 * 60 * 1000
  );
  stuckSweep.unref();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`API listening on http://${env.HOST}:${String(env.PORT)}`);
  } catch (err) {
    app.log.error(err);
    await gracefulShutdown();
    process.exit(1);
  }
}

let shutdownPromise: Promise<void> | undefined;
function gracefulShutdown(): Promise<void> {
  // Idempotente y compartido: una segunda señal AWAITEA el cierre en curso (no arranca
  // otro ni deja que su handler haga process.exit() a mitad del primero).
  shutdownPromise ??= doShutdown();
  return shutdownPromise;
}

async function doShutdown() {
  // Cerrar en orden: parar el interval, drenar requests activos (app.close), luego deps.
  // Cada paso aislado: si Redis ya murió (posible causa del shutdown), su quit() no debe
  // impedir el cierre ordenado de Mongo.
  if (stuckSweep) clearInterval(stuckSweep);
  try {
    await serverApp?.close();
  } catch (err) {
    console.error('Error closing HTTP server:', err);
  }
  try {
    await closeRedis();
  } catch (err) {
    console.error('Error closing Redis:', err);
  }
  try {
    await disconnectDatabase();
  } catch (err) {
    console.error('Error closing MongoDB:', err);
  }
}

// Handlers SÍNCRONOS que delegan en la promesa idempotente (no `async` directo: el
// listener espera un retorno void, no una Promise — evita no-misused-promises).
function handleSignal(): void {
  void gracefulShutdown().finally(() => process.exit(0));
}
process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);

// Fail-fast ante errores no manejados: que el orquestador reinicie en vez de quedar
// en un estado zombi silencioso.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

// main() awaitea connectDatabase/reconcile/redis.ping ANTES de app.listen; un fallo de
// dependencia al boot debe loguear y salir 1 (antes quedaba como unhandled rejection).
main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
