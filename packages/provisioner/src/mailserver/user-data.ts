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
 * STORAGE: si el deploy eligió S3 (input.s3Bucket), el .env cablea storage=s3 autenticado con el ROL
 * del EC2 (IMDS, sin claves estáticas) y el API siembra la config en el primer boot. Si no, LOCAL (EBS).
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
  /** Región AWS (para cfn-signal y el bucket S3). */
  region: string;
  /** Bucket S3 de adjuntos (si S3Mode=create). Si se da, el .env cablea storage=s3 con el rol del EC2. */
  s3Bucket?: string;
  /** Buzón admin a crear en docker-mailserver (login turnkey). La 1ª vez que entra queda admin (bootstrap). */
  adminMailbox?: string;
  /**
   * Clave del buzón admin. SEGURIDAD: viaja en el user-data (cloud-init), visible para quien tenga
   * ec2:DescribeInstanceAttribute en la cuenta. Aceptable en un box single-operator (el dueño de la
   * cuenta ya conoce la clave y puede cambiarla); endurecer entregándola por SSH post-deploy (deuda).
   */
  adminMailboxPassword?: string;
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
for _ in $(seq 1 30); do curl -fsS --max-time 5 https://aws.amazon.com >/dev/null 2>&1 && break || sleep 5; done

# 1) Dependencias base (una AMI mínima NO trae git/openssl/gnupg garantizados).
apt_retry() { for _ in $(seq 1 5); do apt-get "$@" && return 0 || sleep 10; done; return 1; }
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
# Docker Engine 29+ subió su API MÍNIMA a 1.40, pero el provider docker de Traefik v3 pinea la API
# 1.24 → el daemon rechaza sus requests ("client version 1.24 is too old") y Traefik no lee NINGÚN
# label → 404 en todo + sin emisión de cert ACME. Restaurar la compat con API 1.24 en el daemon es el
# fix documentado. [bug hallado en el primer deploy real a AWS]
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nEnvironment="DOCKER_MIN_API_VERSION=1.24"\n' > /etc/systemd/system/docker.service.d/min-api.conf
systemctl daemon-reload
systemctl enable --now docker
# Esperar a que el daemon esté listo antes de usarlo (race de arranque del servicio).
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break || sleep 2; done

# 4) Código (reusa el stack all-in-one ya existente en el repo).
install -d -m 0750 /opt/bifrost
# REF = NOMBRE CORTO de branch o tag de release (p.ej. main, v1.2.0). NO un SHA suelto ni un ref
# completo (refs/tags/...): --branch sólo resuelve nombres cortos. Validar el FORMATO antes de clonar
# da un fallo claro (vs error críptico de git). OJO: el '|| { ... }' MANEJA el error, así que el trap
# ERR NO dispara aquí → hay que llamar signal_fail explícito para avisarle a CFN ya (sin esto, CFN
# caería recién por timeout del CreationPolicy, 15 min). [B-MED]
REF="${sh(ref)}"
# Rechazar la forma TOTALMENTE CALIFICADA (refs/tags/…, refs/heads/…): pasa check-ref-format pero
# 'clone --branch' sólo acepta el nombre CORTO (main, v1.2.0, release/1.2). Fail-fast con aviso a CFN.
case "$REF" in refs/*) echo "ERROR: ref no soportado (usá nombre corto, no refs/...): $REF" >&2; signal_fail; exit 1;; esac
git check-ref-format --allow-onelevel "$REF" || { echo "ERROR: ref de git inválido (usá nombre corto de branch/tag, no refs/...): $REF" >&2; signal_fail; exit 1; }
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
${
  input.s3Bucket
    ? `# Storage de adjuntos: S3 cifrado, autenticado con el ROL del EC2 (IMDS) — cero claves estáticas.
# En el primer boot el API siembra la config a S3 (services/storage/config.ts).
{
  echo "STORAGE_PROVIDER=s3"
  echo "S3_BUCKET=${sh(input.s3Bucket)}"
  echo "S3_REGION=${sh(input.region)}"
  echo "S3_USE_INSTANCE_ROLE=1"
} > .env`
    : `echo "STORAGE_PROVIDER=local" > .env   # adjuntos en disco del EBS (sin S3)`
}

# 7) Levantar el stack (Traefik+TLS, docker-mailserver, Mongo+Redis, Bifrost API/Web).
docker compose pull
docker compose up -d

# Readiness 1/2 — ningún contenedor murió al arrancar (atrapa crashes inmediatos: secreto inválido,
# mount roto, etc.). Si alguno salió, señaliza FRACASO a CFN.
sleep 20
if docker compose ps --status=exited --quiet | grep -q .; then
  echo "ERROR: un contenedor salió al arrancar:" >&2
  docker compose ps >&2
  # signal_fail explícito: 'exit' NO dispara el trap ERR (sólo un comando que falla bajo set -e) → sin
  # esto, CFN no recibe el fracaso y cae recién por timeout del CreationPolicy (15 min). [shellcheck re-audit]
  signal_fail
  exit 1
fi

# Readiness 2/2 — FUNCIONAL: el webmail debe RESPONDER 200 por Traefik (no sólo "contenedor Up"). Un
# contenedor puede estar Up pero inservible (p.ej. Traefik sin poder leer labels → 404 en todo) y eso
# daba un FALSO CREATE_COMPLETE. Se cruza toda la cadena Traefik→web(nginx)→api por /api/health.
# -k + --resolve a localhost: ignora el cert (el ACME puede tardar) y no depende del DNS externo.
ok=
for _ in $(seq 1 30); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "webmail.\${DOMAIN}:443:127.0.0.1" "https://webmail.\${DOMAIN}/api/health" 2>/dev/null || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 10
done
if [ -z "$ok" ]; then
  echo "ERROR: el webmail no responde 200 por Traefik (último code: $code)" >&2
  docker compose logs --tail=50 traefik web api >&2 || true
  signal_fail
  exit 1
fi

${
  input.adminMailbox && input.adminMailboxPassword
    ? `# 7.b) Crear el BUZÓN ADMIN en docker-mailserver → login turnkey desde el minuto cero. La 1ª vez
# que ese usuario entra al webmail, el bootstrap del API lo hace admin (no hay admin previo).
# 'setup' puede tardar en estar listo tras el boot del mailserver → reintentar; si el buzón ya existe,
# tolerar el error (idempotente).
ADMIN_MAILBOX="${sh(input.adminMailbox)}"
ADMIN_MAILBOX_PASS="${sh(input.adminMailboxPassword)}"
for _ in $(seq 1 36); do docker compose exec -T mailserver setup email list >/dev/null 2>&1 && break || sleep 5; done
docker compose exec -T mailserver setup email add "$ADMIN_MAILBOX" "$ADMIN_MAILBOX_PASS" \\
  || echo "buzón admin ya existía o setup no estaba listo"
echo "bifrost-provision: buzón admin $ADMIN_MAILBOX listo" >> /var/log/bifrost-provision.log`
    : ''
}

echo "bifrost-provision: stack levantado para $DOMAIN" > /var/log/bifrost-provision.log

# 8) ÉXITO → señalizar a CloudFormation (sin esto, CreationPolicy expira y el stack falla).
cfn-signal -e 0 --stack "$STACK" --resource Instance --region "$REGION"
`;
}
