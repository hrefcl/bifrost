import { describe, it, expect } from 'vitest';
import { buildUserData } from '../mailserver/user-data.js';

describe('buildUserData (cloud-init)', () => {
  const base = {
    domain: 'acme.com',
    mailHostname: 'mail.acme.com',
    adminEmail: 'admin@acme.com',
  };

  it('instala docker, clona el stack, parametriza el dominio y levanta compose', () => {
    const s = buildUserData({ ...base, useS3: false });
    expect(s).toContain('get.docker.com');
    expect(s).toContain('git clone');
    expect(s).toContain('deploy/example-mailserver'); // REUSA la plantilla existente
    expect(s).toContain('docker compose up -d');
    expect(s).toContain('acme.com');
    expect(s).toContain('mail.acme.com');
  });

  it('genera los secretos EN EL HOST (no embebidos) y no pone claves AWS', () => {
    const s = buildUserData({ ...base, useS3: true, s3Bucket: 'acme-data', s3Region: 'us-east-1' });
    expect(s).toContain('openssl rand'); // secretos generados en el box
    expect(s).toContain('encryption_key');
    // NUNCA debe haber access keys de AWS embebidas (se usa IAM instance role).
    expect(s).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(s).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('con S3: setea bucket/region; sin S3: storage local', () => {
    const withS3 = buildUserData({
      ...base,
      useS3: true,
      s3Bucket: 'acme-data',
      s3Region: 'eu-west-1',
    });
    expect(withS3).toContain('STORAGE_PROVIDER=s3');
    expect(withS3).toContain('acme-data');
    expect(withS3).toContain('eu-west-1');
    const local = buildUserData({ ...base, useS3: false });
    expect(local).toContain('STORAGE_PROVIDER=local');
  });
});
