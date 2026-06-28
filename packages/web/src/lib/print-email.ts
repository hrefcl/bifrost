/** Escapa texto para insertarlo seguro en HTML (cabeceras del mensaje: asunto, remitente, fecha). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PrintEmailInput {
  subject: string;
  fromName: string;
  fromAddress: string;
  toLabel: string;
  dateText: string;
  /** Cuerpo HTML YA saneado por el backend (sanitize-html). Si falta, se usa `text`. */
  sanitizedHtml?: string;
  text?: string;
}

/**
 * Construye el documento HTML de impresión de un email. Las CABECERAS (asunto/remitente/fecha) se
 * ESCAPAN (texto plano del usuario → nunca HTML). El CUERPO usa el `sanitizedHtml` que el backend ya
 * saneó (mismo contenido que el panel de lectura); si no hay, se cae al `text` escapado en <pre>.
 * Función pura (no toca el DOM) para poder testear el escape sin un navegador.
 */
export function buildEmailPrintHtml(input: PrintEmailInput): string {
  const subject = escapeHtml(input.subject);
  const fromName = escapeHtml(input.fromName);
  const fromAddress = escapeHtml(input.fromAddress);
  const toLabel = escapeHtml(input.toLabel);
  const dateText = escapeHtml(input.dateText);
  let bodyHtml: string;
  if (input.sanitizedHtml) {
    bodyHtml = input.sanitizedHtml; // ya saneado por el backend
  } else {
    bodyHtml = `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(input.text ?? '')}</pre>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${subject}</title>
<style>
  body { font-family: 'Public Sans', system-ui, sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .meta { font-size: 13px; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 12px; margin-bottom: 16px; }
  .meta .from { color: #111; font-weight: 600; }
  .body { font-size: 14px; line-height: 1.5; }
  img { max-width: 100%; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>${subject}</h1>
<div class="meta">
  <div><span class="from">${fromName}</span> &lt;${fromAddress}&gt;</div>
  <div>${toLabel}</div>
  <div>${dateText}</div>
</div>
<div class="body">${bodyHtml}</div>
</body>
</html>`;
}
