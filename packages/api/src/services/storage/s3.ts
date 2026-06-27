import { AwsClient } from 'aws4fetch';
import type { StorageProvider } from './types.js';

/** Timeout por operación S3 (sin esto aws4fetch puede colgar indefinidamente ante un host lento). */
const S3_TIMEOUT_MS = 20_000;
/** Tope defensivo de lectura: los adjuntos se acotan a 25MB al escribir; margen para overhead. */
const S3_MAX_GET_BYTES = 30 * 1024 * 1024;
/** IPs de metadata de cloud (IMDS) — destino clásico de SSRF; nunca un endpoint S3 legítimo. */
const METADATA_HOSTS = new Set(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal']);

/**
 * Valida la ESTRUCTURA del endpoint S3 (admin-controlled). No bloquea hosts internos/localhost
 * a propósito: el caso de uso self-hosted usa MinIO interno. Lo que sí cierra: esquemas no
 * http(s), userinfo, query/fragment/path (evita el hijack por concatenación que cambia el
 * destino real), y la IP de metadata de cloud (SSRF clásico).
 */
export function isSafeS3Endpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  if (u.search || u.hash) return false;
  if (u.pathname !== '/' && u.pathname !== '') return false;
  if (METADATA_HOSTS.has(u.hostname)) return false;
  return true;
}

export interface S3Options {
  /** Endpoint del servicio (MinIO/R2/etc.). Si se omite, se usa AWS S3 estándar de la región. */
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  /** Secret en CLARO (ya descifrado por el caller). Nunca se loguea. */
  secretAccessKey: string;
}

/**
 * Provider de storage sobre S3 (o compatible: MinIO, Cloudflare R2, …). Usa `aws4fetch` para
 * firmar con SigV4 sobre `fetch` (mucho más liviano que el SDK de AWS). Path-style
 * (`endpoint/bucket/key`): el más portable entre implementaciones S3-compatible.
 *
 * NOTA: la integración real contra un bucket no se puede verificar en CI (no hay S3). Los tests
 * mockean `fetch` y verifican método/URL/cuerpo; la validación contra un bucket real es
 * responsabilidad del operador (ver deploy/example-mailserver).
 */
export class S3Storage implements StorageProvider {
  readonly type = 's3' as const;
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(opts: S3Options) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
      service: 's3',
      // aws4fetch reintenta 10× con backoff ante 5xx por defecto (~25s). Un upload/lectura no
      // debe colgar tanto: lo acotamos a 2 reintentos.
      retries: 2,
    });
    const root = (opts.endpoint ?? `https://s3.${opts.region}.amazonaws.com`).replace(/\/+$/, '');
    this.base = `${root}/${encodeURIComponent(opts.bucket)}`;
  }

  /** URL del objeto. La key es opaca (uuid server-side); se codifica por seguridad. */
  private url(key: string): string {
    return `${this.base}/${encodeURIComponent(key)}`;
  }

  async put(key: string, body: Buffer): Promise<void> {
    // Buffer es Uint8Array<ArrayBufferLike>; BodyInit espera Uint8Array<ArrayBuffer>. Copiamos
    // a un ArrayBuffer fresco para satisfacer el tipo (y evitar SharedArrayBuffer).
    const body8 = new Uint8Array(body);
    const res = await this.client.fetch(this.url(key), {
      method: 'PUT',
      body: body8,
      headers: { 'content-length': String(body.length) },
      signal: AbortSignal.timeout(S3_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`S3 put failed: ${String(res.status)}`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.fetch(this.url(key), {
      method: 'GET',
      signal: AbortSignal.timeout(S3_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`S3 get failed: ${String(res.status)}`);
    }
    // Tope defensivo: un endpoint comprometido podría devolver un cuerpo enorme y presionar RAM.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > S3_MAX_GET_BYTES) {
      throw new Error('S3 get: objeto excede el tamaño máximo');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > S3_MAX_GET_BYTES) {
      throw new Error('S3 get: objeto excede el tamaño máximo');
    }
    return buf;
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: 'DELETE',
      signal: AbortSignal.timeout(S3_TIMEOUT_MS),
    });
    // S3 devuelve 204 al borrar; 404 es idempotente (ya no está) → no es error.
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 delete failed: ${String(res.status)}`);
    }
  }
}
