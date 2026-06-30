/**
 * Validación/normalización de slugs públicos (username del host y slug de EventType). Evita choques con
 * rutas reservadas y caracteres ambiguos (review C-L3 / B-MED del diseño).
 */

// Rutas/segmentos que NO pueden usarse como username (chocarían con paths del front o del API).
const RESERVED = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'booking',
  'calendar',
  'config',
  'contacts',
  'health',
  'login',
  'logout',
  'meet',
  'metrics',
  'public',
  'scheduling',
  'settings',
  'setup',
  'static',
  'u',
  'user',
  'users',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/; // 3..40, minúsculas/dígitos/guion, sin guion al borde

/** Normaliza: trim + minúsculas. Devuelve '' si queda vacío (el caller decide $unset). */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

export type SlugCheck = { ok: true; value: string } | { ok: false; reason: string };

/** Valida un username público. No toca DB (la unicidad la da el índice). */
export function validateUsername(input: string): SlugCheck {
  const value = normalizeSlug(input);
  if (value.length < 3 || value.length > 40)
    return { ok: false, reason: 'Debe tener entre 3 y 40 caracteres' };
  if (!SLUG_RE.test(value))
    return { ok: false, reason: 'Sólo minúsculas, dígitos y guion (no al inicio/fin)' };
  if (RESERVED.has(value)) return { ok: false, reason: 'Ese nombre está reservado' };
  return { ok: true, value };
}

/** Valida un slug de EventType (mismas reglas + reservados, para que /u/:user/:slug no choque). */
export function validateEventSlug(input: string): SlugCheck {
  const value = normalizeSlug(input);
  if (value.length < 1 || value.length > 64)
    return { ok: false, reason: 'Debe tener entre 1 y 64 caracteres' };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    return { ok: false, reason: 'Sólo minúsculas, dígitos y guion (no al inicio/fin)' };
  }
  if (RESERVED.has(value)) return { ok: false, reason: 'Ese enlace está reservado' };
  return { ok: true, value };
}
