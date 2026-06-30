import { randomUUID } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import type { StorageProvider } from './types.js';

/** Timeout por operación S3 (sin esto aws4fetch puede colgar indefinidamente ante un host lento). */
const S3_TIMEOUT_MS = 20_000;
/** Tope defensivo de lectura: los adjuntos se acotan a 25MB al escribir; margen para overhead. */
const S3_MAX_GET_BYTES = 30 * 1024 * 1024;
/** IPs de metadata de cloud (IMDS) — destino clásico de SSRF; nunca un endpoint S3 legítimo. */
const METADATA_HOSTS = new Set(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal']);

/** Normaliza el hostname para comparar: minúsculas, sin trailing dot ni brackets IPv6. */
function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

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
  if (METADATA_HOSTS.has(normalizeHost(u.hostname))) return false;
  return true;
}

export interface S3Options {
  /** Endpoint del servicio (MinIO/R2/etc.). Si se omite, se usa AWS S3 estándar de la región. */
  endpoint?: string;
  bucket: string;
  region: string;
  /** Claves estáticas (S3 no-AWS: MinIO/R2, o si el admin las configura). Omitir con useInstanceRole. */
  accessKeyId?: string;
  /** Secret en CLARO (ya descifrado por el caller). Nunca se loguea. */
  secretAccessKey?: string;
  /** EC2: sacar credenciales TEMPORALES del rol de la instancia (IMDSv2). Sin secretos estáticos. */
  useInstanceRole?: boolean;
}

interface ImdsCreds {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
  Expiration: string;
}

const IMDS = 'http://169.254.169.254';
const IMDS_TIMEOUT_MS = 2000;

/**
 * Credenciales temporales del rol del EC2 vía IMDSv2 (best-practice AWS: nada de claves estáticas en
 * disco/env/git; rotan solas vía STS). El destino 169.254.169.254 está HARDCODEADO acá (jamás viene de
 * input del usuario — el endpoint S3 admin-controlled lo bloquea isSafeS3Endpoint).
 */
async function fetchImdsCreds(): Promise<ImdsCreds> {
  const tokenRes = await fetch(`${IMDS}/latest/api/token`, {
    method: 'PUT',
    headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' },
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
  });
  if (!tokenRes.ok) throw new Error('IMDS token no disponible (¿el box tiene rol IAM?)');
  const token = await tokenRes.text();
  const h = { 'x-aws-ec2-metadata-token': token };
  const roleRes = await fetch(`${IMDS}/latest/meta-data/iam/security-credentials/`, {
    headers: h,
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
  });
  if (!roleRes.ok) throw new Error('IMDS: sin rol IAM asociado a la instancia');
  const role = (await roleRes.text()).trim().split('\n')[0];
  const credRes = await fetch(`${IMDS}/latest/meta-data/iam/security-credentials/${role}`, {
    headers: h,
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
  });
  if (!credRes.ok) throw new Error('IMDS: no se pudieron leer las credenciales del rol');
  return (await credRes.json()) as ImdsCreds;
}

/**
 * Provider de storage sobre S3 (o compatible: MinIO, Cloudflare R2, …). Usa `aws4fetch` para
 * firmar con SigV4 sobre `fetch` (mucho más liviano que el SDK de AWS). Path-style
 * (`endpoint/bucket/key`): el más portable entre implementaciones S3-compatible.
 *
 * Credenciales: estáticas (accessKeyId/secret, p.ej. MinIO/R2) o, en EC2, TEMPORALES del rol de la
 * instancia (useInstanceRole → IMDSv2, con cache+refresh antes de expirar). El rol es el camino
 * recomendado en AWS (sin secretos estáticos) — review B/D.
 *
 * NOTA: la integración real contra un bucket no se puede verificar en CI (no hay S3). Los tests
 * mockean `fetch` y verifican método/URL/cuerpo; la validación contra un bucket real es
 * responsabilidad del operador (ver deploy/example-mailserver).
 */
export class S3Storage implements StorageProvider {
  readonly type = 's3' as const;
  private readonly opts: S3Options;
  private readonly base: string;
  private cachedClient?: AwsClient;
  private credsExpireAt = Infinity; // estáticas: nunca expiran. IMDS: epoch ms de Expiration.

  constructor(opts: S3Options) {
    this.opts = opts;
    const root = (opts.endpoint ?? `https://s3.${opts.region}.amazonaws.com`).replace(/\/+$/, '');
    this.base = `${root}/${encodeURIComponent(opts.bucket)}`;
    if (!opts.useInstanceRole) {
      // Estáticas: cliente único, sin refresh.
      this.cachedClient = new AwsClient({
        accessKeyId: opts.accessKeyId ?? '',
        secretAccessKey: opts.secretAccessKey ?? '',
        region: opts.region,
        service: 's3',
        retries: 2,
      });
    }
  }

  /** Cliente firmador con credenciales vigentes. Con rol del EC2, refresca vía IMDS antes de expirar. */
  private async client(): Promise<AwsClient> {
    // Refrescar si es rol del EC2 y falta el cliente o las temp-creds vencen en <60s.
    if (
      this.opts.useInstanceRole &&
      (!this.cachedClient || Date.now() > this.credsExpireAt - 60_000)
    ) {
      const c = await fetchImdsCreds();
      this.cachedClient = new AwsClient({
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.Token,
        region: this.opts.region,
        service: 's3',
        retries: 2,
      });
      this.credsExpireAt = new Date(c.Expiration).getTime();
    }
    if (!this.cachedClient) throw new Error('S3 sin credenciales (ni estáticas ni rol del EC2)');
    return this.cachedClient;
  }

  /** URL del objeto. La key es opaca (uuid server-side); se codifica por seguridad. */
  private url(key: string): string {
    return `${this.base}/${encodeURIComponent(key)}`;
  }

  async put(key: string, body: Buffer): Promise<void> {
    // Buffer es Uint8Array<ArrayBufferLike>; BodyInit espera Uint8Array<ArrayBuffer>. Copiamos
    // a un ArrayBuffer fresco para satisfacer el tipo (y evitar SharedArrayBuffer).
    const body8 = new Uint8Array(body);
    const res = await (
      await this.client()
    ).fetch(this.url(key), {
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
    const res = await (
      await this.client()
    ).fetch(this.url(key), {
      method: 'GET',
      signal: AbortSignal.timeout(S3_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`S3 get failed: ${String(res.status)}`);
    }
    // Tope defensivo: un endpoint comprometido podría devolver un cuerpo enorme y presionar RAM.
    // Precheck por content-length, pero NO confiamos en él (puede faltar/mentir): leemos por
    // streaming y abortamos en cuanto se excede, sin materializar el cuerpo completo.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > S3_MAX_GET_BYTES) {
      throw new Error('S3 get: objeto excede el tamaño máximo');
    }
    if (!res.body) {
      // Sin stream (respuesta vacía): arrayBuffer es seguro y pequeño.
      return Buffer.from(await res.arrayBuffer());
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > S3_MAX_GET_BYTES) {
        await reader.cancel();
        throw new Error('S3 get: objeto excede el tamaño máximo');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    const res = await (
      await this.client()
    ).fetch(this.url(key), {
      method: 'DELETE',
      signal: AbortSignal.timeout(S3_TIMEOUT_MS),
    });
    // S3 devuelve 204 al borrar; 404 es idempotente (ya no está) → no es error.
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 delete failed: ${String(res.status)}`);
    }
  }
}

/**
 * Verifica que las credenciales/bucket S3 funcionan haciendo un round-trip real (put→get→delete)
 * de un objeto temporal. Sirve para que el admin pruebe la conexión ANTES de activar S3 y no
 * romper los uploads de todos con un typo. Lanza si alguna operación falla. NO persiste config.
 */
export async function verifyS3Connection(opts: S3Options): Promise<void> {
  const s3 = new S3Storage(opts);
  const key = `__bifrost-conntest-${randomUUID()}`;
  const probe = Buffer.from('bifrost-connectivity-probe');
  // (1) WRITE: si el put crea el objeto pero luego falla, igual intentamos limpiar.
  try {
    await s3.put(key, probe);
  } catch (err) {
    await s3.delete(key).catch(() => undefined);
    throw err;
  }
  // (2) READ: verifica lectura + integridad; limpia el objeto temporal si algo falla.
  try {
    const got = await s3.get(key);
    if (!got.equals(probe)) {
      throw new Error('S3 connectivity probe mismatch');
    }
  } catch (err) {
    await s3.delete(key).catch(() => undefined);
    throw err;
  }
  // (3) DELETE: se verifica de verdad (lanza si no se puede borrar → falta permiso de borrado).
  // Si esto falla, el objeto temporal queda (leak inocuo) y el test reporta el problema real.
  await s3.delete(key);
}
