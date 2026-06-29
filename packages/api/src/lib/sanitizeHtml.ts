import sanitize from 'sanitize-html';

// Valor CSS SEGURO: cualquier valor que NO contenga `url(`, `javascript:`, `expression(` ni `<`/`>`.
// Esto neutraliza el ÚNICO vector real de los estilos inline (`background:url(javascript:…)`,
// `expression()`) sin tener que enumerar valores válidos. Permite colores/tamaños/fuentes/rgb()/keywords.
const SAFE_VALUE = /^(?!.*(?:url\s*\(|javascript:|expression\s*\(|<|>))[\s\S]*$/i;

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
  'opacity',
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
  allowedSchemes: ['http', 'https', 'mailto'],
  // `data:` SOLO en <img> (logos embebidos de firmas) — y abajo un filtro restringe a data:image/* (NO
  // data:text/html, que sería un vector). NUNCA en <a href> (data: en un link es navegable/ejecutable).
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  transformTags: {
    a: sanitize.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    img: (tagName, attribs) => {
      // data: en <img> sólo si es imagen real; data:text/html (u otros) → se descarta el src.
      if (attribs.src && /^data:/i.test(attribs.src) && !/^data:image\//i.test(attribs.src)) {
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
