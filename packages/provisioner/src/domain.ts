/**
 * Validación de dominio (FQDN) y derivación del hostname del servidor de correo.
 *
 * Reglas: labels de 1–63 chars [a-z0-9-] sin empezar/terminar en guion, total ≤253, al menos un
 * punto (un TLD desnudo como "localhost" no sirve para correo público).
 */
const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const FQDN = new RegExp(`^(?=.{1,253}$)${LABEL}(\\.${LABEL})+$`, 'i');

export function validateDomain(domain: string): boolean {
  return FQDN.test(domain.trim());
}

/** Hostname del MX/host de correo para un dominio (p. ej. example.com → mail.example.com). */
export function mailHostname(domain: string): string {
  return `mail.${domain.trim().toLowerCase()}`;
}
