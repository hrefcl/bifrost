import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Storage } from '../s3.js';

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

  it('sin endpoint → usa el host AWS estándar de la región', async () => {
    const calls = stubFetch(200);
    const { endpoint: _drop, ...noEndpoint } = OPTS;
    await new S3Storage(noEndpoint).put('k', Buffer.from('x'));
    expect(calls[0].url).toBe('https://s3.us-east-1.amazonaws.com/mybucket/k');
  });
});
