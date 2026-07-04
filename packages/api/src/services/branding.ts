import { SystemConfig } from '../models/SystemConfig.js';
import type { SignatureStyle } from '../lib/signature-templates.js';

/**
 * Branding white-label configurable en RUNTIME por el admin (persistido en `SystemConfig`
 * key='branding'). Complementa el branding por env (`VITE_BRAND_*`, build-time): lo que el admin
 * guarde acá PISA al default por env en el cliente. Campos vacíos/ausentes → el cliente cae al
 * default por env (Bifrost). El logo se guarda como data URL (base64) — sin dependencia de storage
 * externo y agnóstico del provider de adjuntos; el tamaño se acota en la validación de la ruta.
 */
/** Redes sociales de la empresa (URLs http(s), validadas en el schema de la ruta). Alimentan las firmas. */
export interface SocialLinks {
  linkedin?: string;
  instagram?: string;
  x?: string;
  facebook?: string;
  youtube?: string;
  github?: string;
  whatsapp?: string;
  website?: string;
}
export const SOCIAL_KEYS = [
  'linkedin',
  'instagram',
  'x',
  'facebook',
  'youtube',
  'github',
  'whatsapp',
  'website',
] as const;

/**
 * Weight (estilo de trazo) del set de iconos Phosphor, elegido por el admin para TODA la plataforma
 * (white-label: la interfaz tiene el estilo que el admin quiere para sus empleados). Default `light`.
 */
export const ICON_WEIGHTS = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const;
export type IconWeight = (typeof ICON_WEIGHTS)[number];
export const DEFAULT_ICON_WEIGHT: IconWeight = 'light';

/** Entrada de redes desde el admin (cada subcampo `''`/null LIMPIA ese link). */
export type SocialLinksInput = Partial<Record<(typeof SOCIAL_KEYS)[number], string | null>>;

export interface BrandingConfig {
  companyName?: string;
  tagline?: string;
  accentColor?: string;
  logoDataUrl?: string; // logo HORIZONTAL (data URL). El principal para firmas y login.
  logoVerticalDataUrl?: string; // logo VERTICAL (data URL). Para layouts apilados/centrados.
  // ── Branding extendido (F1, alimenta los templates de firma white-label) ──
  domainUrl?: string; // URL http(s) del sitio (CTA de la firma)
  phone?: string; // teléfono corporativo
  address?: string; // dirección
  socialLinks?: SocialLinks; // URLs de redes
  appStoreUrl?: string; // link a la app iOS (badge App Store en el template Cleverty)
  googlePlayUrl?: string; // link a la app Android (badge Google Play en el template Cleverty)
  signatureStyle?: SignatureStyle; // estilo componible (tab Estilo): campos/orden/tipografía/foto/etc.
  logoWidthPx?: number; // ancho del logo en la firma (px); default de render = 120
  /** Política: si el admin bloquea el color, el cliente ignora el accent personal (app-wide). */
  lockAccentColor?: boolean;
  /** Estilo de iconos app-wide (weight de Phosphor). Default `light`. */
  iconWeight?: IconWeight;
  updatedBy?: string;
  updatedAt?: string;
}

/** Entrada del admin. `logoDataUrl: ''` (o null) LIMPIA el logo; ausente = no tocar. */
export interface BrandingInput {
  companyName?: string;
  tagline?: string;
  accentColor?: string;
  logoDataUrl?: string | null;
  logoVerticalDataUrl?: string | null;
  domainUrl?: string | null;
  phone?: string | null;
  address?: string | null;
  socialLinks?: SocialLinksInput | null;
  appStoreUrl?: string | null;
  googlePlayUrl?: string | null;
  signatureStyle?: SignatureStyle | null;
  logoWidthPx?: number | null;
  lockAccentColor?: boolean;
  iconWeight?: IconWeight;
}

/** Vista pública servida al cliente (sin metadatos de auditoría). */
export interface PublicBranding {
  companyName: string | null;
  tagline: string | null;
  accentColor: string | null;
  logoDataUrl: string | null;
  logoVerticalDataUrl: string | null;
  domainUrl: string | null;
  phone: string | null;
  address: string | null;
  socialLinks: SocialLinks | null;
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
  signatureStyle: SignatureStyle | null;
  logoWidthPx: number | null;
  lockAccentColor: boolean;
  iconWeight: IconWeight;
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
    logoVerticalDataUrl: cfg.logoVerticalDataUrl ?? null,
    domainUrl: cfg.domainUrl ?? null,
    phone: cfg.phone ?? null,
    address: cfg.address ?? null,
    socialLinks:
      cfg.socialLinks && Object.keys(cfg.socialLinks).length > 0 ? cfg.socialLinks : null,
    appStoreUrl: cfg.appStoreUrl ?? null,
    googlePlayUrl: cfg.googlePlayUrl ?? null,
    signatureStyle: cfg.signatureStyle ?? null,
    logoWidthPx: cfg.logoWidthPx ?? null,
    lockAccentColor: cfg.lockAccentColor ?? false,
    iconWeight: cfg.iconWeight ?? DEFAULT_ICON_WEIGHT,
  };
}

/** Filtra un objeto de redes a subcampos no-vacíos; devuelve undefined si queda vacío. */
function cleanSocials(s: SocialLinksInput | null | undefined): SocialLinks | undefined {
  if (!s) return undefined;
  const out: SocialLinks = {};
  for (const k of SOCIAL_KEYS) {
    const v = nonEmpty(s[k]);
    if (v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  if (input.logoVerticalDataUrl !== undefined)
    value.logoVerticalDataUrl = nonEmpty(input.logoVerticalDataUrl);
  if (input.domainUrl !== undefined) value.domainUrl = nonEmpty(input.domainUrl);
  if (input.phone !== undefined) value.phone = nonEmpty(input.phone);
  if (input.address !== undefined) value.address = nonEmpty(input.address);
  if (input.appStoreUrl !== undefined) value.appStoreUrl = nonEmpty(input.appStoreUrl);
  if (input.googlePlayUrl !== undefined) value.googlePlayUrl = nonEmpty(input.googlePlayUrl);
  if (input.signatureStyle !== undefined) value.signatureStyle = input.signatureStyle ?? undefined;
  if (input.socialLinks !== undefined) value.socialLinks = cleanSocials(input.socialLinks);
  if (input.logoWidthPx !== undefined) value.logoWidthPx = input.logoWidthPx ?? undefined;
  if (input.lockAccentColor !== undefined) value.lockAccentColor = input.lockAccentColor;
  if (input.iconWeight !== undefined) value.iconWeight = input.iconWeight;
  value.updatedBy = updatedBy;
  value.updatedAt = new Date().toISOString();
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}
