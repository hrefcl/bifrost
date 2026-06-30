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
// Marcadores vendor-específicos de "esto es una cita de respuesta" (review B/D): Gmail, Apple Mail,
// Thunderbird, Outlook web (OWA), Yahoo, ProtonMail. `blockquote[type="cite"]` es señal fuerte estándar.
const QUOTE_SEL = [
  '.gmail_quote',
  '.gmail_attr',
  'blockquote[type="cite"]',
  '.moz-cite-prefix',
  '.OutlookMessageHeader',
  '#divRplyFwdMsg',
  '#appendonsend',
  '.AppleMailQuote',
  '.yahoo_quoted',
  '.protonmail_quote',
].join(', ');

function serialize(n: Node): string {
  return n.nodeType === Node.ELEMENT_NODE ? (n as Element).outerHTML : (n.textContent ?? '');
}

export function splitEmailQuote(html: string): { main: string; quoted: string } {
  try {
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    const start = body.querySelector(QUOTE_SEL); // primer match en orden de documento
    if (!start) return { main: html, quoted: '' };

    // CORTE "desde el nodo hasta el final del documento" (no sólo el nodo): saca el marcador y TODO lo
    // que sigue en orden de documento, subiendo por los ancestros. Maneja (a) el `.gmail_attr` ("On…
    // wrote:") que es HERMANO previo al blockquote, y (b) el email entero envuelto en un <div> raíz
    // (remover sólo el nodo dejaría la cita o todo el contenido del lado equivocado).
    const quotedParts: string[] = [];
    let node: Node = start;
    let first = true;
    while (node !== body) {
      const parent: Node | null = node.parentNode;
      if (!parent) break;
      // Nivel 0: el nodo + sus hermanos siguientes. Niveles superiores: SÓLO los hermanos siguientes
      // del ancestro (el ancestro queda, porque tiene el contenido nuevo previo a la cita).
      let sib: Node | null = first ? node : node.nextSibling;
      while (sib) {
        const next: Node | null = sib.nextSibling;
        quotedParts.push(serialize(sib));
        parent.removeChild(sib);
        sib = next;
      }
      first = false;
      node = parent;
    }

    const main = body.innerHTML;
    // Si el contenido nuevo quedó sin texto (todo era cita, p.ej. un forward), no colapsar.
    if (!main.replace(/<[^>]*>/g, '').trim()) return { main: html, quoted: '' };
    return { main, quoted: quotedParts.join('') };
  } catch {
    return { main: html, quoted: '' };
  }
}
