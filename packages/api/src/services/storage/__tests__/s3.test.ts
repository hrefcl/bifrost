import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Storage, isSafeS3Endpoint, verifyS3Connection } from '../s3.js';

const OPTS = {
  endpoint: 'https://minio.test',
  bucket: 'mybucket',
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'super-secret-key',
};

interface Captured {
  url: string;
  method: string;
  auth: string | null;
}

function stubFetch(status: number, body?: Uint8Array): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: Request) => {
      calls.push({
        url: input.url,
        method: input.method,
        auth: input.headers.get('authorization'),
      });
      return Promise.resolve(new Response(body ?? null, { status }));
    })
  );
  return calls;
}

describe('S3Storage (fetch mockeado — verifica request firmada; no toca S3 real)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('put: PUT firmado SigV4 a endpoint/bucket/key con el cuerpo', async () => {
    const calls = stubFetch(200);
    await new S3Storage(OPTS).put('abc-key', Buffer.from('datos'));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('https://minio.test/mybucket/abc-key');
    expect(calls[0].auth).toContain('AWS4-HMAC-SHA256');
    expect(calls[0].auth).toContain('AKIAEXAMPLE');
  });

  it('useInstanceRole: saca credenciales TEMPORALES del IMDS y firma con session token (sin claves estáticas)', async () => {
    const seen: { url: string; method: string; secToken: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request | string, init?: RequestInit) => {
        // aws4fetch llama con un Request (S3); el fetch del IMDS llama con (urlString, init).
        const url = typeof input === 'string' ? input : input.url;
        const method = typeof input === 'string' ? (init?.method ?? 'GET') : input.method;
        const headers = typeof input === 'string' ? new Headers(init?.headers) : input.headers;
        seen.push({ url, method, secToken: headers.get('x-amz-security-token') });
        if (url.endsWith('/latest/api/token')) return Promise.resolve(new Response('TOKEN123'));
        if (url.endsWith('/iam/security-credentials/'))
          return Promise.resolve(new Response('bifrost-role'));
        if (url.endsWith('/iam/security-credentials/bifrost-role'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                AccessKeyId: 'ASIATEMP',
                SecretAccessKey: 'temp-secret',
                Token: 'SESSIONTOKEN',
                Expiration: new Date(Date.now() + 3600_000).toISOString(),
              })
            )
          );
        return Promise.resolve(new Response(null, { status: 200 })); // el PUT a S3
      })
    );
    await new S3Storage({
      endpoint: 'https://minio.test',
      bucket: 'mybucket',
      region: 'us-east-1',
      useInstanceRole: true,
    }).put('k', Buffer.from('x'));

    // Pegó al IMDS (token + rol + creds) antes del S3, y el PUT a S3 lleva el session token temporal.
    expect(seen.some((c) => c.url.includes('169.254.169.254/latest/api/token'))).toBe(true);
    const s3Put = seen.find((c) => c.url === 'https://minio.test/mybucket/k');
    expect(s3Put?.method).toBe('PUT');
    expect(s3Put?.secToken).toBe('SESSIONTOKEN');
  });

  it('get: devuelve los bytes del objeto', async () => {
    const payload = new Uint8Array(Buffer.from('contenido remoto'));
    const calls = stubFetch(200, payload);
    const out = await new S3Storage(OPTS).get('k1');
    expect(out).toEqual(Buffer.from('contenido remoto'));
    expect(calls[0].method).toBe('GET');
  });

  it('delete: 204 OK y 404 es idempotente (no lanza)', async () => {
    stubFetch(204);
    await expect(new S3Storage(OPTS).delete('k2')).resolves.toBeUndefined();
    vi.unstubAllGlobals();
    stubFetch(404);
    await expect(new S3Storage(OPTS).delete('gone')).resolves.toBeUndefined();
  });

  it('put: lanza si S3 responde no-2xx', async () => {
    stubFetch(500);
    await expect(new S3Storage(OPTS).put('k', Buffer.from('x'))).rejects.toThrow(/S3 put failed/);
  });

  it('get: corta por STREAMING si el cuerpo excede el tope SIN content-length (chunked)', async () => {
    // Stream sin content-length que emite >30MB → la lectura debe abortar sin materializar todo.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(31 * 1024 * 1024));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })))
    );
    await expect(new S3Storage(OPTS).get('chunked-huge')).rejects.toThrow(/tamaño máximo/);
  });

  it('verifyS3Connection: round-trip put→get→delete OK → resuelve', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request) => {
        if (input.method === 'GET') {
          return Promise.resolve(
            new Response(new Uint8Array(Buffer.from('bifrost-connectivity-probe')), { status: 200 })
          );
        }
        return Promise.resolve(
          new Response(null, { status: input.method === 'DELETE' ? 204 : 200 })
        );
      })
    );
    await expect(verifyS3Connection(OPTS)).resolves.toBeUndefined();
  });

  it('verifyS3Connection: si el put falla (403) → rechaza', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 403 })))
    );
    await expect(verifyS3Connection(OPTS)).rejects.toThrow();
  });

  it('verifyS3Connection: si el DELETE falla (sin permiso de borrado) → rechaza (no se traga)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request) => {
        if (input.method === 'GET') {
          return Promise.resolve(
            new Response(new Uint8Array(Buffer.from('bifrost-connectivity-probe')), { status: 200 })
          );
        }
        if (input.method === 'DELETE') return Promise.resolve(new Response(null, { status: 403 }));
        return Promise.resolve(new Response(null, { status: 200 })); // PUT ok
      })
    );
    await expect(verifyS3Connection(OPTS)).rejects.toThrow(/S3 delete failed/);
  });

  it('isSafeS3Endpoint: bloquea metadata (incl. variantes), esquemas y estructura peligrosa', () => {
    expect(isSafeS3Endpoint('https://s3.amazonaws.com')).toBe(true);
    expect(isSafeS3Endpoint('http://minio:9000')).toBe(true);
    expect(isSafeS3Endpoint('http://169.254.169.254/')).toBe(false);
    expect(isSafeS3Endpoint('http://metadata.google.internal./')).toBe(false); // trailing dot
    expect(isSafeS3Endpoint('http://[fd00:ec2::254]/')).toBe(false); // IPv6 con brackets
    expect(isSafeS3Endpoint('ftp://example.com')).toBe(false);
    expect(isSafeS3Endpoint('https://u:p@example.com')).toBe(false);
    expect(isSafeS3Endpoint('https://example.com/foo')).toBe(false);
    expect(isSafeS3Endpoint('https://example.com?x=1')).toBe(false);
  });

  it('get: rechaza si content-length excede el tope defensivo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('x', { status: 200, headers: { 'content-length': '999999999' } })
        )
      )
    );
    await expect(new S3Storage(OPTS).get('huge')).rejects.toThrow(/tamaño máximo/);
  });

  it('sin endpoint → usa el host AWS estándar de la región', async () => {
    const calls = stubFetch(200);
    const { endpoint: _drop, ...noEndpoint } = OPTS;
    await new S3Storage(noEndpoint).put('k', Buffer.from('x'));
    expect(calls[0].url).toBe('https://s3.us-east-1.amazonaws.com/mybucket/k');
  });
});
