import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { randomToken, hmacToken, verifyHmac } from '../../config/crypto.js';
import { redis } from '../../config/redis.js';

/**
 * OAuth 2.0 con Google (integración F-gcal G2), desacoplado del calendario. Flujo authorization-code
 * con PKCE (S256) y `state` de un solo uso atado al usuario (anti-CSRF / anti-confusión-de-cuentas).
 * Sólo se pide el scope MÍNIMO `calendar.events`. Se usa `fetch` directo (sin dep googleapis).
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
// Scope MÍNIMO para la función (escribir eventos) + `openid email` SÓLO para mostrar QUÉ cuenta Google
// quedó conectada (el usuario verifica que ligó la correcta; sin `email`, userinfo da 403). No se pide
// perfil, contactos ni lectura de otros calendarios.
export const GOOGLE_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events';
const STATE_TTL_SEC = 600; // el nonce/verifier viven 10 min en Redis (single-use)

export class OAuthError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
}

function challengeFrom(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Nombre de la cookie anti-CSRF (double-submit). SameSite=Lax → SÍ viaja en el redirect top-level. */
export const OAUTH_COOKIE = 'gcal_oauth';

/**
 * URL de consentimiento. Genera nonce + PKCE verifier, los guarda en Redis atados al `userId`
 * (single-use, TTL), y arma un `state` firmado (HMAC) e infalsificable. Devuelve también el `nonce`:
 * el caller lo setea en una cookie `SameSite=Lax` (double-submit) para atar el callback al MISMO
 * navegador que inició — defensa contra el OAuth login-CSRF (la sesión no sirve: es SameSite=strict).
 */
export async function buildAuthUrl(userId: string): Promise<{ url: string; nonce: string }> {
  const nonce = randomToken(16);
  const verifier = randomToken(32); // 64 hex chars → PKCE code_verifier válido
  const ts = String(Date.now());
  const payload = `${nonce}:${userId}:${ts}`;
  const state = Buffer.from(`${payload}:${hmacToken(payload)}`).toString('base64url');
  await redis.setex(`gcal:oauth:${nonce}`, STATE_TTL_SEC, JSON.stringify({ userId, verifier }));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: env.GOOGLE_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline', // → refresh token
    prompt: 'consent', // fuerza refresh token aunque ya haya consentido antes
    include_granted_scopes: 'false',
    state,
    code_challenge: challengeFrom(verifier),
    code_challenge_method: 'S256',
  });
  return { url: `${AUTH_URL}?${params.toString()}`, nonce };
}

/**
 * Valida el `state` del callback y CONSUME el nonce (single-use). El callback NO está autenticado
 * (la cookie de sesión es SameSite=strict → no viaja en el redirect top-level desde Google), así que
 * la identidad del usuario recae ENTERAMENTE en este `state`: firmado con HMAC (infalsificable), atado
 * al `userId` que inició el flujo, no expirado y no reusado. Eso cierra CSRF/confusión de cuentas: un
 * atacante no puede fabricar un state para otro userId ni reusar uno ajeno. Devuelve el `userId` (de
 * confianza) y el PKCE `verifier` para el intercambio del code.
 */
export async function consumeState(
  state: string,
  cookieNonce: string | undefined
): Promise<{ userId: string; verifier: string }> {
  let decoded: string;
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    throw new OAuthError('state inválido');
  }
  const [nonce, userId, tsStr, mac] = decoded.split(':');
  if (!nonce || !userId || !tsStr || !mac) throw new OAuthError('state inválido');
  if (!verifyHmac(`${nonce}:${userId}:${tsStr}`, mac)) throw new OAuthError('state manipulado');
  if (Date.now() - Number(tsStr) > STATE_TTL_SEC * 1000) throw new OAuthError('state expirado');
  // Double-submit anti-CSRF: el nonce del state DEBE coincidir con la cookie del navegador que inició.
  // Un flujo iniciado por un atacante (su state) completado en el navegador de la víctima no tendrá la
  // cookie con ESE nonce → se rechaza. Cierra el OAuth login-CSRF / account-linking.
  if (!cookieNonce || cookieNonce !== nonce) {
    throw new OAuthError('state no coincide con la sesión del navegador');
  }
  const key = `gcal:oauth:${nonce}`;
  const raw = await redis.get(key);
  if (!raw) throw new OAuthError('state ya usado o expirado'); // single-use (o TTL vencido)
  // Single-use ATÓMICO ante callbacks concurrentes: Redis serializa los comandos, así que de dos
  // consumidores del mismo nonce sólo UNO obtiene `del === 1`; el otro (0) se rechaza aquí, antes de
  // canjear el code. Cierra el TOCTOU entre get y del.
  const removed = await redis.del(key);
  if (removed === 0) throw new OAuthError('state ya usado'); // otro callback lo consumió primero
  const stored = JSON.parse(raw) as { userId: string; verifier: string };
  // Integridad cruzada: el userId firmado en el state debe coincidir con el guardado en Redis.
  if (stored.userId !== userId) throw new OAuthError('state inconsistente');
  return { userId, verifier: stored.verifier };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new OAuthError(
      json.error_description ?? json.error ?? 'fallo al obtener tokens de Google'
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    scope: json.scope,
  };
}

/** Intercambia el `code` del callback por tokens (con el PKCE verifier). */
export async function exchangeCode(code: string, verifier: string): Promise<GoogleTokens> {
  return postToken({
    code,
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
    redirect_uri: env.GOOGLE_REDIRECT_URI ?? '',
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
}

/** Renueva el access token con el refresh token. Un `invalid_grant` = refresh revocado → OAuthError. */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  return postToken({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
    grant_type: 'refresh_token',
  });
}

/** Revoca un token en Google (best-effort: un fallo no debe impedir la desconexión local). El token va
 *  en el BODY (no en la query) para no filtrarlo en logs de acceso/proxy. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    /* best-effort */
  }
}

/** Email de la cuenta Google conectada (sólo para mostrar el estado). No es sensible. */
export async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}
