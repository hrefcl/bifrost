import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import { getStorageConfig } from './config.js';
import { decrypt } from '../../config/crypto.js';
import type { StorageProvider, StorageType } from './types.js';

export type { StorageProvider, StorageType } from './types.js';
export { newStorageKey } from './types.js';
export {
  getStorageConfig,
  getStorageConfigPublic,
  setStorageConfig,
  toPublicStorageConfig,
  type StorageConfig,
  type StorageConfigInput,
  type PublicStorageConfig,
} from './config.js';

/**
 * Construye el provider de un tipo dado (para LEER un blob por su `providerType` de origen).
 * Para `s3` lee la config persistida y DESCIFRA el secret en el momento (nunca se mantiene en
 * claro fuera de esta llamada). Async: el caller debe await-ear.
 */
export async function providerForType(type: StorageType): Promise<StorageProvider> {
  switch (type) {
    case 'local':
      return new LocalStorage();
    case 's3': {
      // Lee la config s3 AUNQUE el provider activo sea otro: un blob con providerType='s3'
      // debe poder leerse siempre (provider-bound), no sólo mientras s3 esté activo.
      const cfg = await getStorageConfig();
      if (!cfg.s3) {
        throw new Error('S3 no está configurado');
      }
      return new S3Storage({
        endpoint: cfg.s3.endpoint,
        bucket: cfg.s3.bucket,
        region: cfg.s3.region,
        accessKeyId: cfg.s3.accessKeyId,
        secretAccessKey: decrypt(cfg.s3.secretAccessKey),
      });
    }
    default:
      // Defensa: un providerType inesperado (dato corrupto) no debe devolver undefined.
      throw new Error(`Unknown storage provider: ${String(type)}`);
  }
}

/** Provider ACTIVO (para ESCRITURAS nuevas), según la config del admin. */
export async function getActiveStorage(): Promise<StorageProvider> {
  const cfg = await getStorageConfig();
  return providerForType(cfg.providerType);
}
