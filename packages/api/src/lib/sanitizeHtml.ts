import sanitize from 'sanitize-html';

// Valor CSS SEGURO: rechaza cualquier valor que contenga un vector. Además de `url(`/`javascript:`/
// `expression(`, BLOQUEA backslash `\` (escapes CSS tipo `\75 rl(` que reconstruyen `url(` y burlan
// un regex ingenuo) y comentarios `/* */` (tokens partidos `url/**/(…)`), `@import` e `image-set(`.
// Permite colores/tamaños/fuentes/keywords/rgb()/calc(). [hardening por review B]
const SAFE_VALUE =
  /^(?!.*(?:url\s*\(|image-set\s*\(|javascript:|expression\s*\(|@import|\\|\/\*|<|>))[\s\S]*$/i;

// data: SÓLO imágenes RÁSTER (NO svg: un <img src=data:image/svg+xml> puede portar onload/scripts).
const RASTER_DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp);/i;

// Propiedades CSS permitidas en `style` (todas con el mismo guard SAFE_VALUE). Se EXCLUYE
// position/top/left/right/bottom/z-index → evita clickjacking (overlays absolutos sobre la UI).
const STYLE_PROPS = [
  'color',
  'background',
  'background-color',
  'font',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'font-variant',
  'text-align',
  'text-decoration',
  'text-transform',
  'text-indent',
  'line-height',
  'letter-spacing',
  'white-space',
  'width',
  'max-width',
  'min-width',
  'height',
  'max-height',
  'min-height',
  'margin',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'padding',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'border',
  'border-top',
  'border-bottom',
  'border-left',
  'border-right',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
  'border-collapse',
  'border-spacing',
  'display',
  'vertical-align',
  'box-shadow',
];
const SAFE_STYLES: Record<string, RegExp[]> = Object.fromEntries(
  STYLE_PROPS.map((p) => [p, [SAFE_VALUE]])
);

// Atributos de layout de email (HTML "de tabla") en celdas/tablas/imágenes. (Sin `title` → su
// contenido escapado disparaba el match de los tests mXSS y no aporta a la firma.)
const EMAIL_LAYOUT_ATTRS = [
  'style',
  'align',
  'valign',
  'width',
  'height',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'colspan',
  'rowspan',
  'dir',
];

export const defaultOptions: sanitize.IOptions = {
  allowedTags: sanitize.defaults.allowedTags.concat([
    'img',
    'h1',
    'h2',
    'blockquote',
    'hr',
    'font',
    'center',
    'u',
    's',
    'sup',
    'sub',
  ]),
  allowedAttributes: {
    ...sanitize.defaults.allowedAttributes,
    '*': ['style', 'align', 'dir'],
    img: ['src', 'alt', 'width', 'height', 'style'],
    a: ['href', 'target', 'rel', 'style'],
    table: EMAIL_LAYOUT_ATTRS,
    thead: EMAIL_LAYOUT_ATTRS,
    tbody: EMAIL_LAYOUT_ATTRS,
    tfoot: EMAIL_LAYOUT_ATTRS,
    tr: EMAIL_LAYOUT_ATTRS,
    td: EMAIL_LAYOUT_ATTRS,
    th: EMAIL_LAYOUT_ATTRS,
    font: ['color', 'face', 'size', 'style'],
  },
  allowedStyles: { '*': SAFE_STYLES },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // `data:` SOLO en <img> (logos embebidos de firmas) — y abajo un filtro restringe a data:image/* (NO
  // data:text/html, que sería un vector). NUNCA en <a href> (data: en un link es navegable/ejecutable).
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  transformTags: {
    a: sanitize.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    img: (tagName, attribs) => {
      // data: en <img> sólo si es imagen RÁSTER (png/jpeg/gif/webp/bmp). Cualquier otro data:
      // (text/html, image/svg+xml con scripts, etc.) → se descarta el src. [hardening review B]
      if (attribs.src && /^data:/i.test(attribs.src) && !RASTER_DATA_IMG.test(attribs.src)) {
        const { src: _drop, ...rest } = attribs;
        return { tagName, attribs: rest };
      }
      return { tagName, attribs };
    },
  },
};

export function sanitizeEmailHtml(html: string): string {
  return sanitize(html, defaultOptions);
}

export function plainTextFromHtml(html: string): string {
  return sanitize(html, { allowedTags: [], allowedAttributes: {} }).trim();
}

/**
 * Escapa texto para interpolar seguro en HTML (contenido y atributos). "Escape en origen": los
 * valores no confiables (nombre/cargo/teléfono del usuario, datos de marca) NUNCA se concatenan
 * crudos en un template; `sanitizeEmailHtml` queda como backstop, no como única capa (review firmas H1).
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Devuelve la URL escapada si su esquema es seguro para `href`/`src` salientes, o '' si no.
 * Sólo http/https/mailto/tel (bloquea javascript:/data:/vbscript: etc. — review firmas H1).
 */
export function safeUrl(url: string | undefined | null, allowMailtoTel = true): string {
  const v = (url ?? '').trim();
  if (!v) return '';
  let scheme: string;
  try {
    scheme = new URL(v).protocol;
  } catch {
    return '';
  }
  const ok = ['http:', 'https:', ...(allowMailtoTel ? ['mailto:', 'tel:'] : [])];
  return ok.includes(scheme) ? escapeHtml(v) : '';
}
