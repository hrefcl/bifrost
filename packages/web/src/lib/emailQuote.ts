/**
 * Separa el cuerpo HTML de un email en CONTENIDO NUEVO + CITA (el hilo previo citado debajo de la
 * respuesta), para colapsar la cita estilo Gmail ("···"). Detecta los marcadores típicos de los
 * clientes (Gmail, Apple Mail, Thunderbird, Outlook). `DOMParser('text/html')` es INERTE —no ejecuta
 * scripts ni carga recursos— así que parsear HTML no confiable acá no agrega superficie XSS (el HTML
 * igual va al iframe sandbox). Si no hay cita, o la cita es TODO el cuerpo (p.ej. un forward), devuelve
 * `quoted: ''` (no hay nada útil que colapsar).
 *
 * IMPORTANTE: sólo se usan marcadores de ALTA CONFIANZA de "esto es una cita de respuesta". A propósito
 * NO se incluye `<blockquote>` pelado: montones de emails legítimos (newsletters, testimonios, callouts)
 * lo usan para citas decorativas → colapsarlos escondería contenido real, peor que no colapsar. Los
 * clientes reales marcan sus citas con clases/atributos detectables (los de abajo). `blockquote[type=
 * "cite"]` sí es señal fuerte (Apple Mail/Thunderbird). Mejorar la detección de blockquote ambiguo
 * queda en TD-THREADING-UI.
 */
const QUOTE_SEL =
  '.gmail_quote, .gmail_attr, blockquote[type="cite"], .moz-cite-prefix, .OutlookMessageHeader, #appendonsend';

export function splitEmailQuote(html: string): { main: string; quoted: string } {
  try {
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    const found = body.querySelector(QUOTE_SEL); // primer match en orden de documento
    if (!found) return { main: html, quoted: '' };
    // Subir al hijo directo de <body> que contiene la cita → corte limpio en el nivel superior.
    let top: Element = found;
    while (top.parentElement && top.parentElement !== body) top = top.parentElement;
    const mainParts: string[] = [];
    const quotedParts: string[] = [];
    let inQuote = false;
    for (const node of Array.from(body.childNodes)) {
      if (node === top) inQuote = true;
      const frag =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element).outerHTML
          : (node.textContent ?? '');
      (inQuote ? quotedParts : mainParts).push(frag);
    }
    const main = mainParts.join('');
    // Si el contenido nuevo quedó vacío (todo era cita), no colapsar.
    if (!main.replace(/<[^>]*>/g, '').trim()) return { main: html, quoted: '' };
    return { main, quoted: quotedParts.join('') };
  } catch {
    return { main: html, quoted: '' };
  }
}
