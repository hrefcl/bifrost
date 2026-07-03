import { escapeHtml, safeUrl } from './sanitizeHtml.js';

/**
 * Catálogo ESTÁTICO y CERRADO de templates de firma white-label (F2). Patrón idéntico al catálogo de
 * permisos (F8): no editable en runtime. Cada `render` recibe el contexto (branding del admin + datos
 * personales del User) y devuelve HTML de TABLA con estilos inline (email-safe).
 *
 * SEGURIDAD (review firmas H1 — contexto OUTBOUND): TODO texto interpolado se escapa con `esc()` y TODA
 * URL pasa por `safeUrl()` (sólo http/https/mailto/tel). El HTML resultante igual pasa por
 * `sanitizeEmailHtml` en el send-hook, pero ese es el BACKSTOP, no la única capa.
 */

export interface SignatureContext {
  // ── persona (del User) ──
  displayName: string;
  jobTitle?: string;
  department?: string;
  personalPhone?: string;
  /** Ya resuelta a URL interna `/api/signature-images/:id` (nunca remota — review H2). */
  photoUrl?: string;
  email: string;
  // ── branding (del admin) ──
  companyName?: string;
  tagline?: string;
  logoUrl?: string;
  logoWidthPx?: number;
  domainUrl?: string;
  companyPhone?: string;
  address?: string;
  accentColor?: string;
  socialLinks?: {
    linkedin?: string;
    instagram?: string;
    x?: string;
    facebook?: string;
    youtube?: string;
  };
}

export interface SignatureTemplate {
  id: string;
  /** Clave i18n del nombre visible (no hardcode — review). */
  nameKey: string;
  render(ctx: SignatureContext): string;
}

// ── helpers de escape/validación (todos los templates los usan) ──
const esc = escapeHtml;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Color de acento validado (hex) o el fallback — evita romper el atributo `style`. */
function color(c: string | undefined, fallback = '#1b66ff'): string {
  return c && HEX.test(c) ? c : fallback;
}
/** `<a>` con URL validada; si el esquema no es seguro, cae a texto escapado (sin link). */
function link(url: string | undefined, text: string, style = ''): string {
  const href = safeUrl(url);
  const t = esc(text);
  return href ? `<a href="${href}" style="${style}">${t}</a>` : t;
}
// Imágenes seguras para firmas: data:image ráster (logo del branding), path interno same-origin
// (/api/signature-images/:id → foto ya externalizada) o http(s) absoluta. BLOQUEA data:text/html,
// javascript: y demás (review H1/H2). Devuelve la URL escapada o '' si no es segura.
const DATA_IMG_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i;
function safeImageUrl(url: string | undefined): string {
  const v = (url ?? '').trim();
  if (!v) return '';
  if (DATA_IMG_RE.test(v)) return esc(v); // data:image ráster (se externaliza luego en el send-hook)
  if (v.startsWith('//')) return ''; // protocolo-relativo (//host) → fuera
  if (/^\/api\/signature-images\/[a-f0-9]{24}$/i.test(v)) return esc(v); // foto/logo hosteado internamente
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol) ? esc(v) : '';
  } catch {
    return '';
  }
}
/** `<img>` sólo si la URL de imagen es segura. */
function img(url: string | undefined, alt: string, style: string): string {
  const src = safeImageUrl(url);
  return src ? `<img src="${src}" alt="${esc(alt)}" style="${style}" />` : '';
}
/** Fila de redes como links de texto (email-safe, sin assets externos). */
function socialRow(ctx: SignatureContext, sep = ' · '): string {
  const s = ctx.socialLinks ?? {};
  const items = [
    link(s.linkedin, 'LinkedIn'),
    link(s.instagram, 'Instagram'),
    link(s.x, 'X'),
    link(s.facebook, 'Facebook'),
    link(s.youtube, 'YouTube'),
  ].filter((x) => x.startsWith('<a')); // sólo las que tienen URL válida
  return items.length ? items.join(esc(sep)) : '';
}
/** Línea "cargo · departamento" (omite lo ausente). */
function role(ctx: SignatureContext): string {
  return [ctx.jobTitle, ctx.department]
    .filter((x): x is string => Boolean(x))
    .map(esc)
    .join(' · ');
}

const FONT = 'font-family:Arial,Helvetica,sans-serif';

// ────────────────────────────── Templates v1 (4-5) ──────────────────────────────

/** 1) Horizontal clásico: foto/logo a la izquierda, datos con barra de acento a la derecha. */
function horizontal(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const media =
    img(
      ctx.photoUrl,
      ctx.displayName,
      'width:64px;height:64px;border-radius:50%;object-fit:cover'
    ) ||
    img(
      ctx.logoUrl,
      ctx.companyName ?? '',
      `width:${String(ctx.logoWidthPx ?? 120)}px;height:auto`
    );
  const left = media ? `<td style="padding-right:16px;vertical-align:top">${media}</td>` : '';
  return (
    `<table cellpadding="0" cellspacing="0" style="${FONT};font-size:13px;color:#1c2128"><tr>${left}` +
    `<td style="border-left:3px solid ${ac};padding-left:14px;vertical-align:top">` +
    `<div style="font-size:16px;font-weight:bold">${esc(ctx.displayName)}</div>` +
    (role(ctx) ? `<div style="color:#5a6472">${role(ctx)}</div>` : '') +
    (ctx.companyName
      ? `<div style="font-weight:bold;color:${ac}">${esc(ctx.companyName)}</div>`
      : '') +
    `<div style="margin-top:6px;color:#5a6472">` +
    link(`mailto:${ctx.email}`, ctx.email, `color:${ac};text-decoration:none`) +
    (ctx.personalPhone || ctx.companyPhone
      ? ` · ${link(`tel:${ctx.personalPhone ?? ctx.companyPhone ?? ''}`, ctx.personalPhone ?? ctx.companyPhone ?? '', 'color:#5a6472;text-decoration:none')}`
      : '') +
    (ctx.domainUrl
      ? ` · ${link(ctx.domainUrl, cleanHost(ctx.domainUrl), `color:${ac};text-decoration:none`)}`
      : '') +
    `</div>` +
    (socialRow(ctx)
      ? `<div style="margin-top:4px;font-size:12px;color:#95a0b2">${socialRow(ctx)}</div>`
      : '') +
    `</td></tr></table>`
  );
}

/** 2) Vertical minimal: datos apilados con barra de acento lateral, sin foto. */
function vertical(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const logo = img(
    ctx.logoUrl,
    ctx.companyName ?? '',
    `width:${String(ctx.logoWidthPx ?? 110)}px;height:auto;margin-bottom:8px`
  );
  return (
    `<table cellpadding="0" cellspacing="0" style="${FONT};font-size:13px;color:#1c2128"><tr>` +
    `<td style="border-left:3px solid ${ac};padding-left:14px">` +
    (logo ? `<div>${logo}</div>` : '') +
    `<div style="font-size:16px;font-weight:bold">${esc(ctx.displayName)}</div>` +
    (role(ctx) ? `<div style="color:#5a6472">${role(ctx)}</div>` : '') +
    (ctx.companyName
      ? `<div style="color:${ac};font-weight:bold">${esc(ctx.companyName)}</div>`
      : '') +
    (ctx.tagline ? `<div style="color:#95a0b2;font-style:italic">${esc(ctx.tagline)}</div>` : '') +
    `<div style="margin-top:6px;color:#5a6472">${link(`mailto:${ctx.email}`, ctx.email, `color:${ac};text-decoration:none`)}</div>` +
    (ctx.domainUrl
      ? `<div>${link(ctx.domainUrl, cleanHost(ctx.domainUrl), `color:${ac};text-decoration:none`)}</div>`
      : '') +
    (socialRow(ctx)
      ? `<div style="margin-top:4px;font-size:12px;color:#95a0b2">${socialRow(ctx)}</div>`
      : '') +
    `</td></tr></table>`
  );
}

/** 3) Foto circular (estilo Cleverty): foto redonda + datos + teléfono/WhatsApp. */
function photoRound(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const photo = img(
    ctx.photoUrl,
    ctx.displayName,
    'width:72px;height:72px;border-radius:50%;object-fit:cover'
  );
  const phone = ctx.personalPhone ?? ctx.companyPhone;
  return (
    `<table cellpadding="0" cellspacing="0" style="${FONT};font-size:13px;color:#1c2128"><tr>` +
    (photo ? `<td style="padding-right:16px;vertical-align:middle">${photo}</td>` : '') +
    `<td style="vertical-align:middle">` +
    `<div style="font-size:17px;font-weight:bold;color:${ac}">${esc(ctx.displayName)}</div>` +
    (role(ctx) ? `<div style="color:#5a6472">${role(ctx)}</div>` : '') +
    (ctx.companyName ? `<div style="font-weight:bold">${esc(ctx.companyName)}</div>` : '') +
    `<div style="margin-top:6px;color:#5a6472">` +
    link(`mailto:${ctx.email}`, ctx.email, `color:${ac};text-decoration:none`) +
    (phone ? `<br/>${link(`tel:${phone}`, phone, 'color:#5a6472;text-decoration:none')}` : '') +
    `</div>` +
    (socialRow(ctx)
      ? `<div style="margin-top:4px;font-size:12px;color:#95a0b2">${socialRow(ctx)}</div>`
      : '') +
    `</td></tr></table>`
  );
}

/** 4) Corporativo con logo arriba + fila de redes. */
function corporate(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const logo = img(
    ctx.logoUrl,
    ctx.companyName ?? '',
    `width:${String(ctx.logoWidthPx ?? 140)}px;height:auto`
  );
  return (
    `<table cellpadding="0" cellspacing="0" style="${FONT};font-size:13px;color:#1c2128">` +
    (logo ? `<tr><td style="padding-bottom:10px">${logo}</td></tr>` : '') +
    `<tr><td style="border-top:2px solid ${ac};padding-top:10px">` +
    `<div style="font-size:16px;font-weight:bold">${esc(ctx.displayName)}</div>` +
    (role(ctx) ? `<div style="color:#5a6472">${role(ctx)}</div>` : '') +
    (ctx.companyName
      ? `<div style="font-weight:bold;color:${ac}">${esc(ctx.companyName)}</div>`
      : '') +
    `<div style="margin-top:6px;color:#5a6472">` +
    link(`mailto:${ctx.email}`, ctx.email, `color:${ac};text-decoration:none`) +
    (ctx.companyPhone ? ` · ${esc(ctx.companyPhone)}` : '') +
    (ctx.address ? `<br/>${esc(ctx.address)}` : '') +
    (ctx.domainUrl
      ? `<br/>${link(ctx.domainUrl, cleanHost(ctx.domainUrl), `color:${ac};text-decoration:none`)}`
      : '') +
    `</div>` +
    (socialRow(ctx)
      ? `<div style="margin-top:6px;font-size:12px;color:#95a0b2">${socialRow(ctx)}</div>`
      : '') +
    `</td></tr></table>`
  );
}

/** 5) Minimal texto: una sola línea, sin imágenes (máxima compatibilidad). */
function minimal(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const parts = [
    `<strong>${esc(ctx.displayName)}</strong>`,
    role(ctx),
    ctx.companyName
      ? `<span style="color:${ac};font-weight:bold">${esc(ctx.companyName)}</span>`
      : '',
    link(`mailto:${ctx.email}`, ctx.email, `color:${ac};text-decoration:none`),
    ctx.domainUrl
      ? link(ctx.domainUrl, cleanHost(ctx.domainUrl), `color:${ac};text-decoration:none`)
      : '',
  ].filter(Boolean);
  return `<div style="${FONT};font-size:13px;color:#1c2128">${parts.join(esc(' · '))}</div>`;
}

/** Host legible de una URL (para mostrar "aulion.app" en vez de la URL completa). Devuelve '' si inválida. */
function cleanHost(url: string | undefined): string {
  try {
    return new URL((url ?? '').trim()).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const SIGNATURE_TEMPLATES = [
  { id: 'horizontal', nameKey: 'settings.signatureTpl.horizontal', render: horizontal },
  { id: 'vertical', nameKey: 'settings.signatureTpl.vertical', render: vertical },
  { id: 'photo-round', nameKey: 'settings.signatureTpl.photoRound', render: photoRound },
  { id: 'corporate', nameKey: 'settings.signatureTpl.corporate', render: corporate },
  { id: 'minimal', nameKey: 'settings.signatureTpl.minimal', render: minimal },
] as const satisfies readonly SignatureTemplate[];

export type SignatureTemplateId = (typeof SIGNATURE_TEMPLATES)[number]['id'];
export const SIGNATURE_TEMPLATE_IDS = SIGNATURE_TEMPLATES.map((t) => t.id);
const BY_ID = new Map<string, SignatureTemplate>(SIGNATURE_TEMPLATES.map((t) => [t.id, t]));

export function isValidTemplateId(id: string): id is SignatureTemplateId {
  return BY_ID.has(id);
}

/**
 * Rendiza la firma del template `id` con el contexto. Si el id no existe, cae al primero del catálogo.
 * El HTML ya trae todo texto escapado + URLs validadas; el caller igual debe pasarlo por
 * `sanitizeEmailHtml` como backstop antes de enviar.
 */
export function renderSignature(id: string, ctx: SignatureContext): string {
  const tpl = BY_ID.get(id) ?? SIGNATURE_TEMPLATES[0];
  return tpl.render(ctx);
}

/**
 * Fallback determinístico en TEXTO PLANO cuando el render falla y la firma es obligatoria
 * (`enforceSignature`) — nunca imágenes, nunca romper el envío (review firmas fail-open).
 */
export function minimalPlainSignature(ctx: SignatureContext): string {
  const parts = [ctx.displayName, ctx.companyName, ctx.email]
    .filter(Boolean)
    .map((s) => esc(s ?? ''));
  return `<div style="${FONT};font-size:13px;color:#1c2128">${parts.join(' · ')}</div>`;
}
