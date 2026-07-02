import { SystemConfig } from '../../models/SystemConfig.js';
import type { MailboxProviderType } from './types.js';

/**
 * Config del provisioning de buzones (persistida en `SystemConfig` key='mailbox-provisioning').
 *
 * Dos vías de configuración (como pidió el producto), ambas terminan en este mismo doc:
 *  1. ENV al instalar desde cero: el provisioner setea `DMS_ACCOUNTS_FILE` (+ `DMS_MAILDATA_DIR`) y
 *     `seedMailboxConfigFromEnv()` lo materializa en el primer boot → turnkey, sin intervención.
 *  2. Configurador del admin: `setMailboxConfig()` lo edita en caliente desde /admin.
 *
 * No hay secretos acá (son rutas de archivo dentro del contenedor) → no se cifra nada, a diferencia de
 * `storage/config.ts`. La vista es directamente pública.
 */
export interface DockerMailserverSettings {
  /** Ruta al postfix-accounts.cf montado en el contenedor api (volumen compartido con el mailserver). */
  accountsFile: string;
  /** Raíz del maildata de DMS (para borrar el Maildir al eliminar un buzón). Opcional. */
  maildataDir?: string;
}

export interface MailboxConfig {
  providerType: MailboxProviderType;
  dockerMailserver?: DockerMailserverSettings;
  updatedBy?: string;
  updatedAt?: string;
}

/** Entrada del admin (o del seed). Para `docker-mailserver` exige la ruta del accounts file. */
export type MailboxConfigInput =
  | { providerType: 'none' }
  | { providerType: 'docker-mailserver'; dockerMailserver: DockerMailserverSettings };

const KEY = 'mailbox-provisioning';
const DEFAULT: MailboxConfig = { providerType: 'none' };

/** Config actual. Si nunca se configuró → `none` (el alta desde admin sólo verifica buzones existentes). */
export async function getMailboxConfig(): Promise<MailboxConfig> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean();
  return (doc?.value as MailboxConfig | undefined) ?? DEFAULT;
}

/** Persiste la config del admin y la devuelve. */
export async function setMailboxConfig(
  input: MailboxConfigInput,
  updatedBy: string
): Promise<MailboxConfig> {
  const value: MailboxConfig = { ...input, updatedBy, updatedAt: new Date().toISOString() };
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}

/**
 * Siembra la config desde el ENTORNO en el PRIMER boot (turnkey). Si el provisioner seteó
 * `DMS_ACCOUNTS_FILE`, materializa un provider `docker-mailserver`. Sólo actúa si NO hay config previa
 * (el admin manda). Devuelve true si sembró.
 */
export async function seedMailboxConfigFromEnv(): Promise<boolean> {
  // process.env (no el `env` congelado al boot) → testeable y re-configurable sin reiniciar, igual que
  // routes/config.ts. El schema en config/env.ts documenta/valida DMS_ACCOUNTS_FILE/DMS_MAILDATA_DIR.
  const accountsFile = process.env.DMS_ACCOUNTS_FILE?.trim();
  if (!accountsFile) return false;
  const existing = await SystemConfig.findOne({ key: KEY }).lean();
  if (existing) return false;
  const maildataDir = process.env.DMS_MAILDATA_DIR?.trim();
  await setMailboxConfig(
    {
      providerType: 'docker-mailserver',
      dockerMailserver: { accountsFile, ...(maildataDir ? { maildataDir } : {}) },
    },
    'system:env-seed'
  );
  return true;
}
