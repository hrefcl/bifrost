import type { Types } from 'mongoose';
import { encrypt, decrypt } from '../../config/crypto.js';
import { withLock } from '../../lib/withLock.js';
import {
  GoogleConnection,
  toGoogleConnectionStatus,
  type GoogleConnectionStatus,
  type IGoogleConnection,
} from '../../models/GoogleConnection.js';
import {
  refreshAccessToken,
  revokeToken,
  fetchUserEmail,
  OAuthError,
  type GoogleTokens,
} from './oauth.js';

/**
 * Gestión de la conexión Google de un usuario (F-gcal G2): persistencia CIFRADA de tokens, refresh
 * transparente y desconexión. Desacoplado del OAuth puro (`oauth.ts`) y del calendario. NADIE fuera de
 * este módulo descifra tokens; hacia afuera sólo se expone `GoogleConnectionStatus` (sin tokens).
 */
const EXPIRY_SKEW_MS = 60_000; // refrescar 1 min antes del vencimiento real

type UserId = Types.ObjectId | string;

/** Persiste (upsert) la conexión tras un consentimiento OK. Cifra access + refresh token. */
export async function saveConnection(userId: UserId, tokens: GoogleTokens): Promise<void> {
  const email = await fetchUserEmail(tokens.accessToken);
  const set: Record<string, unknown> = {
    accessTokenEnc: encrypt(tokens.accessToken),
    tokenExpiresAt: tokens.expiresAt,
    scope: tokens.scope,
    status: 'connected',
    connectedAt: new Date(),
  };
  if (email) set.googleUserEmail = email;
  // Google devuelve refresh_token en el consentimiento (prompt=consent). Si por algo no viniera, se
  // conserva el anterior (no se pisa con vacío).
  if (tokens.refreshToken) set.refreshTokenEnc = encrypt(tokens.refreshToken);
  await GoogleConnection.updateOne(
    { userId },
    { $set: set, $unset: { syncError: '' } },
    { upsert: true }
  );
}

/**
 * Access token VÁLIDO para llamar a la API de Google. Si está por vencer, lo refresca bajo lock
 * (serializa refresh concurrentes del mismo usuario → un solo hit a Google, sin doble-rotación).
 * Lanza `OAuthError` si no hay conexión utilizable o el refresh fue revocado.
 */
export async function getValidAccessToken(userId: UserId): Promise<string> {
  const conn = await GoogleConnection.findOne({ userId });
  if (!conn || conn.status === 'revoked') throw new OAuthError('sin conexión con Google');
  if (conn.accessTokenEnc && isFresh(conn)) return decrypt(conn.accessTokenEnc);

  const outcome = await withLock(
    `gcal:refresh:${String(userId)}`,
    async () => {
      // Re-leer dentro del lock: otro request pudo haber refrescado mientras esperábamos.
      const fresh = await GoogleConnection.findOne({ userId });
      if (!fresh || fresh.status === 'revoked') throw new OAuthError('sin conexión con Google');
      if (fresh.accessTokenEnc && isFresh(fresh)) return decrypt(fresh.accessTokenEnc);
      // Sin refresh token no se puede renovar → es PERMANENTE (requiere reconectar); marcarlo así hace
      // que el caller desconecte la cuenta y corte reintentos en loop sobre un estado irrecuperable (D-LOW).
      if (!fresh.refreshTokenEnc)
        throw new OAuthError('sin refresh token; reconectá con Google', true);
      return refreshAndStore(userId, decrypt(fresh.refreshTokenEnc));
    },
    { ttlSeconds: 30, waitMs: 8000 }
  );
  if (outcome.skipped) {
    // No se pudo tomar el lock ni tras esperar: usa lo que haya quedado persistido.
    const latest = await GoogleConnection.findOne({ userId });
    if (latest?.accessTokenEnc && isFresh(latest)) return decrypt(latest.accessTokenEnc);
    throw new OAuthError('refresh de Google en curso; reintentá');
  }
  return outcome.result;
}

function isFresh(conn: IGoogleConnection): boolean {
  return Boolean(
    conn.accessTokenEnc &&
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS
  );
}

async function refreshAndStore(userId: UserId, refreshToken: string): Promise<string> {
  let tokens: GoogleTokens;
  try {
    tokens = await refreshAccessToken(refreshToken);
  } catch (err) {
    // SÓLO un fallo PERMANENTE (invalid_grant) marca la conexión en error → la UI pide reconectar. Un
    // fallo transitorio (5xx/red) NO desconecta: se re-lanza y BullMQ reintenta con la conexión intacta
    // (evita que un blip deje la conexión muerta para siempre — review B/C/D).
    if (err instanceof OAuthError && err.permanent) {
      await GoogleConnection.updateOne(
        { userId },
        {
          $set: {
            status: 'error',
            syncError: 'La conexión con Google expiró o fue revocada. Reconectá.',
          },
        }
      );
    }
    throw err;
  }
  const set: Record<string, unknown> = {
    accessTokenEnc: encrypt(tokens.accessToken),
    tokenExpiresAt: tokens.expiresAt,
    status: 'connected',
  };
  if (tokens.refreshToken) set.refreshTokenEnc = encrypt(tokens.refreshToken);
  await GoogleConnection.updateOne({ userId }, { $set: set, $unset: { syncError: '' } });
  return tokens.accessToken;
}

/** Estado público (sin tokens) para GET /google/status. */
export async function getStatus(userId: UserId): Promise<GoogleConnectionStatus> {
  const conn = await GoogleConnection.findOne({ userId }).lean<IGoogleConnection>();
  return toGoogleConnectionStatus(conn);
}

/**
 * Desconexión: revoca en Google (best-effort) y borra los tokens localmente (soft: el doc queda con
 * `status:'revoked'` como histórico). Idempotente.
 */
export async function disconnect(userId: UserId): Promise<void> {
  const conn = await GoogleConnection.findOne({ userId });
  if (!conn) return;
  const toRevoke = [conn.refreshTokenEnc, conn.accessTokenEnc]
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => decrypt(t));
  await GoogleConnection.updateOne(
    { userId },
    { $set: { status: 'revoked' }, $unset: { accessTokenEnc: '', refreshTokenEnc: '' } }
  );
  for (const token of toRevoke) await revokeToken(token); // best-effort, no bloquea la desconexión
}
