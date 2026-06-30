import { SystemConfig } from '../models/SystemConfig.js';

/**
 * Defaults de almacenamiento a nivel instancia (F6) — singleton en `SystemConfig` (key='storageDefaults'),
 * MISMO patrón que calendar/scheduling/branding. Por ahora sólo la cuota por defecto de cuentas NUEVAS.
 *
 * Semántica (review C): el default se aplica SÓLO al crear una cuenta cuando no se envía `quotaBytes`;
 * NUNCA migra cuentas existentes. `defaultQuotaBytes:0` = sin límite (= comportamiento legado).
 */
export interface StorageDefaults {
  defaultQuotaBytes: number;
}
const KEY = 'storageDefaults';
export const DEFAULT_STORAGE_DEFAULTS: StorageDefaults = { defaultQuotaBytes: 0 };

export async function getStorageDefaults(): Promise<StorageDefaults> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean<{
    value?: Partial<StorageDefaults>;
  } | null>();
  const v = doc?.value ?? {};
  return {
    defaultQuotaBytes: v.defaultQuotaBytes ?? DEFAULT_STORAGE_DEFAULTS.defaultQuotaBytes,
  };
}

export async function setStorageDefaults(
  patch: Partial<StorageDefaults>
): Promise<StorageDefaults> {
  const current = await getStorageDefaults();
  const value: StorageDefaults = { ...current, ...patch };
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}
