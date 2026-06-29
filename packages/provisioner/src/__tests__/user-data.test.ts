import { describe, it, expect } from 'vitest';
import { buildUserData } from '../mailserver/user-data.js';

describe('buildUserData (cloud-init)', () => {
  const base = {
    domain: 'acme.com',
    mailHostname: 'mail.acme.com',
    adminEmail: 'admin@acme.com',
    stackName: 'bifrost-acme-com',
    region: 'us-east-1',
  };

  it('instala deps + docker (repo APT firmado, NO curl|sh), clona el stack y levanta compose', () => {
    const s = buildUserData(base);
    // Espera a internet ANTES de bajar paquetes (race de la ruta de una VPC nueva).
    expect(s).toContain('aws.amazon.com');
    expect(s).toContain('seq 1 30');
    // Instala las herramientas que usa (git/openssl) — no las da por hechas en una AMI mínima.
    expect(s).toContain('install -y ca-certificates curl gnupg git openssl');
    // Docker desde el repo APT FIRMADO (no get.docker.com | sh sin checksum).
    expect(s).toContain('download.docker.com/linux/ubuntu/gpg');
    expect(s).toContain('docker-compose-plugin');
    expect(s).not.toContain('get.docker.com'); // ya no se usa el instalador sin checksum
    expect(s).toContain('git clone');
    expect(s).toContain('deploy/example-mailserver'); // REUSA la plantilla existente
    expect(s).toContain('docker compose up -d');
    expect(s).toContain('mail.acme.com');
  });

  it('clona el ref pedido (release tag) y por defecto main — TD-PROVISION-CLONE-PIN', () => {
    const s = buildUserData(base);
    // Default: main (no behavior change cuando aún no hay releases).
    expect(s).toContain('REF="main"');
    // El clone usa la var validada; fast-fail de formato antes de clonar (mensaje claro vs git críptico).
    expect(s).toContain('git check-ref-format --allow-onelevel "$REF"');
    expect(s).toContain('git clone --depth 1 --branch "$REF"');
    // Un ref inválido debe avisar a CFN YA (signal_fail), no esperar al timeout del CreationPolicy: el
    // `|| { ... }` maneja el error y NO dispara el trap ERR, así que el signal va explícito. [B-MED]
    expect(s).toMatch(/check-ref-format[^\n]*\|\|[^\n]*signal_fail; exit 1/);
    // Override: un release tag conocido-bueno → provisión reproducible, no main HEAD.
    const pinned = buildUserData({ ...base, ref: 'v1.2.0' });
    expect(pinned).toContain('REF="v1.2.0"');
    expect(pinned).not.toContain('REF="main"');
    // El ref se escapa para bash (no inyección por comillas/backtick).
    const evil = buildUserData({ ...base, ref: 'x"; rm -rf /' });
    expect(evil).toContain('\\"'); // la comilla queda escapada dentro de "..."
    expect(evil).not.toContain('REF="x"; rm -rf /"');
  });

  it('genera los secretos con los NOMBRES EXACTOS del compose (.txt) y sin claves AWS', () => {
    const s = buildUserData(base);
    expect(s).toContain('secrets/jwt_secret.txt');
    expect(s).toContain('secrets/encryption_key.txt');
    expect(s).toContain('openssl rand');
    // NUNCA debe haber access keys de AWS embebidas.
    expect(s).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(s).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('señaliza a CloudFormation éxito/fracaso (CreationPolicy) y arranca con storage local', () => {
    const s = buildUserData(base);
    // cfn-signal de éxito (0) y trap de fracaso (1) con el stack/region pasados.
    expect(s).toContain('cfn-signal -e 0 --stack "$STACK" --resource Instance --region "$REGION"');
    expect(s).toContain('cfn-signal -e 1');
    expect(s).toContain('bifrost-acme-com');
    expect(s).toContain('STORAGE_PROVIDER=local');
    expect(s).not.toContain('STORAGE_PROVIDER=s3');
  });
});
