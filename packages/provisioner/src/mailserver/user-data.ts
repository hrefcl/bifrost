/**
 * Generador del cloud-init (user-data) que corre al primer boot del EC2 — el corazón de "todo
 * funciona solo": instala Docker, baja el stack all-in-one (REUSA `deploy/example-mailserver/`),
 * lo parametriza con el dominio, GENERA los secretos EN EL BOX (no en el user-data, que es visible
 * por `DescribeInstanceAttribute`) y levanta todo con `docker compose up -d`.
 *
 * Seguridad: el user-data NO embebe secretos. Las credenciales de la app se generan en el host con
 * `openssl`. Para S3 NO se ponen access keys: se asume un **IAM instance profile** con acceso al
 * bucket (se crea en una fase de IAM); acá sólo se setean bucket/region. PURO → testeable.
 */
export interface UserDataInput {
  domain: string;
  mailHostname: string;
  /** Email de admin para Let's Encrypt (TLS). */
  adminEmail: string;
  /** Repo a clonar (parametrizable para forks). */
  repoUrl?: string;
  useS3: boolean;
  s3Bucket?: string;
  s3Region?: string;
}

/** Escapa comillas dobles para interpolar de forma segura dentro de `"..."` en bash. */
function sh(value: string): string {
  return value.replace(/["\\$`]/g, '\\$&');
}

export function buildUserData(input: UserDataInput): string {
  const repo = input.repoUrl ?? 'https://github.com/hrefcl/bifrost.git';
  const s3Block = input.useS3
    ? `
# --- Storage S3 (credenciales por IAM instance role, NO por claves en disco) ---
cat >> .env <<ENV
STORAGE_PROVIDER=s3
S3_BUCKET="${sh(input.s3Bucket ?? '')}"
S3_REGION="${sh(input.s3Region ?? '')}"
ENV`
    : `
# --- Storage local (en el EBS de la instancia) ---
echo "STORAGE_PROVIDER=local" >> .env`;

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
${s3Block}

# 5) Levantar el stack (Traefik+TLS, docker-mailserver, Mongo+Redis, Bifrost API/Web)
docker compose up -d

# 6) Marca de finalización para diagnóstico
echo "bifrost-provision: stack levantado para \${DOMAIN}" > /var/log/bifrost-provision.log
`;
}
