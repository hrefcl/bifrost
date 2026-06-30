import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { emptyBucket } from '../aws/s3.js';

describe('emptyBucket (vaciado previo al delete-stack)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('borra versiones + delete-markers en lote y drena el bucket (versionado)', async () => {
    const deletedBatchSizes: number[] = [];
    let listCall = 0;
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((cmd: unknown): Promise<unknown> => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === 'ListObjectVersionsCommand') {
        listCall++;
        // 1ª llamada: hay objetos; 2ª: vacío → corta el loop.
        return Promise.resolve(
          listCall === 1
            ? {
                Versions: [
                  { Key: 'a', VersionId: 'v1' },
                  { Key: 'b', VersionId: 'v2' },
                ],
                DeleteMarkers: [{ Key: 'a', VersionId: 'd1' }],
              }
            : { Versions: [], DeleteMarkers: [] }
        );
      }
      if (name === 'DeleteObjectsCommand') {
        const objs = (cmd as { input: { Delete: { Objects: unknown[] } } }).input.Delete.Objects;
        deletedBatchSizes.push(objs.length);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const n = await emptyBucket('us-east-1', 'mybucket');
    expect(n).toBe(3); // 2 versiones + 1 delete-marker
    expect(deletedBatchSizes).toEqual([3]); // un único lote
    expect(listCall).toBe(2); // re-listó hasta vaciar
  });

  it('bucket ya vacío → 0 borrados, sin DeleteObjects', async () => {
    const sends: string[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((cmd: unknown): Promise<unknown> => {
      sends.push((cmd as { constructor: { name: string } }).constructor.name);
      return Promise.resolve({ Versions: [], DeleteMarkers: [] });
    });
    const n = await emptyBucket('us-east-1', 'empty');
    expect(n).toBe(0);
    expect(sends).not.toContain('DeleteObjectsCommand');
  });
});
