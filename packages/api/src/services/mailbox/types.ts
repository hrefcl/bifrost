/**
 * Provisioning de buzones — Bifrost como AUTORIDAD de cuentas de correo.
 *
 * Abstracción PLUGGABLE (mismo patrón que `services/storage`): el resto del código no sabe qué backend
 * crea los buzones. Hoy hay un provider (`docker-mailserver`, el turnkey de Bifrost); mañana puede haber
 * exec, API remota o LDAP sin tocar los callers. Se elige/parametriza por config (env al instalar O el
 * configurador del admin) — ver `./config.ts`.
 */

/** Backends de provisioning soportados. `none` = la API no crea buzones (sólo verifica existentes). */
export type MailboxProviderType = 'none' | 'docker-mailserver';

export interface MailboxProvider {
  readonly type: MailboxProviderType;
  /** Crea el buzón REAL en el sistema de correo. Lanza `MailboxExistsError` si ya existe. */
  createMailbox(email: string, password: string): Promise<void>;
  /** Borra el buzón (quita el acceso IMAP/SMTP). `purgeMaildir` además elimina el correo almacenado. */
  deleteMailbox(email: string, opts?: { purgeMaildir?: boolean }): Promise<void>;
  /** ¿Existe el buzón en el sistema de correo? (case-insensitive) */
  mailboxExists(email: string): Promise<boolean>;
  /** Lista los emails de todos los buzones ACTIVOS. */
  listMailboxes(): Promise<string[]>;
  /** Línea cruda `email|hash` del buzón (para suspender/restaurar sin perder la password), o null. */
  getRawLine(email: string): Promise<string | null>;
  /** Cambia la contraseña de un buzón EXISTENTE. Lanza si no existe. */
  setPassword(email: string, password: string): Promise<void>;
  /** Restaura una línea cruda `email|hash` (reactivar un buzón suspendido). Idempotente. */
  addRawLine(rawLine: string): Promise<void>;
  /** Aliases que apuntan a `email`. */
  getAliases(email: string): Promise<string[]>;
  /** Reemplaza el set de aliases que apuntan a `email`. */
  setAliases(email: string, aliases: string[]): Promise<void>;
}

/** El provider activo no puede crear buzones (providerType='none' o no configurado). */
export class ProvisioningDisabledError extends Error {
  constructor() {
    super('El provisioning de buzones no está habilitado en este servidor.');
    this.name = 'ProvisioningDisabledError';
  }
}

/** Se intentó crear un buzón que ya existe en el sistema de correo. */
export class MailboxExistsError extends Error {
  constructor(email: string) {
    super(`El buzón ${email} ya existe.`);
    this.name = 'MailboxExistsError';
  }
}
