/**
 * Identidad de marca PARAMETRIZABLE (white-label).
 *
 * El proyecto es «Bifrost», pero el nombre, versión, color de acento y eslogan que ve el
 * usuario son configurables sin tocar código: se leen de variables de entorno `VITE_BRAND_*`
 * en tiempo de build (p. ej. en el Dockerfile.web o un `.env` de la web). Así un operador puede
 * personalizar la plataforma con su propia marca. Si no se definen, el default es Bifrost.
 *
 * Más adelante esto puede alimentarse también desde la config del sistema (admin) en runtime;
 * la forma del objeto `Brand` es el contrato estable que consume toda la UI.
 */
export interface Brand {
  /** Nombre de la plataforma mostrado en logo, login, título de pestaña, etc. */
  name: string;
  /** Versión mostrada junto al nombre (sufijo del wordmark). */
  version: string;
  /** Color de acento (HEX). Alimenta el token CSS `--accent` y derivados. */
  accent: string;
  /** Eslogan/pie mostrado bajo el logo en el login. */
  tagline: string;
}

/** Devuelve el valor de entorno si tiene contenido tras trim, o el default. */
function envOr(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export const brand: Brand = {
  name: envOr(import.meta.env.VITE_BRAND_NAME, 'Bifrost'),
  version: envOr(import.meta.env.VITE_BRAND_VERSION, '6.0'),
  accent: envOr(import.meta.env.VITE_BRAND_ACCENT, '#1b66ff'),
  tagline: envOr(import.meta.env.VITE_BRAND_TAGLINE, 'IMAP & JMAP'),
};

/**
 * Aplica la marca al documento: inyecta el color de acento (y su derivado oscuro) como
 * variables CSS sobre <html> y fija el título de la pestaña. Idempotente: puede llamarse
 * en cada arranque o cuando cambie la config de marca.
 */
export function applyBrand(b: Brand = brand): void {
  const root = document.documentElement;
  root.style.setProperty('--accent', b.accent);
  root.style.setProperty('--accent-700', `color-mix(in srgb, ${b.accent} 82%, #000)`);
  root.style.setProperty('--accent-300', `color-mix(in srgb, ${b.accent} 52%, #fff)`);
  document.title = `${b.name} ${b.version}`;
}
