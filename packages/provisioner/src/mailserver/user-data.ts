/**
 * Generador del cloud-init (user-data) que corre al primer boot del EC2 — el corazón de "todo
 * funciona solo": instala Docker (repo APT FIRMADO de Docker, no `curl|sh`), baja el stack all-in-one
 * (REUSA `deploy/example-mailserver/`), lo parametriza con el dominio, GENERA los secretos EN EL BOX
 * con los NOMBRES EXACTOS que espera el compose (`secrets/*.txt`) y levanta todo. Al final SEÑALIZA a
 * CloudFormation (cfn-signal) éxito/fracaso → la instancia tiene CreationPolicy, así CREATE_COMPLETE
 * sólo ocurre si el stack realmente levantó (no un falso éxito).
 *
 * Seguridad: el user-data NO embebe secretos (se generan en el host con `openssl`). Docker se instala
 * desde el repo APT firmado por Docker (GPG verificado), no por `curl … | sh` sin checksum.
 *
 * STORAGE: arranca LOCAL (en el EBS) — funciona out-of-the-box. El S3 cifrado aún NO se auto-cablea
 * a la app (S3Storage exige instance-role + bootstrap por env: fase aparte registrada en el doc).
 */
export interface UserDataInput {
  domain: string;
  mailHostname: string;
  /** Email de admin para Let's Encrypt (TLS). */
  adminEmail: string;
  /** Repo a clonar (parametrizable para forks). */
  repoUrl?: string;
  /**
   * Ref de git a clonar (branch o tag). Default `main`. Un turnkey debería fijar el ÚLTIMO RELEASE
   * conocido-bueno (no `main` HEAD) cuando el sistema de versionado los publique → así una provisión
   * nueva nunca hereda un `main` roto. Cierra TD-PROVISION-CLONE-PIN.
   */
  ref?: string;
  /** Nombre del stack CloudFormation (para cfn-signal). */
  stackName: string;
  /** Región AWS (para cfn-signal). */
  region: string;
}

/** Escapa caracteres peligrosos para interpolar de forma segura dentro de `"..."` en bash. */
function sh(value: string): string {
  return value.replace(/["\\$`]/g, '\\$&');
}

export function buildUserData(input: UserDataInput): string {
  const repo = input.repoUrl ?? 'https://github.com/hrefcl/bifrost.git';
  const ref = input.ref ?? 'main';
  return `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

STACK="${sh(input.stackName)}"
REGION="${sh(input.region)}"

# cfn-signal: instalado abajo; trap señaliza FRACASO a CloudFormation ante cualquier error (set -e),
# así un fallo del bootstrap NO termina en un falso CREATE_COMPLETE.
signal_fail() { cfn-signal -e 1 --stack "$STACK" --resource Instance --region "$REGION" || true; }
trap signal_fail ERR

# 0) ESPERAR salida a internet (la ruta al IGW de una VPC nueva puede tardar unos segundos).
for i in $(seq 1 30); do curl -fsS --max-time 5 https://aws.amazon.com >/dev/null 2>&1 && break || sleep 5; done

# 1) Dependencias base (una AMI mínima NO trae git/openssl/gnupg garantizados).
apt_retry() { for i in $(seq 1 5); do apt-get "$@" && return 0 || sleep 10; done; return 1; }
apt_retry update
apt_retry install -y ca-certificates curl gnupg git openssl python3-pip

# 2) cfn-signal (aws-cfn-bootstrap oficial de AWS) para el CreationPolicy.
pip3 install --break-system-packages https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.tar.gz \
  || pip3 install https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.tar.gz

# 3) Docker desde el repo APT FIRMADO de Docker (GPG verificado; NO curl|sh sin checksum).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt_retry update
apt_retry install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
# Esperar a que el daemon esté listo antes de usarlo (race de arranque del servicio).
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break || sleep 2; done

# 4) Código (reusa el stack all-in-one ya existente en el repo).
install -d -m 0750 /opt/bifrost
# REF = branch o tag de release (NO un SHA suelto: --branch sólo resuelve nombres de ref). Validar el
# FORMATO antes de clonar da un fallo claro (vs un error críptico de git) → el trap ERR lo señaliza.
REF="${sh(ref)}"
git check-ref-format --allow-onelevel "$REF" || { echo "ERROR: ref de git inválido: $REF" >&2; exit 1; }
# --branch fija el ref (release conocido-bueno o branch); --depth 1 = clon superficial.
git clone --depth 1 --branch "$REF" "${sh(repo)}" /opt/bifrost
cd /opt/bifrost/deploy/example-mailserver

# 5) Parametrizar dominio / hostname / email de Let's Encrypt. El sed convierte también
# webmail.example.com → webmail.<dominio> (lo usa Traefik/Bifrost para el front + TLS).
DOMAIN="${sh(input.domain)}"
MAIL_HOST="${sh(input.mailHostname)}"
ADMIN_EMAIL="${sh(input.adminEmail)}"
sed -i "s/mail\\.example\\.com/\${MAIL_HOST}/g; s/example\\.com/\${DOMAIN}/g; s/admin@\${DOMAIN}/\${ADMIN_EMAIL}/g" docker-compose.yml

# 6) Secretos con los NOMBRES EXACTOS que referencia el compose (./secrets/*.txt). Generados en el
# host (no viajan en el user-data). El compose sólo usa jwt_secret y encryption_key.
install -d -m 0700 secrets
openssl rand -hex 32 > secrets/jwt_secret.txt
openssl rand -hex 32 > secrets/encryption_key.txt   # 32 bytes = 64 chars hex (lo que exige la API)
echo "STORAGE_PROVIDER=local" > .env   # S3 aún no cableado a la app (ver doc)

# 7) Levantar el stack (Traefik+TLS, docker-mailserver, Mongo+Redis, Bifrost API/Web).
docker compose pull
docker compose up -d

# Readiness mínima: dar unos segundos y verificar que NINGÚN contenedor murió al arrancar (atrapa
# crashes inmediatos como un secreto inválido). Si alguno salió, el trap señaliza FRACASO a CFN.
sleep 20
if docker compose ps --status=exited --quiet | grep -q .; then
  echo "ERROR: un contenedor salió al arrancar:" >&2
  docker compose ps >&2
  exit 1
fi

echo "bifrost-provision: stack levantado para $DOMAIN" > /var/log/bifrost-provision.log

# 8) ÉXITO → señalizar a CloudFormation (sin esto, CreationPolicy expira y el stack falla).
cfn-signal -e 0 --stack "$STACK" --resource Instance --region "$REGION"
`;
}
