import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { redis, closeRedis } from './config/redis.js';
import { buildApp } from './app.js';
import { buildSetupApp } from './setup/index.js';
import {
  reconcileLegacyIndexes,
  reconcileEmailUidIndex,
  reconcileEmailTextIndex,
} from './db/reconcile-indexes.js';
import { env, isSetupMode } from './config/env.js';

let serverApp: Awaited<ReturnType<typeof buildApp>> | undefined;
let stuckSweep: ReturnType<typeof setInterval> | undefined;
let accountSyncSweep: ReturnType<typeof setTimeout> | undefined;
let activeSync: Promise<unknown> | undefined; // barrido de sync en vuelo (para drenarlo en shutdown)

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
  await reconcileEmailTextIndex();
  await redis.ping();

  const app = await buildApp();
  serverApp = app;

  // Barridos periódicos: (a) revierte borradores colgados en 'sending' a 'failed';
  // (b) recolecta AttachmentBlobs huérfanos (subidas descartadas, drafts borrados/enviados).
  const { recoverStuckDrafts, cleanupOrphanAttachments } = await import('./routes/drafts.js');
  // Una vez al boot (un crash previo pudo dejar drafts en 'sending' o blobs huérfanos).
  await recoverStuckDrafts().catch((err: unknown) => {
    app.log.error(err);
  });
  await cleanupOrphanAttachments().catch((err: unknown) => {
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
      void cleanupOrphanAttachments().then(
        (n) => {
          if (n > 0) app.log.info(`cleaned ${String(n)} orphan attachment(s)`);
        },
        (err: unknown) => {
          app.log.error(err);
        }
      );
    },
    5 * 60 * 1000
  );
  stuckSweep.unref();

  // Sync IMAP de FONDO (automático): sin esto el usuario no ve correo nuevo hasta pulsar sync.
  // Loop AUTO-AGENDADO (no setInterval): cada vuelta sincroniza el lote de cuentas más
  // desactualizadas (lock distribuido + status) y AGENDA la siguiente sólo cuando termina — así no se
  // solapan barridos si uno tarda más que el intervalo (review B+D). Delay con JITTER en CADA tick
  // (no sólo el primero) → con N instancias no golpean Mongo/IMAP sincronizadas (thundering herd).
  const { syncStaleAccounts } = await import('./services/account-sync.js');
  const nextSyncDelay = () => 2 * 60 * 1000 + Math.floor(Math.random() * 60_000);
  const scheduleAccountSync = () => {
    accountSyncSweep = setTimeout(() => {
      // Si el shutdown ya empezó (gracefulShutdown setea shutdownPromise en su 1ª línea), NO arrancar
      // un barrido: cubre la ventana en que el timer ya disparó (callback encolado) y clearTimeout no
      // pudo cancelarlo, evitando un sync contra Redis/Mongo cerrándose (review D).
      if (shutdownPromise) return;
      // Guardar el promise del barrido EN VUELO para poder drenarlo en el shutdown (que el release
      // del lock + el status terminen antes de cerrar Redis/Mongo — review D).
      activeSync = syncStaleAccounts()
        .then((r) => {
          if (r.accounts > 0)
            app.log.info(
              `bg sync: ${String(r.accounts)} cuenta(s), ${String(r.synced)} msg nuevos`
            );
        })
        .catch((err: unknown) => {
          app.log.error(err);
        });
      void activeSync.finally(() => {
        activeSync = undefined;
        if (!shutdownPromise) scheduleAccountSync(); // re-agenda salvo en shutdown
      });
    }, nextSyncDelay());
    accountSyncSweep.unref();
  };
  scheduleAccountSync();

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
  if (accountSyncSweep) clearTimeout(accountSyncSweep);
  // Drenar un barrido de sync EN VUELO antes de cerrar deps: que complete su release de lock + el
  // status, para no dejar un lock huérfano (acotado por el TTL de todos modos) ni `status='syncing'`
  // colgado. Acotado a 10s para no colgar el shutdown si IMAP/Mongo no responden (review D).
  if (activeSync) {
    try {
      await Promise.race([
        activeSync,
        new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
      ]);
    } catch {
      /* el error del sync ya quedó logueado/registrado en Account */
    }
  }
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
