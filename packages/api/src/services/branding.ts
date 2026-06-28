import { SystemConfig } from '../models/SystemConfig.js';

/**
 * Branding white-label configurable en RUNTIME por el admin (persistido en `SystemConfig`
 * key='branding'). Complementa el branding por env (`VITE_BRAND_*`, build-time): lo que el admin
 * guarde acá PISA al default por env en el cliente. Campos vacíos/ausentes → el cliente cae al
 * default por env (Bifrost). El logo se guarda como data URL (base64) — sin dependencia de storage
 * externo y agnóstico del provider de adjuntos; el tamaño se acota en la validación de la ruta.
 */
export interface BrandingConfig {
  companyName?: string;
  tagline?: string;
  accentColor?: string;
  logoDataUrl?: string;
  updatedBy?: string;
  updatedAt?: string;
}

/** Entrada del admin. `logoDataUrl: ''` (o null) LIMPIA el logo; ausente = no tocar. */
export interface BrandingInput {
  companyName?: string;
  tagline?: string;
  accentColor?: string;
  logoDataUrl?: string | null;
}

/** Vista pública servida al cliente (sin metadatos de auditoría). */
export interface PublicBranding {
  companyName: string | null;
  tagline: string | null;
  accentColor: string | null;
  logoDataUrl: string | null;
}

const KEY = 'branding';

/** Normaliza a string no-vacío o undefined (un valor en blanco LIMPIA el campo). */
function nonEmpty(v: string | null | undefined): string | undefined {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : undefined;
}

export async function getBranding(): Promise<BrandingConfig> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean<{ value?: BrandingConfig } | null>();
  return doc?.value ?? {};
}

export function toPublicBranding(cfg: BrandingConfig): PublicBranding {
  return {
    companyName: cfg.companyName ?? null,
    tagline: cfg.tagline ?? null,
    accentColor: cfg.accentColor ?? null,
    logoDataUrl: cfg.logoDataUrl ?? null,
  };
}

/**
 * Persiste el branding (merge sobre lo existente). Sólo se tocan los campos provistos; un string
 * vacío limpia ese campo (cae al default por env en el cliente). Devuelve la config completa.
 */
export async function setBranding(
  input: BrandingInput,
  updatedBy: string
): Promise<BrandingConfig> {
  const value: BrandingConfig = { ...(await getBranding()) };
  if (input.companyName !== undefined) value.companyName = nonEmpty(input.companyName);
  if (input.tagline !== undefined) value.tagline = nonEmpty(input.tagline);
  if (input.accentColor !== undefined) value.accentColor = nonEmpty(input.accentColor);
  if (input.logoDataUrl !== undefined) value.logoDataUrl = nonEmpty(input.logoDataUrl);
  value.updatedBy = updatedBy;
  value.updatedAt = new Date().toISOString();
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}
