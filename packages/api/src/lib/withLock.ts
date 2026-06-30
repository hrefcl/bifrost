import { randomUUID } from 'node:crypto';
import { redis } from '../config/redis.js';

/**
 * Lock distribuido en Redis — GENERALIZACIÓN del patrón probado `withAccountLock`
 * (services/account-sync.ts): `SET NX EX` con token único + heartbeat que renueva el TTL
 * mientras corre + release atómico por token (Lua). Lo usa el sync de cuentas y AHORA también
 * el booking de agenda (review B: "reutilizar withAccountLock generalizado a withLock").
 *
 * Semántica fail-closed (review B/D del diseño de agenda):
 *  - lock tomado por OTRO  → outcome `{ skipped:true }`  (el caller mapea a 409).
 *  - Redis caído/timeout   → `redis.set` LANZA → propaga (el caller mapea a 503). NUNCA se degrada.
 *
 * Release/extend ATÓMICOS por token: sólo borran/extienden el lock si seguimos siendo el dueño
 * (evita borrar el lock de OTRA instancia que lo tomó tras una expiración).
 *
 * GARANTÍA DEL HEARTBEAT (review B — contrato explícito): la renovación del TTL es BEST-EFFORT (sus
 * errores se silencian para no tumbar `fn`). Si Redis se particiona/reinicia DURANTE `fn`, el TTL puede
 * expirar y otra instancia adquirir la misma key → SOLAPAMIENTO del critical section. El release por
 * token evita pisar el lock ajeno, pero NO evita ese solapamiento. Por lo tanto este lock da exclusión
 * FUERTE sólo mientras Redis esté sano; para correctness ante esa ventana, el caller debe (a) mantener
 * el critical section CORTO (sólo DB, sin red lenta — el email del booking va fuera del lock) y (b) tener
 * un BACKSTOP durable independiente del lock. En el booking de agenda ese backstop es el índice único
 * `{userId,eventTypeId,idempotencyKeyHash}` + la re-validación del slot bajo lock (Fase 3.2/3.4): aunque
 * dos instancias entren a la vez, la unicidad en Mongo impide la doble reserva.
 */
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const EXTEND_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

export interface LockOptions {
  /** TTL del lock en segundos. El heartbeat lo renueva mientras `fn` corre. Default 120. */
  ttlSeconds?: number;
  /**
   * Si se provee, reintenta ADQUIRIR el lock durante este tiempo total (ms) antes de rendirse
   * (útil para contención transitoria del hot path de booking). Default 0 = un solo intento.
   */
  waitMs?: number;
  /** Espera entre reintentos de adquisición, ms. Default 100. */
  retryDelayMs?: number;
}

export type LockOutcome<T> = { skipped: true } | { skipped: false; result: T };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Ejecuta `fn` con el lock `key` tomado. Devuelve `{skipped:true}` si no se pudo adquirir
 * (otro lo tiene, incluso tras reintentos). Lanza si Redis no responde (fail-closed).
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: LockOptions = {}
): Promise<LockOutcome<T>> {
  const ttl = opts.ttlSeconds ?? 120;
  const waitMs = opts.waitMs ?? 0;
  const retryDelayMs = opts.retryDelayMs ?? 100;
  const token = randomUUID();

  // Adquisición (con reintento opcional). Un error de Redis se propaga (fail-closed).
  const deadline = Date.now() + waitMs;
  let acquired = await redis.set(key, token, 'EX', ttl, 'NX');
  while (acquired !== 'OK' && Date.now() < deadline) {
    await sleep(retryDelayMs);
    acquired = await redis.set(key, token, 'EX', ttl, 'NX');
  }
  if (acquired !== 'OK') return { skipped: true };

  // Heartbeat: extiende el TTL (sólo si seguimos siendo dueños) a la mitad del TTL, para que un
  // critical section más largo que el TTL no deje expirar el lock y entre otra instancia.
  const renew = setInterval(
    () => {
      void redis.eval(EXTEND_LUA, 1, key, token, String(ttl)).catch(() => undefined);
    },
    (ttl * 1000) / 2
  );
  renew.unref();
  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    clearInterval(renew);
    await redis.eval(RELEASE_LUA, 1, key, token).catch(() => undefined);
  }
}
