import { reactive } from 'vue';

/**
 * Identidad de marca PARAMETRIZABLE (white-label), en DOS capas:
 *
 *  1. Build-time (env `VITE_BRAND_*`): el default que se hornea en la imagen. Si no se define, Bifrost.
 *  2. Runtime (admin): lo que el administrador guarda en `/api/admin/config/branding` (nombre, logo,
 *     color, eslogan) se sirve sin auth por `/api/branding` y PISA al default en el arranque.
 *
 * `brand` es REACTIVO: al guardar en el panel admin se actualiza en vivo (logo/nombre) sin recargar.
 * La forma del objeto `Brand` es el contrato estable que consume toda la UI.
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
  /** Logo de empresa (data URL) configurado por el admin; null → se usa el ícono por defecto. */
  logoUrl: string | null;
}

/** Devuelve el valor de entorno si tiene contenido tras trim, o el default. */
function envOr(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Acento validado como HEX (se inyecta en CSS vars / color-mix). Si no, default. */
function isHex(v: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}
function envAccent(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  return isHex(v) ? v : fallback;
}

/** Defaults por env (capa build-time). Se conservan como fallback de la capa runtime. */
const defaults: Brand = {
  name: envOr(import.meta.env.VITE_BRAND_NAME, 'Bifrost'),
  version: envOr(import.meta.env.VITE_BRAND_VERSION, '6.0'),
  accent: envAccent(import.meta.env.VITE_BRAND_ACCENT, '#1b66ff'),
  tagline: envOr(import.meta.env.VITE_BRAND_TAGLINE, 'IMAP & JMAP'),
  logoUrl: null,
};

export const brand: Brand = reactive({ ...defaults });

interface RemoteBranding {
  companyName: string | null;
  tagline: string | null;
  accentColor: string | null;
  logoDataUrl: string | null;
}

/**
 * Carga el branding de runtime del admin y lo MERGEA sobre los defaults (sólo pisa los campos que
 * el admin haya definido). Idempotente y tolerante: si el endpoint falla, se mantiene el default por
 * env (nunca rompe el arranque). Reaplica la marca al documento tras mergear.
 */
export async function loadRemoteBrand(): Promise<void> {
  try {
    // Timeout duro: este fetch se awaitea en el bootstrap ANTES de montar la app. Sin tope, un
    // /api/branding colgado (red lenta, backend trabado) dejaría pantalla en blanco. A los 3s
    // seguimos con el default por env (la marca no es crítica para arrancar).
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, 3000);
    let res: Response;
    try {
      res = await fetch('/api/branding', { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return;
    const b = (await res.json()) as RemoteBranding;
    if (b.companyName) brand.name = b.companyName;
    if (b.tagline) brand.tagline = b.tagline;
    if (b.accentColor && isHex(b.accentColor)) brand.accent = b.accentColor;
    brand.logoUrl = b.logoDataUrl ?? null;
    applyBrand();
  } catch {
    // Sin branding remoto → queda el default por env (no es un error fatal del arranque).
  }
}

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
