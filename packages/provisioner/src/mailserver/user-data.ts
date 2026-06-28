/**
 * Generador del cloud-init (user-data) que corre al primer boot del EC2 — el corazón de "todo
 * funciona solo": instala Docker, baja el stack all-in-one (REUSA `deploy/example-mailserver/`),
 * lo parametriza con el dominio, GENERA los secretos EN EL BOX (no en el user-data, que es visible
 * por `DescribeInstanceAttribute`) y levanta todo con `docker compose up -d`.
 *
 * Seguridad: el user-data NO embebe secretos (se generan en el host con `openssl`).
 *
 * STORAGE: el box arranca con storage LOCAL (en el EBS) — funciona de verdad out-of-the-box. El S3
 * cifrado (la palanca de bajo costo, decisión A→C del doc §8) NO se auto-configura todavía: hoy
 * `S3Storage` exige claves estáticas y NO soporta IAM instance role, y nada lee env de storage al
 * boot. Cablear S3-turnkey (rol IAM + soporte instance-role en S3Storage + bootstrap por env) es una
 * fase aparte registrada en el doc; hasta entonces NO se promete S3 acá. PURO → testeable.
 */
export interface UserDataInput {
  domain: string;
  mailHostname: string;
  /** Email de admin para Let's Encrypt (TLS). */
  adminEmail: string;
  /** Repo a clonar (parametrizable para forks). */
  repoUrl?: string;
  /** Intención de usar S3 (sólo deja una NOTA; el wiring real es una fase posterior). */
  useS3?: boolean;
}

/** Escapa comillas dobles para interpolar de forma segura dentro de `"..."` en bash. */
function sh(value: string): string {
  return value.replace(/["\\$`]/g, '\\$&');
}

export function buildUserData(input: UserDataInput): string {
  const repo = input.repoUrl ?? 'https://github.com/hrefcl/bifrost.git';
  const storageBlock = `
# --- Storage: LOCAL por defecto (correo/adjuntos en el EBS de la instancia) — funciona ya.
echo "STORAGE_PROVIDER=local" >> .env${
    input.useS3
      ? `
# NOTA: S3 cifrado (bajo costo) se configurará DESPUÉS (admin o fase CLI que crea bucket + rol IAM y
# cablea el storage). Aún NO se auto-configura en el boot — ver docs/cli-provisioning-aws.md.`
      : ''
  }`;

  return `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# 1) Docker + compose plugin
curl -fsSL https://get.docker.com | sh

# 2) Código (reusa el stack all-in-one ya existente en el repo)
install -d -m 0750 /opt/bifrost
git clone --depth 1 "${sh(repo)}" /opt/bifrost
cd /opt/bifrost/deploy/example-mailserver

# 3) Parametrizar dominio / hostname / email de Let's Encrypt
DOMAIN="${sh(input.domain)}"
MAIL_HOST="${sh(input.mailHostname)}"
ADMIN_EMAIL="${sh(input.adminEmail)}"
sed -i "s/mail\\.example\\.com/\${MAIL_HOST}/g; s/example\\.com/\${DOMAIN}/g; s/admin@\${DOMAIN}/\${ADMIN_EMAIL}/g" docker-compose.yml

# 4) Secretos GENERADOS EN EL HOST (no viajan en el user-data)
install -d -m 0700 secrets
openssl rand -hex 32  > secrets/jwt_secret
openssl rand -hex 64  > secrets/encryption_key   # 64 hex = 32 bytes para AES-256
openssl rand -hex 24  > secrets/mongo_password
openssl rand -hex 24  > secrets/redis_password
touch .env
${storageBlock}

# 5) Levantar el stack (Traefik+TLS, docker-mailserver, Mongo+Redis, Bifrost API/Web)
docker compose up -d

# 6) Marca de finalización para diagnóstico
echo "bifrost-provision: stack levantado para \${DOMAIN}" > /var/log/bifrost-provision.log
`;
}
