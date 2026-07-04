import { escapeHtml, safeUrl } from './sanitizeHtml.js';

/**
 * Catálogo ESTÁTICO de templates de firma white-label. Cada `render` recibe el contexto (branding del
 * admin + datos del User + `assetBase`) y devuelve HTML de TABLA con estilos inline (email-safe).
 *
 * SEGURIDAD (contexto OUTBOUND): TODO texto se escapa con `esc()` y TODA URL pasa por `safeUrl()`. Los
 * iconos (campo/redes) son PNG HOSTEADOS en `${assetBase}/sig-icons/*.png` — NO data:/SVG (Gmail los
 * bloquea). El HTML igual pasa por `sanitizeEmailHtml` en el send-hook (backstop).
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
  logoVerticalUrl?: string;
  logoWidthPx?: number;
  domainUrl?: string;
  companyPhone?: string;
  address?: string;
  accentColor?: string;
  /** Links a las apps móviles de la empresa (badges App Store / Google Play en el template Cleverty). */
  appStoreUrl?: string;
  googlePlayUrl?: string;
  socialLinks?: {
    linkedin?: string;
    instagram?: string;
    x?: string;
    facebook?: string;
    youtube?: string;
    github?: string;
    whatsapp?: string;
    website?: string;
  };
  /** Base pública para los assets de icono (`${assetBase}/sig-icons/*.png`). La setea el send-hook. */
  assetBase?: string;
  /** Estilo componible elegido por el admin (qué campos, en qué orden, tipografía, foto, etc.). */
  style?: SignatureStyle;
}

/** Campos que el admin puede mostrar/ocultar y/o reordenar en el editor de Estilo. `photo` sólo se
 *  oculta (no va en el stack); `name`/`title` sólo se reordenan (no se ocultan); el resto ambas cosas. */
export type SignatureFieldKey =
  | 'photo'
  | 'name'
  | 'title'
  | 'company'
  | 'phone'
  | 'email'
  | 'website'
  | 'address'
  | 'tagline'
  | 'social';

/** Orden por default de la columna de datos (el drag-and-drop lo reordena). */
export const STACK_FIELDS = [
  'name',
  'title',
  'company',
  'phone',
  'email',
  'website',
  'address',
  'tagline',
  'social',
] as const;
export type StackField = (typeof STACK_FIELDS)[number];

/** Fuentes email-safe ofrecidas por el editor → stack CSS con fallbacks. */
export const FONT_STACKS: Record<string, string> = {
  Arial: 'Arial, Helvetica, sans-serif',
  Helvetica: 'Helvetica, Arial, sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  Verdana: 'Verdana, Geneva, sans-serif',
  Trebuchet: '"Trebuchet MS", Helvetica, sans-serif',
  Tahoma: 'Tahoma, Geneva, sans-serif',
};

/** Separadores permitidos (el editor ofrece · | – y "ninguno"). */
export const SEPARATORS = ['·', '|', '–', ''] as const;

/** Estilo componible de la firma (nivel empresa; lo setea el admin). Todo opcional → defaults sanos. */
export interface SignatureStyle {
  /** Clave de `FONT_STACKS` (Arial por default). */
  fontFamily?: string;
  /** Tamaño de la foto/avatar en px (default por template). */
  photoSizePx?: number;
  /** Alineación general del bloque. */
  align?: 'left' | 'center';
  /** Separador inline (uno de `SEPARATORS`; '·' por default, '' = ninguno). */
  separator?: string;
  /** Campos ocultos (toggles apagados en "MOSTRAR CAMPOS"). */
  hidden?: SignatureFieldKey[];
  /** Orden de los campos de CONTACTO (drag-and-drop). Los ausentes van al final en su orden natural. */
  order?: SignatureFieldKey[];
  /** Redes como iconos (true) o sin iconos/texto (false). Default true. */
  socialAsIcons?: boolean;
}

export interface SignatureTemplate {
  id: string;
  /** Clave i18n del nombre visible. */
  nameKey: string;
  render(ctx: SignatureContext): string;
}

// ── helpers de escape/validación ──
const esc = escapeHtml;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const INK = '#1c2128';
const MUTED = '#5a6472';
const FAINT = '#95a0b2';
const FONT = 'font-family:Arial,Helvetica,sans-serif';

function color(c: string | undefined, fallback = '#1b66ff'): string {
  return c && HEX.test(c) ? c : fallback;
}
function assetBase(ctx: SignatureContext): string {
  // Escape-at-origin al 100%: aunque `assetBase` es server-trusted (lo setea el send-hook), se interpola
  // en atributos `src` → escaparlo cierra el principio sin excepciones (review B/C/D del render, LOW).
  return esc((ctx.assetBase ?? '').replace(/\/+$/, ''));
}

// ── estilo componible (editor de Estilo) ──
function styleOf(ctx: SignatureContext): SignatureStyle {
  return ctx.style ?? {};
}
/** ¿El campo está oculto por el toggle del admin? */
function isHidden(ctx: SignatureContext, key: SignatureFieldKey): boolean {
  return styleOf(ctx).hidden?.includes(key) ?? false;
}
/** Declaración `font-family:…` resuelta desde el estilo (fallback Arial); se pone en la tabla raíz. */
function fontDecl(ctx: SignatureContext): string {
  const key = styleOf(ctx).fontFamily;
  const stack = (key ? FONT_STACKS[key] : undefined) ?? FONT_STACKS.Arial;
  return `font-family:${stack}`;
}
/** Separador inline elegido (default '·'); '' = ninguno (se usa un espacio). */
function sepChar(ctx: SignatureContext): string {
  return styleOf(ctx).separator ?? '·';
}
/** Texto del separador ya escapado para intercalar (con espacios); si es '', sólo un espacio. */
function sepText(ctx: SignatureContext): string {
  const s = sepChar(ctx);
  return s ? esc(` ${s} `) : ' ';
}
/** ¿Mostrar redes como iconos? (default sí). */
function socialAsIcons(ctx: SignatureContext): boolean {
  return styleOf(ctx).socialAsIcons ?? true;
}
/** Tamaño de foto/avatar en px: el del estilo (acotado 24–160) o el default del template. */
function photoSize(ctx: SignatureContext, deflt: number): number {
  const n = styleOf(ctx).photoSizePx;
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.min(Math.max(Math.round(n), 24), 160)
    : deflt;
}
/** Orden de la columna de datos según el drag-and-drop; los no listados van al final en orden natural. */
function orderedStack(ctx: SignatureContext): StackField[] {
  const isStack = (k: SignatureFieldKey): k is StackField =>
    (STACK_FIELDS as readonly SignatureFieldKey[]).includes(k);
  // Dedup: un order con claves repetidas (['email','email']) no debe rendir el campo dos veces.
  const wanted = [...new Set((styleOf(ctx).order ?? []).filter(isStack))];
  const seen = new Set<StackField>(wanted);
  return [...wanted, ...STACK_FIELDS.filter((k) => !seen.has(k))];
}

/** `<a>` con URL validada; si el esquema no es seguro, cae a texto escapado (sin link). */
function link(url: string | undefined, text: string, style = ''): string {
  const href = safeUrl(url);
  const t = esc(text);
  return href ? `<a href="${href}" style="${style}">${t}</a>` : t;
}

// Imágenes seguras: data:image ráster (logo), path interno /api/signature-images/:id, /sig-icons/ (assets
// hosteados) o http(s) absoluta. BLOQUEA data:text/html, javascript:, protocolo-relativo.
const DATA_IMG_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i;
function safeImageUrl(url: string | undefined): string {
  const v = (url ?? '').trim();
  if (!v) return '';
  if (DATA_IMG_RE.test(v)) return esc(v);
  if (v.startsWith('//')) return '';
  if (/^\/api\/signature-images\/[a-f0-9]{24}$/i.test(v)) return esc(v);
  if (/^\/sig-icons\/[a-z-]+\.png$/i.test(v)) return esc(v); // anclado: sólo path interno, no `javascript:/sig-icons/…`
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol) ? esc(v) : '';
  } catch {
    return '';
  }
}
function img(url: string | undefined, alt: string, style: string): string {
  const src = safeImageUrl(url);
  return src ? `<img src="${src}" alt="${esc(alt)}" style="${style}" />` : '';
}

/** Icono de campo (teléfono/mail/web/ubicación) PNG hosteado, o '' si no hay assetBase. */
function icon(ctx: SignatureContext, name: string, size = 15): string {
  const base = assetBase(ctx);
  if (!base) return '';
  return `<img src="${base}/sig-icons/${name}.png" width="${String(size)}" height="${String(size)}" alt="" style="display:inline-block;vertical-align:middle;border:0" />`;
}

/** Fila de contacto: icono + texto (linkable). Devuelve '' si no hay valor. `bold` = texto oscuro en
 *  negrita (estilo Cleverty) en vez del gris atenuado por defecto. */
function contactRow(
  ctx: SignatureContext,
  iconName: string,
  value: string,
  href?: string,
  opts?: { bold?: boolean }
): string {
  if (!value) return '';
  const ic = icon(ctx, iconName);
  // Padding 3px sólo en modo bold (Cleverty); los templates previos conservan su 2px original.
  const pad = opts?.bold ? '3px' : '2px';
  const cell = ic ? `<td style="padding:${pad} 8px ${pad} 0;line-height:1">${ic}</td>` : '';
  const col = opts?.bold ? INK : MUTED;
  const weight = opts?.bold ? 'font-weight:bold;' : '';
  const text = link(href, value, `color:${col};text-decoration:none;${weight}`);
  return `<tr>${cell}<td style="padding:${pad} 0;color:${col};font-size:13px;line-height:1.4;${weight}">${text}</td></tr>`;
}

/** Iniciales del nombre: primera + última (ej. "Valentina Ríos" → "VR"); una sola si es un solo nombre. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}

/** Avatar circular: foto si hay; si no, círculo con las iniciales (sin imagen, table-safe). */
function avatar(ctx: SignatureContext, ac: string, size = 72): string {
  if (isHidden(ctx, 'photo')) return '';
  size = photoSize(ctx, size);
  const s = String(size);
  const photo = img(
    ctx.photoUrl,
    ctx.displayName,
    `width:${s}px;height:${s}px;border-radius:50%;object-fit:cover;display:block`
  );
  if (photo) return photo;
  const ini = esc(initials(ctx.displayName));
  return (
    `<table cellpadding="0" cellspacing="0" style="width:${s}px;height:${s}px;border-radius:50%;background:${ac}">` +
    `<tr><td align="center" valign="middle" style="color:#fff;font-size:${String(Math.round(size / 2.6))}px;font-weight:bold;letter-spacing:.5px;${FONT}">${ini}</td></tr></table>`
  );
}

/** Avatar con ANILLO de acento (estilo Cleverty): foto/iniciales en círculo gris claro, dentro de un
 *  anillo de color de acento. Adaptación email-safe: el ref usa un anillo con gradiente azul→violeta, pero
 *  el backstop `sanitizeEmailHtml` (y Gmail) sólo conservan `background-color` — `background-image`/
 *  `linear-gradient` se elimina antes de llegar al cliente. Por eso el anillo es un SÓLIDO de acento (lo
 *  más fiel que sobrevive el pipeline de email). */
function ringedAvatar(ctx: SignatureContext, ac: string, size = 76): string {
  if (isHidden(ctx, 'photo')) return '';
  size = photoSize(ctx, size);
  const s = String(size);
  const photo = img(
    ctx.photoUrl,
    ctx.displayName,
    `width:${s}px;height:${s}px;border-radius:50%;object-fit:cover;display:block`
  );
  const inner =
    photo ||
    `<table cellpadding="0" cellspacing="0" style="width:${s}px;height:${s}px;border-radius:50%;background:#eef1f6">` +
      `<tr><td align="center" valign="middle" style="color:#8a94a6;font-size:${String(Math.round(size / 2.6))}px;font-weight:bold;letter-spacing:.5px;${FONT}">${esc(initials(ctx.displayName))}</td></tr></table>`;
  return (
    `<table cellpadding="0" cellspacing="0" style="border-radius:50%;background-color:${ac}">` +
    `<tr><td style="padding:3px"><table cellpadding="0" cellspacing="0" style="border-radius:50%;background:#fff"><tr><td style="padding:2px">${inner}</td></tr></table></td></tr></table>`
  );
}

/** Badges App Store / Google Play (template Cleverty): glifo hosteado + texto, linkeado. '' si no hay URLs. */
function appBadges(ctx: SignatureContext): string {
  const base = assetBase(ctx);
  if (!base) return '';
  const badge = (url: string | undefined, iconName: string, label: string): string => {
    const href = safeUrl(url);
    if (!href) return '';
    return (
      `<tr><td style="padding:3px 0"><a href="${href}" style="text-decoration:none;color:${INK};font-size:12px;font-weight:bold">` +
      `<img src="${base}/sig-icons/${iconName}.png" width="14" height="14" alt="" style="border:0;vertical-align:middle;margin-right:6px" />${esc(label)}</a></td></tr>`
    );
  };
  const rows =
    badge(ctx.appStoreUrl, 'badge-apple', 'App Store') +
    badge(ctx.googlePlayUrl, 'badge-googleplay', 'Google Play');
  return rows ? `<table cellpadding="0" cellspacing="0">${rows}</table>` : '';
}

const SOCIAL_ORDER: [keyof NonNullable<SignatureContext['socialLinks']>, string][] = [
  ['linkedin', 'social-linkedin'],
  ['x', 'social-x'],
  ['instagram', 'social-instagram'],
  ['facebook', 'social-facebook'],
  ['youtube', 'social-youtube'],
  ['github', 'social-github'],
  ['whatsapp', 'social-whatsapp'],
  ['website', 'social-web'],
];

/** Botones de redes: iconos hosteados si `socialAsIcons`, o links de texto si no. Oculto si el toggle
 *  "Redes sociales" está apagado. */
function socialButtons(ctx: SignatureContext, size = 26): string {
  if (isHidden(ctx, 'social')) return '';
  const base = assetBase(ctx);
  const s = ctx.socialLinks ?? {};
  const asIcons = socialAsIcons(ctx);
  const ac = color(ctx.accentColor);
  const items: string[] = [];
  for (const [key, iconName] of SOCIAL_ORDER) {
    const href = safeUrl(s[key]);
    if (!href) continue;
    if (asIcons) {
      if (!base) continue; // sin assetBase no hay icono hosteado
      items.push(
        `<a href="${href}" style="text-decoration:none;margin-right:6px;display:inline-block">` +
          `<img src="${base}/sig-icons/${iconName}.png" width="${String(size)}" height="${String(size)}" alt="${esc(key)}" style="border:0;display:inline-block" /></a>`
      );
    } else {
      // Sin iconos: links de texto con el nombre de la red.
      items.push(
        `<a href="${href}" style="color:${ac};text-decoration:none;font-size:12px;margin-right:10px">${esc(key)}</a>`
      );
    }
  }
  return items.length ? `<div style="margin-top:8px">${items.join('')}</div>` : '';
}

/** Línea "cargo · departamento" (usa el separador elegido). */
function role(ctx: SignatureContext): string {
  return [ctx.jobTitle, ctx.department]
    .filter((x): x is string => Boolean(x))
    .map(esc)
    .join(sepText(ctx));
}

/** Un campo de contacto como bloque autónomo (icono + texto), para el stack ordenable. '' si no hay valor. */
function contactBlock(
  ctx: SignatureContext,
  iconName: string,
  value: string,
  href?: string,
  opts?: StackOpts
): string {
  if (!value) return '';
  const r = contactRow(ctx, iconName, value, href, opts);
  const center = styleOf(ctx).align === 'center' ? 'margin:0 auto;' : '';
  return r ? `<table cellpadding="0" cellspacing="0" style="${center}">${r}</table>` : '';
}

function quote(ctx: SignatureContext): string {
  return ctx.tagline && !isHidden(ctx, 'tagline')
    ? `<div style="margin-top:8px;color:${FAINT};font-style:italic;font-size:12px">“${esc(ctx.tagline)}”</div>`
    : '';
}

interface StackOpts {
  bold?: boolean; // contacto en negrita oscura (Cleverty)
  hideCompany?: boolean; // empresa mostrada en otra parte (letterhead / columna de marca)
  nameSize?: number; // tamaño del nombre
  titleColor?: string; // color del cargo
  exclude?: StackField[]; // campos que este template rinde en su "chrome" (banda, header, etc.)
}

/** Rindió UN campo de la columna de datos, respetando visibilidad y estilo. */
function renderField(ctx: SignatureContext, key: StackField, ac: string, opts?: StackOpts): string {
  switch (key) {
    case 'name':
      return `<div style="font-size:${String(opts?.nameSize ?? 17)}px;font-weight:bold;color:${INK}">${esc(ctx.displayName)}</div>`;
    case 'title':
      return role(ctx)
        ? `<div style="color:${opts?.titleColor ?? ac};font-weight:bold;font-size:13px">${role(ctx)}</div>`
        : '';
    case 'company':
      return !isHidden(ctx, 'company') && !opts?.hideCompany && ctx.companyName
        ? `<div style="color:${MUTED};font-size:13px">${esc(ctx.companyName)}</div>`
        : '';
    case 'phone': {
      const p = ctx.personalPhone ?? ctx.companyPhone;
      return isHidden(ctx, 'phone') || !p
        ? ''
        : contactBlock(ctx, 'icon-phone', p, `tel:${p}`, opts);
    }
    case 'email':
      return isHidden(ctx, 'email')
        ? ''
        : contactBlock(ctx, 'icon-mail', ctx.email, `mailto:${ctx.email}`, opts);
    case 'website':
      return isHidden(ctx, 'website') || !ctx.domainUrl
        ? ''
        : contactBlock(ctx, 'icon-web', cleanHost(ctx.domainUrl), ctx.domainUrl, opts);
    case 'address':
      return isHidden(ctx, 'address') || !ctx.address
        ? ''
        : contactBlock(ctx, 'icon-location', ctx.address, undefined, opts);
    case 'tagline':
      return quote(ctx);
    case 'social':
      return socialButtons(ctx);
    default:
      return '';
  }
}

/** Columna de datos COMPONIBLE: rinde los campos en el orden del admin (drag-and-drop), respetando los
 *  toggles de visibilidad. Reemplaza la vieja composición fija nombre+contacto+eslogan+redes. */
function fieldStack(ctx: SignatureContext, ac: string, opts?: StackOpts): string {
  const ex = new Set(opts?.exclude ?? []);
  const html = orderedStack(ctx)
    .filter((k) => !ex.has(k))
    .map((k) => renderField(ctx, k, ac, opts))
    .join('');
  // Alineación: centra el stack (los contactBlock ya se auto-centran con margin:0 auto).
  return styleOf(ctx).align === 'center' ? `<div style="text-align:center">${html}</div>` : html;
}
/** Ancho en px SEGURO: entero acotado 1–1000. Si el valor no es un número finito (llamada directa fuera
 *  del schema Zod del admin), cae al default → nunca produce `width:130pxpx` ni rompe el atributo. */
function pxWidth(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 1000) : fallback;
}
function logo(ctx: SignatureContext, w?: number): string {
  return img(
    ctx.logoUrl,
    ctx.companyName ?? '',
    `width:${String(pxWidth(w ?? ctx.logoWidthPx, 130))}px;height:auto;display:block`
  );
}
/** Logo VERTICAL (para layouts apilados/centrados); cae al horizontal si no hay vertical. */
function logoV(ctx: SignatureContext, w?: number): string {
  return img(
    ctx.logoVerticalUrl ?? ctx.logoUrl,
    ctx.companyName ?? '',
    `width:${String(pxWidth(w, 90))}px;height:auto;display:block;margin:0 auto`
  );
}
function cleanHost(url: string | undefined): string {
  try {
    return new URL((url ?? '').trim()).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ────────────────────────────── Templates (nombres del diseño) ──────────────────────────────

/** 1) Clásica — avatar a la izquierda, datos con filas-icono + redes (el default del diseño). */
function clasica(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  return (
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK}"><tr>` +
    `<td style="padding-right:18px;vertical-align:top">${avatar(ctx, ac, 72)}</td>` +
    `<td style="vertical-align:top">${fieldStack(ctx, ac)}</td>` +
    `</tr></table>`
  );
}

/** 2) Moderna — barra de acento lateral, tipografía aireada, sin foto. */
function moderna(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  return (
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK}"><tr>` +
    `<td style="border-left:3px solid ${ac};padding-left:16px;vertical-align:top">` +
    (logo(ctx, 120) ? `<div style="margin-bottom:8px">${logo(ctx, 120)}</div>` : '') +
    fieldStack(ctx, ac) +
    `</td></tr></table>`
  );
}

/** 3) Minimalista — una línea de datos, sin imágenes ni redes (máxima compatibilidad). */
function minimalista(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const parts = [
    `<strong>${esc(ctx.displayName)}</strong>`,
    role(ctx),
    !isHidden(ctx, 'company') && ctx.companyName
      ? `<span style="color:${ac};font-weight:bold">${esc(ctx.companyName)}</span>`
      : '',
    isHidden(ctx, 'email')
      ? ''
      : link(`mailto:${ctx.email}`, ctx.email, `color:${ac};text-decoration:none`),
    !isHidden(ctx, 'website') && ctx.domainUrl
      ? link(ctx.domainUrl, cleanHost(ctx.domainUrl), `color:${ac};text-decoration:none`)
      : '',
  ].filter(Boolean);
  return `<div style="${fontDecl(ctx)};font-size:13px;color:${INK}">${parts.join(sepText(ctx))}</div>`;
}

/** 4) Tarjeta — bloque con borde y fondo suave, avatar + datos + redes. */
function tarjeta(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  return (
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK};border:1px solid #e5e7eb;border-radius:10px;background:#fafbfc"><tr>` +
    `<td style="padding:16px 18px;vertical-align:top">${avatar(ctx, ac, 56)}</td>` +
    `<td style="padding:16px 18px 16px 0;vertical-align:top">${fieldStack(ctx, ac)}</td>` +
    `</tr></table>`
  );
}

/** 5) Centrada — avatar arriba, todo centrado. */
function centrada(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const social = socialButtons(ctx);
  const vlogo = logoV(ctx, 90);
  return (
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK};text-align:center"><tr><td align="center">` +
    (vlogo ? `<div style="margin-bottom:8px">${vlogo}</div>` : '') +
    `<div>${avatar(ctx, ac, 64)}</div>` +
    `<div style="margin-top:8px">${renderField(ctx, 'name', ac)}${renderField(ctx, 'title', ac)}${renderField(ctx, 'company', ac)}</div>` +
    (() => {
      // Respeta los toggles email/website (HIGH del review B) + el separador elegido.
      const line = [
        isHidden(ctx, 'email')
          ? ''
          : link(`mailto:${ctx.email}`, ctx.email, `color:${ac};text-decoration:none`),
        !isHidden(ctx, 'website') && ctx.domainUrl
          ? link(ctx.domainUrl, cleanHost(ctx.domainUrl), `color:${ac};text-decoration:none`)
          : '',
      ]
        .filter(Boolean)
        .join(sepText(ctx));
      return line ? `<div style="margin-top:6px;color:${MUTED};font-size:13px">${line}</div>` : '';
    })() +
    (social ? `<div align="center">${social}</div>` : '') +
    `</td></tr></table>`
  );
}

/** 6) Corporativa — letterhead: cabecera con logo/empresa + línea de acento, luego avatar + datos. */
function corporativa(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const lg = logo(ctx, 150);
  // Empresa en la cabecera SOLO cuando no hay logo (letterhead de texto); ahí se oculta en nameBlock
  // para no duplicarla. Con logo, la cabecera es la imagen y nameBlock sí muestra el nombre de empresa.
  const showTagline = !isHidden(ctx, 'tagline') && ctx.tagline;
  const companyInHeader = !lg && Boolean(ctx.companyName) && !isHidden(ctx, 'company');
  const header = lg
    ? `<tr><td style="padding-bottom:12px;border-bottom:2px solid ${ac}">${lg}` +
      (showTagline
        ? `<div style="color:${FAINT};font-size:12px;margin-top:4px">${esc(ctx.tagline ?? '')}</div>`
        : '') +
      `</td></tr>`
    : companyInHeader
      ? `<tr><td style="padding-bottom:10px;border-bottom:2px solid ${ac}">` +
        `<span style="font-size:16px;font-weight:bold;color:${ac}">${esc(ctx.companyName ?? '')}</span>` +
        (showTagline
          ? `<span style="color:${FAINT};font-size:12px"> — ${esc(ctx.tagline ?? '')}</span>`
          : '') +
        `</td></tr>`
      : '';
  return (
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK}">` +
    header +
    `<tr><td style="padding-top:14px">` +
    `<table cellpadding="0" cellspacing="0"><tr>` +
    `<td style="padding-right:16px;vertical-align:top">${avatar(ctx, ac, 60)}</td>` +
    // Si hay cabecera (logo o empresa-texto), el tagline ya va ahí → se excluye del stack para no duplicarlo.
    `<td style="vertical-align:top">${fieldStack(ctx, ac, { hideCompany: companyInHeader, exclude: header ? ['tagline'] : [] })}</td>` +
    `</tr></table></td></tr></table>`
  );
}

/** 7) Cleverty — avatar con anillo de acento + divisor, datos en negrita, y columna de marca a la
 *  derecha (logo/empresa + tagline en versalitas + badges App Store/Google Play). Fiel a la firma de
 *  referencia de Cleverty; el logo/tagline/URLs de apps salen del branding del admin. */
function cleverty(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const lg = logo(ctx, 130);
  const brand =
    (lg ||
      (!isHidden(ctx, 'company') && ctx.companyName
        ? `<div style="font-size:18px;font-weight:bold;color:${ac}">${esc(ctx.companyName)}</div>`
        : '')) +
    (!isHidden(ctx, 'tagline') && ctx.tagline
      ? `<div style="color:${FAINT};font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-top:4px">${esc(ctx.tagline)}</div>`
      : '');
  const badges = appBadges(ctx);
  const rightCol =
    brand || badges
      ? `<td style="vertical-align:top;border-left:1px solid #e5e7eb;padding-left:18px">${brand}${badges ? `<div style="margin-top:12px">${badges}</div>` : ''}</td>`
      : '';
  return (
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK}"><tr>` +
    `<td style="padding-right:18px;vertical-align:middle">${ringedAvatar(ctx, ac, 76)}</td>` +
    `<td style="vertical-align:top;border-left:1px solid #e5e7eb;padding-left:18px;padding-right:18px">` +
    `<div style="font-size:18px;font-weight:bold;color:${INK}">${esc(ctx.displayName)}</div>` +
    (role(ctx)
      ? `<div style="color:${MUTED};font-weight:bold;font-size:13px">${role(ctx)}</div>`
      : '') +
    // Contactos (en negrita) + redes, en el orden del admin. Nombre/cargo van arriba; empresa/tagline
    // viven en la columna de marca de la derecha, por eso se excluyen del stack.
    fieldStack(ctx, ac, { bold: true, exclude: ['name', 'title', 'company', 'tagline'] }) +
    `</td>` +
    rightCol +
    `</tr></table>`
  );
}

/** 8) Banner — cabecera con banda de color de acento (nombre en blanco), cuerpo con contacto + redes. */
function banner(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const sub = [role(ctx), !isHidden(ctx, 'company') && ctx.companyName ? esc(ctx.companyName) : '']
    .filter(Boolean)
    .join(sepText(ctx));
  return (
    // Sin overflow:hidden (el sanitizer lo descarta): la banda redondea sus PROPIAS esquinas superiores,
    // así el redondeo es robusto aunque el clip del contenedor no exista.
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK};border:1px solid #e5e7eb;border-radius:10px">` +
    `<tr><td style="background-color:${ac};padding:14px 20px;border-radius:9px 9px 0 0">` +
    `<div style="font-size:18px;font-weight:bold;color:#ffffff">${esc(ctx.displayName)}</div>` +
    (sub ? `<div style="color:#ffffff;font-size:13px">${sub}</div>` : '') +
    `</td></tr>` +
    // Nombre/cargo/empresa van en la banda; el cuerpo rinde contactos + eslogan + redes en orden del admin.
    `<tr><td style="padding:14px 20px">${fieldStack(ctx, ac, { exclude: ['name', 'title', 'company'] })}</td></tr>` +
    `</table>`
  );
}

/** 9) Ejecutiva — nombre grande, regla de acento corta, cargo·empresa, contacto y redes. Sobria. */
function ejecutiva(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const sub = [
    role(ctx),
    !isHidden(ctx, 'company') && ctx.companyName
      ? `<span style="color:${ac};font-weight:bold">${esc(ctx.companyName)}</span>`
      : '',
  ]
    .filter(Boolean)
    .join(sepText(ctx));
  return (
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK}"><tr><td>` +
    `<div style="font-size:19px;font-weight:bold;color:${INK};letter-spacing:.3px">${esc(ctx.displayName)}</div>` +
    // Regla de acento sobre un <td> (no <div>): Outlook rinde bordes en celdas, no en div (como corporativa).
    `<table cellpadding="0" cellspacing="0" style="margin:7px 0"><tr><td style="border-top:2px solid ${ac};width:36px;font-size:0;line-height:0">&nbsp;</td></tr></table>` +
    (sub ? `<div style="color:${MUTED};font-size:13px">${sub}</div>` : '') +
    // Nombre/cargo/empresa arriba; el cuerpo rinde contactos + eslogan + redes en el orden del admin.
    fieldStack(ctx, ac, { exclude: ['name', 'title', 'company'] }) +
    `</td></tr></table>`
  );
}

/** 10) Compacta — avatar chico + nombre/cargo, contacto en una línea con separadores (huella mínima). */
function compacta(ctx: SignatureContext): string {
  const ac = color(ctx.accentColor);
  const rol = role(ctx);
  const phone = ctx.personalPhone ?? ctx.companyPhone;
  const av = avatar(ctx, ac, 46);
  const parts = [
    isHidden(ctx, 'phone') || !phone
      ? ''
      : link(`tel:${phone}`, phone, `color:${MUTED};text-decoration:none`),
    isHidden(ctx, 'email')
      ? ''
      : link(`mailto:${ctx.email}`, ctx.email, `color:${ac};text-decoration:none`),
    isHidden(ctx, 'website') || !ctx.domainUrl
      ? ''
      : link(ctx.domainUrl, cleanHost(ctx.domainUrl), `color:${ac};text-decoration:none`),
  ].filter(Boolean);
  return (
    `<table cellpadding="0" cellspacing="0" style="${fontDecl(ctx)};color:${INK}"><tr>` +
    (av ? `<td style="padding-right:14px;vertical-align:middle">${av}</td>` : '') +
    `<td style="vertical-align:middle">` +
    `<div style="font-size:15px;font-weight:bold;color:${INK}">${esc(ctx.displayName)}${rol ? `<span style="color:${MUTED};font-weight:normal">${sepText(ctx)}${rol}</span>` : ''}</div>` +
    (!isHidden(ctx, 'company') && ctx.companyName
      ? `<div style="color:${ac};font-weight:bold;font-size:12px">${esc(ctx.companyName)}</div>`
      : '') +
    (parts.length
      ? `<div style="margin-top:4px;color:${MUTED};font-size:12px">${parts.join(sepText(ctx))}</div>`
      : '') +
    socialButtons(ctx, 22) +
    `</td></tr></table>`
  );
}

export const SIGNATURE_TEMPLATES = [
  { id: 'clasica', nameKey: 'settings.signatureTpl.clasica', render: clasica },
  { id: 'moderna', nameKey: 'settings.signatureTpl.moderna', render: moderna },
  { id: 'minimalista', nameKey: 'settings.signatureTpl.minimalista', render: minimalista },
  { id: 'tarjeta', nameKey: 'settings.signatureTpl.tarjeta', render: tarjeta },
  { id: 'centrada', nameKey: 'settings.signatureTpl.centrada', render: centrada },
  { id: 'corporativa', nameKey: 'settings.signatureTpl.corporativa', render: corporativa },
  { id: 'cleverty', nameKey: 'settings.signatureTpl.cleverty', render: cleverty },
  { id: 'banner', nameKey: 'settings.signatureTpl.banner', render: banner },
  { id: 'ejecutiva', nameKey: 'settings.signatureTpl.ejecutiva', render: ejecutiva },
  { id: 'compacta', nameKey: 'settings.signatureTpl.compacta', render: compacta },
] as const satisfies readonly SignatureTemplate[];

export type SignatureTemplateId = (typeof SIGNATURE_TEMPLATES)[number]['id'];
export const SIGNATURE_TEMPLATE_IDS = SIGNATURE_TEMPLATES.map((t) => t.id);
const BY_ID = new Map<string, SignatureTemplate>(SIGNATURE_TEMPLATES.map((t) => [t.id, t]));

export function isValidTemplateId(id: string): id is SignatureTemplateId {
  return BY_ID.has(id);
}

/** Rendiza la firma del template `id`. Si el id no existe, cae al primero. */
export function renderSignature(id: string, ctx: SignatureContext): string {
  const tpl = BY_ID.get(id) ?? SIGNATURE_TEMPLATES[0];
  return tpl.render(ctx);
}

/** Fallback determinístico en TEXTO PLANO (firma mínima si el render falla y es obligatoria). */
export function minimalPlainSignature(ctx: SignatureContext): string {
  const parts = [ctx.displayName, ctx.companyName, ctx.email]
    .filter(Boolean)
    .map((s) => esc(s ?? ''));
  return `<div style="${fontDecl(ctx)};font-size:13px;color:${INK}">${parts.join(sepText(ctx))}</div>`;
}
