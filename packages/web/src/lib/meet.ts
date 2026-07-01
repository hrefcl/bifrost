/**
 * Helpers puros de Bifrost Meet (webmail). Extraídos para testear la lógica de parseo sin montar el
 * componente (el repo aún no tiene harness de componentes — ver TD-WEB-COMPONENT-TESTS).
 */

/**
 * Extrae el slug de una sala desde lo que el usuario pega para "unirse": un link completo
 * (`https://…/meet/<slug>`), un path (`/meet/<slug>`) o el código pelado (`<slug>`). Devuelve '' si no
 * se reconoce un slug válido. Espeja la validación del backend: `[A-Za-z0-9_-]{8,64}` (rechaza códigos
 * demasiado cortos/largos inline, en vez de mandar basura a `/meet/:slug`). [review B-LOW]
 */
export function meetSlugFromInput(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  const m = /\/meet\/([A-Za-z0-9_-]{8,64})(?:[/?#]|$)/.exec(v);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : '';
}
