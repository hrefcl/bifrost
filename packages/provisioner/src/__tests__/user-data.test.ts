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

  it('sin s3Bucket → storage LOCAL (sin claves ni S3 en el .env)', () => {
    const s = buildUserData(base);
    expect(s).toContain('STORAGE_PROVIDER=local');
    expect(s).not.toContain('STORAGE_PROVIDER=s3');
    expect(s).not.toContain('S3_BUCKET');
  });

  it('con s3Bucket → storage S3 con el ROL del EC2 (IMDS), SIN claves estáticas en el .env', () => {
    const s = buildUserData({ ...base, s3Bucket: 'bifrost-acme-com-data' });
    expect(s).toContain('STORAGE_PROVIDER=s3');
    expect(s).toContain('S3_BUCKET=bifrost-acme-com-data');
    expect(s).toContain('S3_REGION=us-east-1');
    expect(s).toContain('S3_USE_INSTANCE_ROLE=1');
    // Cero claves estáticas (el rol del EC2 las provee temporales vía IMDS).
    expect(s).not.toContain('S3_ACCESS_KEY_ID');
    expect(s).not.toContain('S3_SECRET');
  });

  it('con adminMailbox → crea el buzón admin en docker-mailserver (login turnkey)', () => {
    const s = buildUserData({
      ...base,
      adminMailbox: 'admin@acme.com',
      adminMailboxPassword: 'super-clave-8+',
    });
    expect(s).toContain('setup email add');
    expect(s).toContain('admin@acme.com');
    expect(s).toContain('mailserver setup email list'); // espera a que el mailserver esté listo
  });

  it('sin adminMailbox → no toca docker-mailserver', () => {
    expect(buildUserData(base)).not.toContain('setup email add');
  });

  it('sin sesParamName → NO instala el relay SES (sin helper, sin cron, sin awscli)', () => {
    const s = buildUserData(base);
    expect(s).not.toContain('bifrost-ses-activate');
    expect(s).not.toContain('/etc/cron.d/bifrost-ses');
    expect(s).not.toContain('install -y awscli');
  });

  it('con sesParamName → helper que lee SSM + cron + boot-run, con SEND-GATING (relay off al boot)', () => {
    const s = buildUserData({ ...base, sesParamName: '/bifrost/acme-com/ses-smtp' });
    // awscli para leer el SecureString con el rol del box.
    expect(s).toContain('install -y awscli');
    // El helper lee la credencial de SSM con --with-decryption.
    expect(s).toContain('/usr/local/bin/bifrost-ses-activate');
    expect(s).toContain('aws ssm get-parameter --name "$SES_PARAM" --with-decryption');
    expect(s).toContain('/bifrost/acme-com/ses-smtp');
    // Arma el relay de docker-mailserver hacia el endpoint SMTP de SES.
    expect(s).toContain('RELAY_HOST=email-smtp.');
    expect(s).toContain('RELAY_PORT=587');
    // SEND-GATING: graceful si la credencial no está (relay sigue apagado), no rompe el boot.
    expect(s).toContain('relay apagado');
    // Timer pull-based (auto-activa + sobrevive reboot) y corrida al boot.
    expect(s).toContain('/etc/cron.d/bifrost-ses');
    expect(s).toContain('/usr/local/bin/bifrost-ses-activate || true');
    // El SecretAccessKey de AWS jamás aparece; sólo se maneja el password ya derivado vía SSM.
    expect(s).not.toContain('SecretAccessKey');
  });

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
    // Compat API 1.24 para Traefik v3 con Docker 29+ (si no, Traefik no lee labels → 404). [deploy real]
    expect(s).toContain('DOCKER_MIN_API_VERSION=1.24');
    // RESTART explícito (no 'enable --now') — sin esto el daemon ya corriendo no toma el drop-in y
    // Traefik queda en API 1.40 → 404 en todo. Bug real del 2º deploy.
    expect(s).toContain('systemctl restart docker');
    expect(s).toContain('MinAPIVersion'); // fail-fast si el min no quedó en 1.24
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
    // Rechaza la forma totalmente-calificada refs/... ANTES del clone (clone --branch sólo acepta
    // nombre corto); también señaliza a CFN. [B-MED v2]
    expect(s).toMatch(/case "\$REF" in refs\/\*\)[^\n]*signal_fail; exit 1/);
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
    // Readiness FUNCIONAL: no basta "contenedor Up"; el webmail debe responder 200 por Traefik (si no,
    // un Traefik roto daba falso CREATE_COMPLETE). [hallazgo del primer deploy real]
    expect(s).toContain('/api/health');
    expect(s).toMatch(/code" = "200" \]|"\$\{?code\}?" = "200"/);
    expect(s).toContain('bifrost-acme-com');
    expect(s).toContain('STORAGE_PROVIDER=local');
    expect(s).not.toContain('STORAGE_PROVIDER=s3');
  });

  it('los exit explícitos (readiness, ref) señalizan a CFN — exit NO dispara el trap ERR', () => {
    const s = buildUserData(base);
    // El readiness check (contenedor muerto) hace signal_fail ANTES del exit 1 → CFN falla ya,
    // no por timeout de 15 min del CreationPolicy. [shellcheck re-audit]
    expect(s).toMatch(/docker compose ps >&2\n(?:\s*#[^\n]*\n)+\s*signal_fail\n\s*exit 1/);
  });
});
