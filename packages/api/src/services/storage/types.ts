import { randomUUID } from 'node:crypto';

/** Tipos de backend de storage soportados (el wizard del admin elige uno). */
export type StorageType = 'local' | 's3';

/**
 * Abstracción de storage de blobs (adjuntos). El resto del código no sabe qué backend hay
 * detrás. Cada `AttachmentBlob` guarda su `providerType` → las lecturas van SIEMPRE a su
 * provider de origen (cambiar el provider activo afecta sólo escrituras nuevas, no rompe
 * blobs viejos — ver docs/admin-config-y-providers.md §6.bis-C).
 */
export interface StorageProvider {
  readonly type: StorageType;
  /** Guarda los bytes bajo `key` (key OPACA generada server-side, nunca input del cliente). */
  put(key: string, body: Buffer): Promise<void>;
  /** Devuelve los bytes de `key`. Lanza si no existe. */
  get(key: string): Promise<Buffer>;
  /** Borra `key` (idempotente: no falla si ya no está). */
  delete(key: string): Promise<void>;
}

/**
 * Genera una storageKey aleatoria DEL LADO DEL SERVIDOR (uuid). Nunca se deriva de input del
 * cliente → no hay path traversal ni colisión predecible.
 */
export function newStorageKey(): string {
  return randomUUID();
}
