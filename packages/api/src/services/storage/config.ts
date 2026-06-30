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
  /** EC2: usar el rol de la instancia (IMDS) en vez de claves estáticas. Si true, no hay keys. */
  useInstanceRole?: boolean;
  accessKeyId?: string;
  secretAccessKey?: EncryptedPayload;
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
        useInstanceRole?: boolean;
        accessKeyId?: string;
        secretAccessKey?: string;
      };
    };

/** Vista pública (SIN secretos) — lo que devuelve el GET del admin y consume el wizard. */
export interface PublicStorageConfig {
  providerType: StorageType;
  s3?: {
    endpoint?: string;
    bucket: string;
    region: string;
    useInstanceRole: boolean;
    accessKeyId?: string;
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
      useInstanceRole: cfg.s3.useInstanceRole ?? false,
      accessKeyId: cfg.s3.accessKeyId,
      secretConfigured: cfg.s3.secretAccessKey !== undefined,
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
    // Dos modos: rol del EC2 (sin claves) o claves estáticas (cifra el secret). El admin/seed elige.
    const s3: S3StoredSettings = input.s3.useInstanceRole
      ? {
          endpoint: input.s3.endpoint,
          bucket: input.s3.bucket,
          region: input.s3.region,
          useInstanceRole: true,
        }
      : {
          endpoint: input.s3.endpoint,
          bucket: input.s3.bucket,
          region: input.s3.region,
          accessKeyId: input.s3.accessKeyId,
          ...(input.s3.secretAccessKey
            ? { secretAccessKey: encrypt(input.s3.secretAccessKey) }
            : {}),
        };
    value = { providerType: 's3', s3, ...meta };
  } else {
    // local activo, pero conservamos la config s3 ya guardada (para leer blobs s3 históricos).
    const existing = await getStorageConfig();
    value = { providerType: 'local', ...(existing.s3 ? { s3: existing.s3 } : {}), ...meta };
  }
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return toPublicStorageConfig(value);
}

/**
 * Siembra la config de storage desde el ENTORNO en el PRIMER boot (turnkey: el provisioner AWS inyecta
 * las claves del IAM user del bucket). Sólo actúa si NO hay config persistida (una instalación nueva) y
 * los env de S3 están completos → así el admin puede sobrescribirla después sin que el boot la pise.
 * NO testea la conexión (no debe bloquear el arranque); si las claves estuvieran mal, el admin lo ve al
 * subir un adjunto y lo corrige en el wizard. Devuelve true si sembró.
 */
export async function seedStorageConfigFromEnv(): Promise<boolean> {
  if (process.env.STORAGE_PROVIDER !== 's3') return false;
  const bucket = process.env.S3_BUCKET?.trim();
  const region = process.env.S3_REGION?.trim();
  if (!bucket || !region) return false;

  // No pisar una config existente (el admin manda). Y NUNCA sembrar sobre un install que ya tiene
  // adjuntos LOCALES: mover sólo los nuevos a S3 dejaría los viejos en disco (split-brain, HIGH de B).
  const existing = await SystemConfig.findOne({ key: KEY }).lean();
  if (existing) return false;
  const { AttachmentBlob } = await import('../../models/AttachmentBlob.js');
  if ((await AttachmentBlob.estimatedDocumentCount()) > 0) return false; // no es un install fresco

  const useInstanceRole = process.env.S3_USE_INSTANCE_ROLE === '1';
  const endpoint = process.env.S3_ENDPOINT?.trim();
  if (useInstanceRole) {
    await setStorageConfig(
      {
        providerType: 's3',
        s3: { bucket, region, useInstanceRole: true, ...(endpoint ? { endpoint } : {}) },
      },
      'system:env-seed'
    );
    return true;
  }
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return false;
  await setStorageConfig(
    {
      providerType: 's3',
      s3: { bucket, region, accessKeyId, secretAccessKey, ...(endpoint ? { endpoint } : {}) },
    },
    'system:env-seed'
  );
  return true;
}
