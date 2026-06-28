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
    // Espera a internet ANTES de bajar paquetes (race de la ruta de una VPC nueva).
    expect(s).toContain('aws.amazon.com');
    expect(s).toContain('seq 1 30');
    expect(s).toContain('get.docker.com');
    expect(s).toContain('git clone');
    expect(s).toContain('deploy/example-mailserver'); // REUSA la plantilla existente
    expect(s).toContain('docker compose up -d');
    expect(s).toContain('acme.com');
    expect(s).toContain('mail.acme.com');
  });

  it('genera los secretos EN EL HOST (no embebidos) y no pone claves AWS', () => {
    const s = buildUserData({ ...base, useS3: true });
    expect(s).toContain('openssl rand'); // secretos generados en el box
    expect(s).toContain('encryption_key');
    // NUNCA debe haber access keys de AWS embebidas.
    expect(s).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(s).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('storage SIEMPRE local (funciona ya); S3 NO se auto-configura en el boot (honesto)', () => {
    const withS3 = buildUserData({ ...base, useS3: true });
    expect(withS3).toContain('STORAGE_PROVIDER=local'); // arranca funcional en EBS
    expect(withS3).not.toContain('STORAGE_PROVIDER=s3'); // S3 NO se cablea en el boot
    expect(withS3.toLowerCase()).toContain('s3'); // sólo deja la nota de fase posterior
    const local = buildUserData({ ...base, useS3: false });
    expect(local).toContain('STORAGE_PROVIDER=local');
  });
});
