import { LocalStorage } from './local.js';
import { getStorageConfig } from './config.js';
import type { StorageProvider, StorageType } from './types.js';

export type { StorageProvider, StorageType } from './types.js';
export { newStorageKey } from './types.js';
export {
  getStorageConfig,
  getStorageConfigPublic,
  setStorageConfig,
  type StorageConfig,
} from './config.js';

/** Construye el provider de un tipo dado (para LEER un blob por su `providerType` de origen). */
export function providerForType(type: StorageType): StorageProvider {
  switch (type) {
    case 'local':
      return new LocalStorage();
    case 's3':
      // Llega en PR-D. Hasta entonces, elegir s3 en el wizard se rechaza en el endpoint.
      throw new Error('S3 storage no implementado todavía');
  }
}

/** Provider ACTIVO (para ESCRITURAS nuevas), según la config del admin. */
export async function getActiveStorage(): Promise<StorageProvider> {
  const cfg = await getStorageConfig();
  return providerForType(cfg.providerType);
}
