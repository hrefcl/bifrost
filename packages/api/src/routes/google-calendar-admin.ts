import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/authz.js';
import { getRawGoogleConfig, setGoogleConfig } from '../services/google/settings.js';
import { googleCredsStatus, invalidateGoogleCredsCache } from '../services/google/creds.js';

/**
 * Config admin de las credenciales OAuth de Google (F-gcal admin-config). Montado en
 * `/api/admin/google-calendar`, gate `requireAdmin`. NUNCA devuelve el client secret (sólo
 * `hasClientSecret` + `source`). El PATCH exige el trío completo para ACTIVAR la config en DB (evita el
 * parcial que deja el secret sin usar). Molde: `meetAdminRoutes`.
 */
const patchSchema = z
  .object({
    // `undefined`/omitido = PRESERVA; `''` = CLEAR ese campo; `<valor>` = SET. (Zod NO coerce null→''.)
    clientId: z.string().optional(),
    redirectUri: z.union([z.string().url(), z.literal('')]).optional(),
    clientSecret: z.string().optional(),
  })
  .strict();

/** DTO admin — jamás el secret ni el ciphertext. `redirectUri` = el EFECTIVO (db o env). */
async function adminDto(): Promise<{
  clientId: string;
  redirectUri: string;
  hasClientSecret: boolean;
  source: 'db' | 'env' | 'error' | 'none';
}> {
  const status = await googleCredsStatus();
  const raw = await getRawGoogleConfig();
  return {
    // clientId/redirectUri: se prefieren los del status (efectivos db/env), pero se caen a los CRUDOS de
    // DB para que en estado 'error' (decrypt roto) el admin siga viendo lo que cargó y pueda reingresar
    // sólo el secret para recuperar (review B UX). No son datos sensibles.
    clientId: status.clientId ?? raw.clientId ?? '',
    redirectUri: status.redirectUri ?? raw.redirectUri ?? '',
    hasClientSecret: Boolean(raw.clientSecretEnc) || status.source === 'env',
    source: status.source,
  };
}

export function googleCalendarAdminRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request) => {
    await requireAdmin(request.user.userId); // lanza 403 si no es admin
  });

  fastify.get('/settings', async () => {
    return { settings: await adminDto() };
  });

  fastify.patch('/settings', async (request, reply) => {
    const patch = patchSchema.parse(request.body);
    // Para ACTIVAR la config en DB hace falta el TRÍO completo. Si se está SETEANDO el secret (valor no
    // vacío), el clientId y el redirectUri EFECTIVOS (los del patch o los ya guardados) deben existir —
    // así no queda un secret cifrado sin id/redirect (que caería a env y confundiría al admin).
    if (patch.clientSecret !== undefined && patch.clientSecret !== '') {
      const current = await getRawGoogleConfig();
      const idAfter = patch.clientId ?? current.clientId;
      const redirectAfter = patch.redirectUri ?? current.redirectUri;
      if (!idAfter || idAfter.trim() === '' || !redirectAfter || redirectAfter.trim() === '') {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Para guardar el Client Secret se requieren también Client ID y Redirect URI.',
        });
      }
    }
    await setGoogleConfig(patch);
    invalidateGoogleCredsCache(); // activación/desactivación sin restart (proceso único all-in-one)
    return { settings: await adminDto() };
  });
}
