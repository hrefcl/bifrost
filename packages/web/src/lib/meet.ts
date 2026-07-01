/**
 * Helpers puros de Bifrost Meet (webmail). Extraídos para testear la lógica de parseo sin montar el
 * componente (el repo aún no tiene harness de componentes — ver TD-WEB-COMPONENT-TESTS).
 */

/**
 * Extrae el slug de una sala desde lo que el usuario pega para "unirse": un link completo
 * (`https://…/meet/<slug>`), un path (`/meet/<slug>`) o el código pelado (`<slug>`). Devuelve '' si no
 * se puede reconocer un slug válido (caracteres de slug: alfanumérico, `_` y `-`).
 */
export function meetSlugFromInput(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  const m = /\/meet\/([A-Za-z0-9_-]+)/.exec(v);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]+$/.test(v) ? v : '';
}
