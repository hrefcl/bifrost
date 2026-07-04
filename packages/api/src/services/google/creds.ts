import { encrypt, decrypt, type EncryptedPayload } from '../../config/crypto.js';
import { env } from '../../config/env.js';
import { getRawGoogleConfig } from './settings.js';

/**
 * Resolución ATÓMICA de las credenciales del cliente OAuth de Google (F-gcal admin-config), DB-o-env, sin
 * mezclar campos (molde `services/meet/token-service.ts`). Invariante (review B/D):
 *  - Trío DB completo (clientId+clientSecretEnc+redirectUri) y el secret DESCIFRA → `db`.
 *  - Trío DB completo pero el decrypt LANZA (clave rotada/corrupta) → `error` (NUNCA aliasa a env).
 *  - Si no, trío env completo → `env`.  Si no → `none`.
 * `googleEnabled()` deriva del MISMO `source` (fail-closed: `error`/`none` → deshabilitado). El secret en
 * CLARO NO se cachea: el cache guarda sólo `{source, clientId, redirectUri, clientSecretEnc}` y el plano se
 * descifra just-in-time por operación (exchange/refresh).
 */
export type GoogleCredsSource = 'db' | 'env' | 'error' | 'none';

interface CacheEntry {
  source: GoogleCredsSource;
  clientId?: string;
  redirectUri?: string;
  clientSecretEnc?: EncryptedPayload; // cifrado — NUNCA el plano
  expiresAt: number;
}

const TTL_MS = 30_000; // respaldo; el PATCH del admin invalida explícitamente (proceso único all-in-one)
let cache: CacheEntry | null = null;
let generation = 0; // se incrementa en cada invalidación → detecta un load en vuelo que quedó stale

/** Invalida el cache tras un cambio de config (llamar en el PATCH del admin). */
export function invalidateGoogleCredsCache(): void {
  cache = null;
  generation++;
}

async function loadCache(): Promise<CacheEntry> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache;

  const gen = generation; // captura ANTES del await
  const db = await getRawGoogleConfig();
  let entry: CacheEntry;
  if (db.clientId && db.clientSecretEnc && db.redirectUri) {
    // Trío DB completo: se VALIDA el decrypt al poblar (y se DESCARTA el plano) → source db o error.
    try {
      decrypt(db.clientSecretEnc);
      entry = {
        source: 'db',
        clientId: db.clientId,
        redirectUri: db.redirectUri,
        clientSecretEnc: db.clientSecretEnc,
        expiresAt: now + TTL_MS,
      };
    } catch {
      entry = { source: 'error', expiresAt: now + TTL_MS };
    }
  } else if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI) {
    // Snapshot ATÓMICO del trío de env (incluido el secret, CIFRADO en el cache — no en claro). Así
    // resolveGoogleCreds descifra igual que para 'db' y no lee env live (review B LOW: sin trío mixto).
    entry = {
      source: 'env',
      clientId: env.GOOGLE_CLIENT_ID,
      redirectUri: env.GOOGLE_REDIRECT_URI,
      clientSecretEnc: encrypt(env.GOOGLE_CLIENT_SECRET),
      expiresAt: now + TTL_MS,
    };
  } else {
    entry = { source: 'none', expiresAt: now + TTL_MS };
  }
  // Si hubo una invalidación DURANTE el await, `entry` puede ser stale: en vez de devolverlo, se recarga
  // una vez con estado fresco (anti-race estricto — review B: ni el caller en vuelo usa datos viejos). Las
  // invalidaciones son eventos raros (PATCH admin), así que no hay riesgo de loop.
  if (gen !== generation) return loadCache();
  cache = entry;
  return entry;
}

/** Estado SIN secreto — para `googleEnabled` y el DTO admin (source + campos no sensibles). */
export async function googleCredsStatus(): Promise<{
  source: GoogleCredsSource;
  clientId?: string;
  redirectUri?: string;
}> {
  const c = await loadCache();
  return { source: c.source, clientId: c.clientId, redirectUri: c.redirectUri };
}

/** `true` sólo si las credenciales son USABLES (db o env). Fail-closed: `error`/`none` → `false`. */
export async function googleEnabled(): Promise<boolean> {
  const c = await loadCache();
  return c.source === 'db' || c.source === 'env';
}

/**
 * Credenciales COMPLETAS con el client secret en CLARO (descifrado just-in-time) — SÓLO para el intercambio
 * de code / refresh. Lanza si no hay config usable (fail-closed): el caller no debe caer a env por su cuenta.
 */
export async function resolveGoogleCreds(): Promise<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}> {
  const c = await loadCache();
  // db y env comparten el mismo camino: snapshot cacheado con el secret CIFRADO, descifrado just-in-time.
  if ((c.source === 'db' || c.source === 'env') && c.clientId && c.clientSecretEnc && c.redirectUri) {
    return { clientId: c.clientId, clientSecret: decrypt(c.clientSecretEnc), redirectUri: c.redirectUri };
  }
  throw new Error('google-credentials-unavailable'); // source 'error' | 'none' → fail-closed
}
