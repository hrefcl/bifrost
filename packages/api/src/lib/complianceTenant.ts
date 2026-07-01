import type { FastifyRequest } from 'fastify';

/**
 * Fuente ÚNICA del tenant para todo el framework de Compliance (DESIGN v4 §9, A8).
 *
 * BifrostMail es single-tenant por deployment (cada org = su EC2), así que hoy retorna 'default'.
 * Todos los modelos llevan `tenantId` e índices scopeados; migrar a multi-tenant real = cambiar
 * SÓLO este helper (p.ej. resolver desde un claim, un header o el host), sin tocar el resto.
 */
export const DEFAULT_TENANT_ID = 'default';

export function resolveTenantId(_request?: FastifyRequest): string {
  return DEFAULT_TENANT_ID;
}
