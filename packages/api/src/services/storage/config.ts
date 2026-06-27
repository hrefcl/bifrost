import { SystemConfig } from '../../models/SystemConfig.js';
import type { StorageType } from './types.js';

/**
 * Config del storage (persistida en `SystemConfig` key='storage'). Para PR-B sólo `local`
 * (sin secretos). Los campos de `s3` (con secret CIFRADO) llegan en PR-D.
 */
export interface StorageConfig {
  providerType: StorageType;
  s3?: { endpoint?: string; bucket: string; region: string; accessKeyId: string };
  updatedBy?: string;
  updatedAt?: string;
}

const KEY = 'storage';
const DEFAULT: StorageConfig = { providerType: 'local' };

/** Config actual; si nunca se configuró → `local` (la feature de adjuntos nunca se bloquea). */
export async function getStorageConfig(): Promise<StorageConfig> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean();
  return (doc?.value as StorageConfig | undefined) ?? DEFAULT;
}

/** Vista pública (sin secretos) — lo que devuelve el GET del admin. */
export async function getStorageConfigPublic(): Promise<StorageConfig> {
  const cfg = await getStorageConfig();
  // (cuando exista s3.secret cifrado, NO se incluye acá; el front muestra '••••')
  return cfg;
}

export async function setStorageConfig(
  cfg: Omit<StorageConfig, 'updatedAt'>,
  updatedBy: string
): Promise<StorageConfig> {
  const value: StorageConfig = { ...cfg, updatedBy, updatedAt: new Date().toISOString() };
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}
