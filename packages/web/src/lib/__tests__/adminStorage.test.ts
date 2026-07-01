import { describe, it, expect } from 'vitest';
import { s3FormFromConfig, s3Incomplete } from '../adminStorage';

describe('adminStorage — s3FormFromConfig (regresión del crash #34)', () => {
  it('S3 con rol de instancia (SIN accessKeyId) → accessKeyId "" y useInstanceRole true, sin undefined', () => {
    // Shape REAL que devuelve un box turnkey (S3 + rol EC2): no trae accessKeyId.
    const raw = {
      endpoint: null,
      bucket: 'bifrost-aulion-app-data',
      region: 'us-east-1',
      useInstanceRole: true,
      secretConfigured: false,
    };
    const form = s3FormFromConfig(raw);
    expect(form.accessKeyId).toBe(''); // el guard que evita el `.trim()` sobre undefined
    expect(form.useInstanceRole).toBe(true);
    expect(form.bucket).toBe('bifrost-aulion-app-data');
    expect(form.endpoint).toBe(''); // endpoint null → ''
  });

  it('S3 manual (con claves) → mapea los campos tal cual', () => {
    const form = s3FormFromConfig({
      endpoint: 'https://s3.amazonaws.com',
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'AKIA...',
      secretConfigured: true,
    });
    expect(form.accessKeyId).toBe('AKIA...');
    expect(form.useInstanceRole).toBe(false);
  });

  it('sin s3 (storage local) → todo string vacío, nada undefined', () => {
    const form = s3FormFromConfig(undefined);
    expect(form).toEqual({
      endpoint: '',
      bucket: '',
      region: '',
      accessKeyId: '',
      useInstanceRole: false,
    });
  });
});

describe('adminStorage — s3Incomplete', () => {
  it('rol de instancia → NO exige claves (no crashea, no bloquea)', () => {
    const form = s3FormFromConfig({ bucket: 'b', region: 'us-east-1', useInstanceRole: true });
    // El caso exacto del crash: accessKeyId '' + useInstanceRole → debe cortar antes de cualquier trim de claves.
    expect(s3Incomplete({ ...form, secretAccessKey: '' })).toBe(false);
  });

  it('S3 manual sin claves → incompleto', () => {
    const form = s3FormFromConfig({ bucket: 'b', region: 'us-east-1' });
    expect(s3Incomplete({ ...form, secretAccessKey: '' })).toBe(true);
  });

  it('S3 manual completo → completo', () => {
    const form = s3FormFromConfig({ bucket: 'b', region: 'us-east-1', accessKeyId: 'AKIA' });
    expect(s3Incomplete({ ...form, secretAccessKey: 'shh' })).toBe(false);
  });
});
