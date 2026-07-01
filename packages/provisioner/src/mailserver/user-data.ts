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
  /**
   * Habilitar Bifrost Meet (LiveKit self-hosted). Si true: genera claves LiveKit en el host, escribe
   * `MEET_PROVISIONED=1`+`COMPOSE_PROFILES=meet`+`LIVEKIT_*` al `.env` y sustituye `node_ip` con la EIP
   * (marcador {@link MEET_EIP_MARKER}, que CFN reemplaza por la IP real). OFF ⇒ user-data byte-idéntico.
   */
  enableMeet?: boolean;
  /**
   * Nombre del parámetro SSM SecureString con la credencial SMTP de SES (lo escribe el orquestador del
   * CLI). Si se da, el box instala un helper `bifrost-ses-activate` que LEE la credencial con el rol y
   * cablea el relay de docker-mailserver. SEND-GATING (§7b): al boot el relay queda APAGADO
   * (mailserver.env vacío); se activa sólo cuando la credencial existe en SSM (outbound `ready`).
   */
  sesParamName?: string;
}

/**
 * Marcador que el user-data deja (sólo con Meet ON) donde va la Elastic IP para `rtc.node_ip` de
 * LiveKit. `buildStackTemplate` lo sustituye por `GetAtt ElasticIP.PublicIp` vía `Fn::Join` (la IP la
 * inyecta CFN, NO IMDS). No contiene `${` → atraviesa bash sin interpolar.
 */
export const MEET_EIP_MARKER = '@@MEET_EXTERNAL_IP@@';

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
# CRÍTICO: 'enable --now' NO reinicia un daemon que el apt-install ya dejó corriendo → el drop-in de
# DOCKER_MIN_API_VERSION NO se aplicaría (el daemon seguiría con min 1.40 → Traefik 404). Hay que
# RESTART explícito para que tome el Environment. [bug hallado en el 2º deploy real a AWS]
systemctl enable docker
systemctl restart docker
# Esperar a que el daemon esté listo antes de usarlo (race de arranque del servicio).
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break || sleep 2; done
# Confirmar que el min API quedó en 1.24 (si no, Traefik no leerá labels → fail-fast con aviso a CFN).
MINAPI=$(docker version --format '{{.Server.MinAPIVersion}}' 2>/dev/null || echo "")
if [ "$MINAPI" != "1.24" ]; then
  echo "ERROR: Docker MinAPIVersion=$MINAPI (esperado 1.24); Traefik no leería labels." >&2
  signal_fail; exit 1
fi

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
# Secreto DEDICADO de la evidencia de compliance (HMAC). NO se deriva de JWT_SECRET (que rota →
# invalidaría evidencia histórica). 64 chars hex ≥ 32 (lo que exige la API en producción).
openssl rand -hex 32 > secrets/compliance_hmac_secret.txt
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
${
  input.enableMeet
    ? `# 6.b) Bifrost Meet (LiveKit self-hosted) — activado por el provisioner. Claves LiveKit GENERADAS en
# el host (no viajan en el user-data; api y livekit derivan de las MISMAS dos vars → el JWT valida).
# El .env activa el profile (COMPOSE_PROFILES=meet) + el flag de provisión (MEET_PROVISIONED=1, que
# afloja la CSP del SPA a wss: y habilita config runtime del LiveKit desde el admin). El sed pone
# node_ip = EIP (ICE DETERMINISTA) y apaga la autodetección STUN. La EIP la inyecta CFN (Fn::Join sobre
# el marcador), NO IMDS (el EIPAssociation asocia DESPUÉS de señalizar → IMDS daría la IP efímera).
LIVEKIT_API_KEY="LK$(openssl rand -hex 12)"
LIVEKIT_API_SECRET="$(openssl rand -hex 32)"
MEET_EXTERNAL_IP="${MEET_EIP_MARKER}"
{
  echo "MEET_PROVISIONED=1"
  echo "COMPOSE_PROFILES=meet"
  echo "LIVEKIT_WS_URL=wss://meet.\${DOMAIN}"
  echo "LIVEKIT_API_URL=http://livekit:7880"
  echo "MEET_PUBLIC_BASE_URL=https://webmail.\${DOMAIN}"
  echo "LIVEKIT_API_KEY=\${LIVEKIT_API_KEY}"
  echo "LIVEKIT_API_SECRET=\${LIVEKIT_API_SECRET}"
} >> .env
if [ -n "$MEET_EXTERNAL_IP" ]; then
  sed -i "s|^  # node_ip: __MEET_EXTERNAL_IP__.*|  node_ip: \${MEET_EXTERNAL_IP}|; s|^  use_external_ip: true|  use_external_ip: false|" livekit.yaml
fi`
    : ''
}
# Dominio del box → lo usa el host-updater (Fase 2) para el healthcheck post-update por Traefik.
echo "BIFROST_DOMAIN=\${DOMAIN}" >> .env
# Updater del host (botón "Actualizar" del admin): el script vive en el repo (deploy/example-mailserver/
# bifrost-update.sh). Lee el marker que deja el API y hace pull+up+rollback. El API NUNCA toca el socket de
# Docker. Ver bifrost-update.sh.
chmod +x bifrost-update.sh 2>/dev/null || true
install -d -m 0750 update-trigger
# DISPARO: dos mecanismos complementarios (ambos corren el MISMO script con flock → nunca se solapan):
#  (a) systemd .path → observa el marker y dispara en ~1-2s (el botón no espera al próximo tick del cron).
#  (b) cron cada minuto → red de seguridad si el .path fallara. Antes sólo había cron → hasta 60s de latencia
#      percibida ("demoró mucho en actualizar").
echo '* * * * * root cd /opt/bifrost/deploy/example-mailserver && ./bifrost-update.sh >> /var/log/bifrost-update.log 2>&1' > /etc/cron.d/bifrost-update
chmod 644 /etc/cron.d/bifrost-update
cat > /etc/systemd/system/bifrost-update.service <<'UNIT'
[Unit]
Description=Bifrost host-side updater (aplica el build pedido por el admin)
[Service]
Type=oneshot
WorkingDirectory=/opt/bifrost/deploy/example-mailserver
ExecStart=/opt/bifrost/deploy/example-mailserver/bifrost-update.sh
UNIT
cat > /etc/systemd/system/bifrost-update.path <<'UNIT'
[Unit]
Description=Observa el marker de update de Bifrost y dispara el updater al instante
[Path]
PathExists=/opt/bifrost/deploy/example-mailserver/update-trigger/requested
Unit=bifrost-update.service
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bifrost-update.path
# fail2ban: el API es un PROXY IMAP confiable — TODOS los logins de TODOS los usuarios salen de la IP del
# contenedor API. Sin este ignoreip, los fallos de password de UN usuario banean la IP del API → lockout de
# TODO el tenant (incidente real). La red 172.16/12 es interna (no enrutable desde internet), así que esto NO
# debilita el anti-bruteforce de IMAP/SMTP directo desde IPs públicas. docker-mailserver copia este archivo a
# /etc/fail2ban/jail.d/user-jail.local en CADA arranque (los jail.d/*.local se leen último → ganan a jail.local).
install -d -m 0750 config
cat > config/fail2ban-jail.cf <<'F2B'
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 172.16.0.0/12 192.168.0.0/16
F2B
chmod 0644 config/fail2ban-jail.cf
# NOTA (review B/D): 172.16/12 + 192.168/16 cubren TODO el pool de redes bridge que Docker asigna por defecto
# (moby ipamutils: 172.17-31/16 y 192.168/16). El modelo de Bifrost es ALL-IN-ONE single-tenant: el único
# origen en esos rangos RFC1918 es un contenedor del propio box (confiable). NO se expone a internet (no
# spoofeable en TCP) y el bruteforce IMAP/SMTP directo desde IPs públicas se sigue baneando. Si algún día se
# corre en host/VPC compartido, estrechar a la subnet exacta de la red del compose.
${
  input.sesParamName
    ? `# 6.b) OUTBOUND SES: el relay arranca APAGADO (send-gating §7b). Un helper lo activa SÓLO cuando la
# credencial SMTP existe en SSM (= el orquestador del CLI la publica al quedar el outbound 'ready'),
# escribiéndola en config/user-patches.sh (PERSISTENTE: docker-mailserver lo re-corre en cada arranque →
# sobrevive restart/reboot, a diferencia de una config en caliente). awscli para leer el SecureString.
apt_retry install -y awscli
SES_PARAM="${sh(input.sesParamName)}"
printf 'SES_PARAM=%s\\nSES_REGION=%s\\nCOMPOSE_DIR=%s\\n' "$SES_PARAM" "$REGION" "$(pwd)" > /etc/bifrost-ses.conf
cat > /usr/local/bin/bifrost-ses-activate <<'ACT'
#!/bin/bash
# Cablea el relay SES leyendo la credencial SMTP de SSM (con el rol del box). Idempotente y graceful:
# si la credencial aún no existe (outbound no-ready), NO toca nada y sale 0 (relay sigue apagado).
set -euo pipefail
. /etc/bifrost-ses.conf
VAL=$(aws ssm get-parameter --name "$SES_PARAM" --with-decryption --region "$SES_REGION" --query Parameter.Value --output text 2>/dev/null) || { echo "bifrost-ses: credencial no disponible aún; relay apagado"; exit 0; }
RUSER=$(printf '%s' "$VAL" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessKeyId"])')
RPASS=$(printf '%s' "$VAL" | python3 -c 'import sys,json;print(json.load(sys.stdin)["smtpPassword"])')
cd "$COMPOSE_DIR"
RELAY="email-smtp.$SES_REGION.amazonaws.com"
# El relay se persiste vía config/user-patches.sh: docker-mailserver lo corre en CADA arranque del
# contenedor → sobrevive restart/reboot/recreate. NO se usa 'compose up' confiando en que recree por el
# cambio de env_file (comportamiento FRÁGIL/version-dependiente que dejaría el relay sin aplicar). Este
# mecanismo está PROBADO contra un restart real. (Comillas simples internas para los valores de postconf
# → cero backslashes que el generador del user-data malinterprete.)
mkdir -p config
umask 077
{
  echo '#!/bin/bash'
  echo "postconf -e 'relayhost = [$RELAY]:587'"
  echo "postconf -e 'smtp_sasl_auth_enable = yes'"
  echo "postconf -e 'smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd'"
  echo "postconf -e 'smtp_sasl_security_options = noanonymous'"
  echo "postconf -e 'smtp_tls_security_level = encrypt'"
  echo "echo '[$RELAY]:587 $RUSER:$RPASS' > /etc/postfix/sasl_passwd"
  echo 'postmap hash:/etc/postfix/sasl_passwd'
  echo 'chmod 600 /etc/postfix/sasl_passwd /etc/postfix/sasl_passwd.db'
  echo 'postfix reload || true'
} > config/user-patches.sh.new
chmod 700 config/user-patches.sh.new
# Sólo re-aplicar si cambió (el cron corre cada 5 min; evita exec/flush innecesarios).
if ! cmp -s config/user-patches.sh.new config/user-patches.sh 2>/dev/null; then
  mv config/user-patches.sh.new config/user-patches.sh
  # Aplicar YA en el contenedor corriendo (sin esperar un restart) + flushear la cola atascada.
  docker compose exec -T mailserver bash /tmp/docker-mailserver/user-patches.sh || true
  docker compose exec -T mailserver postqueue -f || true
  echo "bifrost-ses: relay ACTIVADO y persistido (RELAY_USER=$RUSER)"
else
  rm -f config/user-patches.sh.new
fi

# HEALTH PROBE del saliente (corre en cada tick del cron) → convierte un corte SILENCIOSO en detectable.
# Hace AUTH a SES:587 SIN mandar correo (valida puerto 587 abierto + TLS + credenciales). La clave va por
# ENV (no por argv → no aparece en 'ps'). Loguea OK o ALERTA con causa en /var/log/bifrost-ses.log.
LOG=/var/log/bifrost-ses.log
if RHOST="$RELAY" RUSR="$RUSER" RPWD="$RPASS" python3 - <<'PY' 2>>"$LOG"
import smtplib, os, sys
try:
    s = smtplib.SMTP(os.environ["RHOST"], 587, timeout=15)
    s.starttls(); s.login(os.environ["RUSR"], os.environ["RPWD"]); s.quit()
except Exception as e:
    print("probe-error:", e, file=sys.stderr); sys.exit(1)
PY
then
  echo "$(date -Is) bifrost-ses: relay OK (AUTH a SES:587 exitoso)" >> "$LOG"
else
  echo "$(date -Is) bifrost-ses: ALERTA — el relay NO funciona (fallo AUTH/conexión a SES:587). El saliente externo NO sale. Revisá creds SES / puerto 587." >> "$LOG"
fi
# Alerta de cola: mail atascado = relay roto o SES rechazando. Cuenta entradas de cola (IDs hex).
QN=$(docker compose exec -T mailserver postqueue -p 2>/dev/null | grep -cE '^[0-9A-F]{8,}' || true)
if [ "\${QN:-0}" -gt 5 ]; then
  echo "$(date -Is) bifrost-ses: ALERTA — $QN mensajes ATASCADOS en la cola de envío (revisá el relay)." >> "$LOG"
fi
ACT
chmod 755 /usr/local/bin/bifrost-ses-activate
# Timer pull-based: el box se auto-activa dentro de ~5 min de que la credencial aparezca en SSM, y
# RE-aplica el relay tras un reboot (sobrevive reinicios). No requiere push del operador al box.
echo '*/5 * * * * root /usr/local/bin/bifrost-ses-activate >> /var/log/bifrost-ses.log 2>&1' > /etc/cron.d/bifrost-ses
chmod 644 /etc/cron.d/bifrost-ses`
    : ''
}

# 7) Levantar el stack (Traefik+TLS, docker-mailserver, Mongo+Redis, Bifrost API/Web; + LiveKit si Meet).
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
  input.enableMeet
    ? `# Readiness Meet — LOCAL y NO-FATAL: el endpoint wss de LiveKit por Traefik debe estar ruteado. Meet
# es OPCIONAL → un hipo NO debe tumbar el provision del correo (un CRASH de livekit ya lo atrapa el
# check de contenedor-exited de arriba). La verificación PÚBLICA (https://meet.<dom> por DNS) es un
# check post-deploy del CLI/outputs, no gatea cfn-signal. 426 (Upgrade Required) = router OK sin WS.
meet_code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "meet.\${DOMAIN}:443:127.0.0.1" "https://meet.\${DOMAIN}/" 2>/dev/null || true)
case "$meet_code" in
  200|426|101) echo "bifrost-provision: Meet ruteado por Traefik (code $meet_code)" >> /var/log/bifrost-provision.log ;;
  *) echo "AVISO: Meet aún no responde local por Traefik (code $meet_code); revisá 'docker compose logs livekit traefik'." >&2 ;;
esac`
    : ''
}

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

${
  input.sesParamName
    ? `# 7.c) Intentar activar el relay SES YA (si la credencial ya está en SSM). Graceful: si aún no está
# (outbound no-ready), no hace nada; el cron reintenta cada 5 min. Sobrevive reboots.
/usr/local/bin/bifrost-ses-activate || true`
    : ''
}

echo "bifrost-provision: stack levantado para $DOMAIN" > /var/log/bifrost-provision.log

# 8) ÉXITO → señalizar a CloudFormation (sin esto, CreationPolicy expira y el stack falla).
cfn-signal -e 0 --stack "$STACK" --resource Instance --region "$REGION"
`;
}
