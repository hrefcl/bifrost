import { AwsClient } from 'aws4fetch';
import type { StorageProvider } from './types.js';

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
    });
    if (!res.ok) {
      throw new Error(`S3 put failed: ${String(res.status)}`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.fetch(this.url(key), { method: 'GET' });
    if (!res.ok) {
      throw new Error(`S3 get failed: ${String(res.status)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' });
    // S3 devuelve 204 al borrar; 404 es idempotente (ya no está) → no es error.
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 delete failed: ${String(res.status)}`);
    }
  }
}
