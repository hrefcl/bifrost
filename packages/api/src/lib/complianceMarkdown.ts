import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

/**
 * Pipeline Markdown → HTML saneado DEDICADO para documentos de compliance (DESIGN v4 §6).
 *
 * NO reusa `lib/sanitizeHtml.ts` (orientado a email, permite estilos/imágenes). Aquí:
 * 1. markdown-it con `html: false` → el HTML crudo embebido en el markdown se ESCAPA (no se parsea).
 * 2. sanitize-html con allowlist ESTRICTA de documento legal. Sin `img`, `style`, `script`,
 *    `iframe`, `on*`, ni esquemas `javascript:`/`data:` ejecutables.
 *
 * `PIPELINE_VERSION` se persiste con `bodyHtml` (DESIGN §2.2 C-L7): si el pipeline cambia, se sabe
 * que el mismo markdown podría renderizar distinto → prueba del render exacto mostrado.
 */
export const PIPELINE_VERSION = 'compliance-md-v1';

const md = new MarkdownIt({
  html: false, // crítico: nada de HTML crudo del autor
  linkify: false, // no autolinkear texto suelto (control explícito del autor)
  breaks: false,
});

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'ul',
    'ol',
    'li',
    'strong',
    'em',
    'blockquote',
    'a',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'hr',
    'code',
    'pre',
    'br',
  ],
  allowedAttributes: {
    // `rel`/`target` deben listarse para que el `transformTags` de abajo no los descarte.
    a: ['href', 'rel', 'target'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },
  // Sólo enlaces http/https/mailto; bloquea javascript:, data:, file:, etc.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  // Fuerza rel seguro en enlaces externos (defensa contra tabnabbing).
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
  },
  disallowedTagsMode: 'discard',
};

/** Renderiza markdown de compliance a HTML saneado. Devuelve el HTML y la versión del pipeline. */
export function renderComplianceMarkdown(markdown: string): {
  html: string;
  pipelineVersion: string;
} {
  const rawHtml = md.render(markdown);
  const html = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  return { html, pipelineVersion: PIPELINE_VERSION };
}
