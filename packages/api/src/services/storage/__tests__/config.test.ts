import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetState } from '../../../../test/integration-helper.js';
import { setStorageConfig, getStorageConfig, getStorageConfigPublic } from '../index.js';
import { decrypt } from '../../../config/crypto.js';
import { SystemConfig } from '../../../models/SystemConfig.js';

const S3_INPUT = {
  providerType: 's3' as const,
  s3: {
    endpoint: 'https://minio.test',
    bucket: 'mybucket',
    region: 'us-east-1',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'super-secret-key',
  },
};

describe('storage config: cifrado del secret S3 (PR-D)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('default sin config → local', async () => {
    expect((await getStorageConfig()).providerType).toBe('local');
    expect((await getStorageConfigPublic()).providerType).toBe('local');
  });

  it('s3: el secret se guarda CIFRADO y descifra al valor original', async () => {
    await setStorageConfig(S3_INPUT, 'admin-1');
    const internal = await getStorageConfig();
    expect(internal.providerType).toBe('s3');
    // El secret persistido es un EncryptedPayload, no el texto plano.
    expect(internal.s3?.secretAccessKey).toHaveProperty('ciphertext');
    expect(internal.s3?.secretAccessKey).toHaveProperty('iv');
    expect(internal.s3?.secretAccessKey).toHaveProperty('tag');
    expect(decrypt(internal.s3!.secretAccessKey)).toBe('super-secret-key');
  });

  it('el secret en claro NO aparece en el documento crudo de Mongo', async () => {
    await setStorageConfig(S3_INPUT, 'admin-1');
    const raw = await SystemConfig.findOne({ key: 'storage' }).lean();
    expect(JSON.stringify(raw)).not.toContain('super-secret-key');
  });

  it('la vista pública OMITE el secret y expone secretConfigured', async () => {
    const pub = await setStorageConfig(S3_INPUT, 'admin-1');
    expect(pub.s3?.secretConfigured).toBe(true);
    expect(pub.s3?.bucket).toBe('mybucket');
    expect(pub.s3?.accessKeyId).toBe('AKIAEXAMPLE');
    // En ningún lugar de la respuesta pública aparece el secret.
    expect(JSON.stringify(pub)).not.toContain('super-secret-key');
    expect(JSON.stringify(await getStorageConfigPublic())).not.toContain('super-secret-key');
  });

  it('volver a local limpia el provider activo (los blobs s3 viejos se siguen leyendo provider-bound)', async () => {
    await setStorageConfig(S3_INPUT, 'admin-1');
    const pub = await setStorageConfig({ providerType: 'local' }, 'admin-1');
    expect(pub.providerType).toBe('local');
    expect(pub.s3).toBeUndefined();
  });
});
