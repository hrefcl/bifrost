import { SystemConfig } from '../../models/SystemConfig.js';
import { encrypt, type EncryptedPayload } from '../../config/crypto.js';
import type { StorageType } from './types.js';

/**
 * Config del storage (persistida en `SystemConfig` key='storage').
 *
 * Para `s3` la `secretAccessKey` se guarda SIEMPRE cifrada (AES-256-GCM) — nunca en claro en
 * Mongo ni en logs, y la vista pública la omite por completo (sólo expone `secretConfigured`).
 */
export interface S3StoredSettings {
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: EncryptedPayload;
}

export interface StorageConfig {
  providerType: StorageType;
  s3?: S3StoredSettings;
  updatedBy?: string;
  updatedAt?: string;
}

/** Entrada del admin (secret en CLARO; se cifra antes de persistir). */
export type StorageConfigInput =
  | { providerType: 'local' }
  | {
      providerType: 's3';
      s3: {
        endpoint?: string;
        bucket: string;
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
      };
    };

/** Vista pública (SIN secretos) — lo que devuelve el GET del admin y consume el wizard. */
export interface PublicStorageConfig {
  providerType: StorageType;
  s3?: {
    endpoint?: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretConfigured: boolean;
  };
  updatedBy?: string;
  updatedAt?: string;
}

const KEY = 'storage';
const DEFAULT: StorageConfig = { providerType: 'local' };

/**
 * Config INTERNA actual (con el secret cifrado). Sólo la usan el provider y la vista pública;
 * NUNCA se devuelve cruda por la API. Si nunca se configuró → `local` (adjuntos nunca se bloquean).
 */
export async function getStorageConfig(): Promise<StorageConfig> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean();
  return (doc?.value as StorageConfig | undefined) ?? DEFAULT;
}

/** Quita el secret de la config → forma segura para responder al cliente. */
export function toPublicStorageConfig(cfg: StorageConfig): PublicStorageConfig {
  const base: PublicStorageConfig = {
    providerType: cfg.providerType,
    updatedBy: cfg.updatedBy,
    updatedAt: cfg.updatedAt,
  };
  if (cfg.s3) {
    base.s3 = {
      endpoint: cfg.s3.endpoint,
      bucket: cfg.s3.bucket,
      region: cfg.s3.region,
      accessKeyId: cfg.s3.accessKeyId,
      secretConfigured: true,
    };
  }
  return base;
}

/** Vista pública (sin secretos) — lo que devuelve el GET del admin. */
export async function getStorageConfigPublic(): Promise<PublicStorageConfig> {
  return toPublicStorageConfig(await getStorageConfig());
}

/**
 * Persiste la config del admin. Para `s3` cifra la `secretAccessKey` antes de guardar y
 * devuelve la VISTA PÚBLICA (sin secret). El secret en claro nunca sale de esta función.
 *
 * PROVIDER-BOUND: al volver a `local` se PRESERVA la config s3 existente (sólo cambia el
 * provider ACTIVO para escrituras nuevas). Si no, los AttachmentBlob con providerType='s3'
 * quedarían ilegibles — viola §6.bis-C (cambiar el activo no rompe blobs viejos).
 */
export async function setStorageConfig(
  input: StorageConfigInput,
  updatedBy: string
): Promise<PublicStorageConfig> {
  const meta = { updatedBy, updatedAt: new Date().toISOString() };
  let value: StorageConfig;
  if (input.providerType === 's3') {
    value = {
      providerType: 's3',
      s3: {
        endpoint: input.s3.endpoint,
        bucket: input.s3.bucket,
        region: input.s3.region,
        accessKeyId: input.s3.accessKeyId,
        secretAccessKey: encrypt(input.s3.secretAccessKey),
      },
      ...meta,
    };
  } else {
    // local activo, pero conservamos la config s3 ya guardada (para leer blobs s3 históricos).
    const existing = await getStorageConfig();
    value = { providerType: 'local', ...(existing.s3 ? { s3: existing.s3 } : {}), ...meta };
  }
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return toPublicStorageConfig(value);
}
