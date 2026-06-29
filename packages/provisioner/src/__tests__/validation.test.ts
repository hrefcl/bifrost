import { describe, it, expect } from 'vitest';
import { validateDomain, mailHostname } from '../domain.js';
import { validateBucketName } from '../s3-naming.js';
import {
  recommendInstance,
  ALLINONE_CATALOG,
  archForInstanceType,
} from '../catalog/instance-types.js';

describe('validateDomain', () => {
  it('acepta FQDNs válidos', () => {
    for (const d of ['example.com', 'mail.empresa.io', 'a.b.c.dev', 'EMPRESA.COM']) {
      expect(validateDomain(d), d).toBe(true);
    }
  });
  it('rechaza inválidos', () => {
    for (const d of [
      '',
      'localhost',
      'no_underscore.com',
      '-bad.com',
      'bad-.com',
      'a..b.com',
      'sin-tld',
    ]) {
      expect(validateDomain(d), d).toBe(false);
    }
  });
  it('mailHostname antepone mail. en minúsculas', () => {
    expect(mailHostname('Empresa.COM')).toBe('mail.empresa.com');
  });
});

describe('validateBucketName', () => {
  it('acepta nombres válidos', () => {
    expect(validateBucketName('bifrost-mail-data').valid).toBe(true);
    expect(validateBucketName('my.bucket.123').valid).toBe(true);
  });
  it('rechaza inválidos con motivo', () => {
    expect(validateBucketName('ab').valid).toBe(false); // corto
    expect(validateBucketName('UPPER').valid).toBe(false); // mayúsculas
    expect(validateBucketName('a..b').valid).toBe(false); // puntos consecutivos
    expect(validateBucketName('192.168.0.1').valid).toBe(false); // IP
    expect(validateBucketName('-leading').valid).toBe(false); // empieza con guion
    expect(validateBucketName('xn--punycode').valid).toBe(false); // prefijo reservado
    expect(validateBucketName('thing-s3alias').valid).toBe(false); // sufijo reservado
  });
});

describe('catálogo de instancias', () => {
  it('el recomendado existe en el catálogo y tiene ≥4GB', () => {
    const rec = recommendInstance();
    expect(ALLINONE_CATALOG).toContainEqual(rec);
    expect(rec.memGiB).toBeGreaterThanOrEqual(4);
  });
  it('ningún tipo del catálogo all-in-one baja de 4GB', () => {
    for (const i of ALLINONE_CATALOG) expect(i.memGiB).toBeGreaterThanOrEqual(4);
  });
  it('el catálogo default es Graviton (arm64, más barato)', () => {
    for (const i of ALLINONE_CATALOG) expect(i.arch).toBe('arm64');
    expect(recommendInstance().type).toMatch(/^t4g\./);
  });
  it('archForInstanceType deriva la arch (Graviton lleva sufijo g)', () => {
    expect(archForInstanceType('t4g.large')).toBe('arm64');
    expect(archForInstanceType('m6g.xlarge')).toBe('arm64');
    expect(archForInstanceType('c7gd.medium')).toBe('arm64');
    expect(archForInstanceType('t3.large')).toBe('amd64');
    expect(archForInstanceType('m5.large')).toBe('amd64');
    expect(archForInstanceType('c6i.large')).toBe('amd64');
  });
});
