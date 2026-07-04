import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env, googleConfigured } from '../config/env.js';
import {
  buildAuthUrl,
  consumeState,
  exchangeCode,
  OAuthError,
  OAUTH_COOKIE,
} from '../services/google/oauth.js';
import { saveConnection, getStatus, disconnect } from '../services/google/connection.js';

const OAUTH_COOKIE_TTL_SEC = 600; // igual al TTL del state en Redis (10 min)

/**
 * Endpoints de la integración con Google Calendar (F-gcal G2). Montados bajo /api/calendar/google.
 * Todos requieren sesión EXCEPTO el callback (ver abajo). Si el operador no configuró las credenciales
 * de Google (open-source: cada quien pone las suyas), la feature responde 503 y no se expone.
 */
const callbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(), // Google manda ?error=access_denied si el usuario cancela
});

/** Redirige el navegador de vuelta a la SPA (calendario) con el resultado del flujo. */
function frontendRedirect(result: 'connected' | 'error', reason?: string): string {
  const url = new URL('/calendar', env.FRONTEND_URL);
  url.searchParams.set('google', result);
  if (reason) url.searchParams.set('reason', reason);
  return url.toString();
}

export default function googleCalendarRoutes(fastify: FastifyInstance) {
  // Estado de la conexión del usuario (sin tokens). `configured` deja que la UI oculte la sección
  // cuando el operador no habilitó la feature.
  fastify.get('/status', async (request) => {
    if (!googleConfigured()) return { configured: false, connected: false };
    const status = await getStatus(request.user.userId);
    return { configured: true, ...status };
  });

  // Inicia el consentimiento: devuelve la URL de Google (la SPA hace window.location = url).
  fastify.get('/connect', async (request, reply) => {
    if (!googleConfigured()) {
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Integración con Google no configurada por el operador',
      });
    }
    const { url, nonce } = await buildAuthUrl(request.user.userId);
    // Cookie double-submit anti-CSRF (SameSite=Lax → viaja en el redirect top-level de Google, a
    // diferencia de la sesión que es Strict). Acotada al path de la feature y de vida corta.
    void reply.setCookie(OAUTH_COOKIE, nonce, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/calendar/google',
      maxAge: OAUTH_COOKIE_TTL_SEC,
    });
    return { url };
  });

  // Callback de Google (navegación top-level del navegador). NO autenticado por sesión: la cookie es
  // SameSite=strict y no viaja en el redirect cross-site desde Google. La identidad recae en el `state`
  // firmado + single-use (ver consumeState). Siempre REDIRIGE a la SPA (nunca devuelve JSON al navegador).
  fastify.get('/callback', { config: { requiresAuth: false } }, async (request, reply) => {
    if (!googleConfigured()) return reply.redirect(frontendRedirect('error', 'not_configured'));
    const parsed = callbackSchema.safeParse(request.query);
    if (!parsed.success) return reply.redirect(frontendRedirect('error', 'bad_request'));
    const { code, state, error } = parsed.data;
    // El `error` de Google se MAPEA a un valor conocido (no se refleja crudo en el Location): distingue
    // "el usuario canceló" de un error real, sin reflejar input arbitrario del query.
    if (error) {
      return reply.redirect(
        frontendRedirect('error', error === 'access_denied' ? 'cancelled' : 'google_error')
      );
    }
    if (!code || !state) return reply.redirect(frontendRedirect('error', 'missing_params'));
    void reply.clearCookie(OAUTH_COOKIE, { path: '/api/calendar/google' }); // un solo uso
    try {
      const { userId, verifier } = await consumeState(state, request.cookies[OAUTH_COOKIE]);
      const tokens = await exchangeCode(code, verifier);
      await saveConnection(userId, tokens);
    } catch (err) {
      const reason = err instanceof OAuthError ? 'oauth_failed' : 'internal';
      fastify.log.warn({ err: (err as Error).message }, 'google callback falló');
      return reply.redirect(frontendRedirect('error', reason));
    }
    return reply.redirect(frontendRedirect('connected'));
  });

  // Desconecta: revoca en Google (best-effort) y borra tokens locales. Idempotente.
  fastify.post('/disconnect', async (request) => {
    await disconnect(request.user.userId);
    return { ok: true };
  });
}
