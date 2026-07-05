import { Queue, Worker, type Processor, type JobsOptions, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';

/**
 * Cola BullMQ de la agenda (review B/D: el email de confirmación y el reconciler van FUERA del lock
 * del booking, encolados aquí). BullMQ estaba instalado pero SIN usar; ésta es su primera cola.
 *
 *  - Conexión PROPIA con `maxRetriesPerRequest:null` (lo exige BullMQ; ver nota en config/redis.ts:
 *    la conexión compartida usa `3` finito para degradar rápido, BullMQ necesita `null`).
 *  - Reintentos: `attempts:5` + backoff exponencial. Los jobs fallidos se CONSERVAN (DLQ inspeccionable).
 *  - Worker IN-PROCESO en el all-in-one single-instance (PRODUCT DECISION del diseño). Se arranca en el
 *    boot vía `startSchedulingWorker` (cableado en index.ts), NO en import.
 *  - En tests/E2E (`REDIS_URL=mock`, ioredis-mock) BullMQ no aplica: `enqueue` es no-op y el worker no arranca.
 */

export const SCHEDULING_QUEUE = 'scheduling';

export type SchedulingJobName = 'send-email' | 'reconcile' | 'gcal-sync' | 'send-event-invite';

const isMock = (): boolean => env.REDIS_URL === 'mock';

// Conexiones creadas por esta cola/worker — se cierran en `closeScheduling`. BullMQ NO cierra las
// conexiones que recibe como instancia (sólo las que crea él internamente), así que las trackeamos
// y hacemos `quit()` explícito en el shutdown (review D-040/D-044).
const connections: Redis[] = [];
function makeConnection(): ConnectionOptions {
  const conn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', () => undefined); // evita unhandled 'error' si Redis cae; el job re-encola/falla
  connections.push(conn);
  // Skew de tipos benigno: BullMQ trae su propia versión de ioredis; misma API en runtime.
  return conn as unknown as ConnectionOptions;
}

const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false, // conservar fallidos = DLQ inspeccionable (review D-028/D-032)
};

let queue: Queue | null = null;
function getQueue(): Queue | null {
  if (isMock()) return null;
  queue ??= new Queue(SCHEDULING_QUEUE, { connection: makeConnection() });
  return queue;
}

/** Encola un job de agenda. No-op en mock/test. Idempotencia/clave la define el caller vía `opts.jobId`. */
export async function enqueue(
  name: SchedulingJobName,
  data: Record<string, unknown>,
  opts: JobsOptions = {}
): Promise<void> {
  const q = getQueue();
  if (!q) return;
  // BullMQ RECHAZA jobIds con ':' ("Custom Id cannot contain :") → el add lanza y el job se pierde.
  // Fue un bug real: los emails de confirmación de reserva no se encolaban (jobId `confirm:<id>`).
  // Sanitizar defensivamente para que ningún caller reintroduzca el problema.
  const safe: JobsOptions =
    typeof opts.jobId === 'string' ? { ...opts, jobId: opts.jobId.replace(/:/g, '-') } : opts;
  await q.add(name, data, { ...DEFAULT_JOB_OPTS, ...safe });
}

/** Programa el job repetible `reconcile` (cada 2 min). No-op en mock/test. Llamar en el boot. */
export async function scheduleReconciler(): Promise<void> {
  const q = getQueue();
  if (!q) return;
  await q.add(
    'reconcile',
    {},
    {
      repeat: { every: 120_000 },
      jobId: 'scheduling-reconcile',
      removeOnComplete: true,
      removeOnFail: 50,
    }
  );
}

let worker: Worker | null = null;

/**
 * Arranca el worker IN-PROCESO que procesa los jobs de la cola. Llamar en el boot (index.ts).
 * `processor` despacha por `job.name`. Devuelve `null` en mock/test. Adjunta listeners de
 * `failed`/`error` para que un fallo NO sea silencioso (review D-044); la métrica/alerta formal se
 * cablea en Fase 3.4 (handler inyectable abajo).
 */
export function startSchedulingWorker(processor: Processor): Worker | null {
  if (isMock()) return null;
  if (worker) return worker;
  const w = new Worker(SCHEDULING_QUEUE, processor, { connection: makeConnection() });
  w.on('failed', (job, err) => {
    // Job agotó sus reintentos o falló este intento → queda en DLQ (removeOnFail:false).
    console.error(
      `[scheduling] job failed name=${job?.name ?? '?'} id=${job?.id ?? '?'} attempts=${String(job?.attemptsMade ?? 0)}: ${err.message}`
    );
  });
  w.on('error', (err) => {
    console.error(`[scheduling] worker error: ${err.message}`);
  });
  worker = w;
  return worker;
}

/** Cierra cola, worker y SUS conexiones (graceful shutdown / tests de integración). */
export async function closeScheduling(): Promise<void> {
  try {
    await worker?.close();
  } finally {
    await queue?.close();
    // BullMQ no cierra las conexiones-instancia que le pasamos → quit() explícito de cada una.
    await Promise.all(connections.map((c) => c.quit().catch(() => undefined)));
    connections.length = 0;
    worker = null;
    queue = null;
  }
}
