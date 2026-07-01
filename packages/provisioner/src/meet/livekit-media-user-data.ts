/**
 * Cloud-init MÍNIMO para el media-box de Bifrost Meet (modo 2-box). Corre SÓLO LiveKit + Caddy;
 * no lleva docker-mailserver, mongo, redis ni la app Bifrost.
 *
 * Seguridad: el apiSecret se LEE de SSM SecureString con el rol del EC2 (nunca en user-data/CFN).
 * El apiKey no es secreto y va literal en el .env del box.
 */
import { sh, stripUserDataComments } from '../mailserver/user-data.js';

export interface LivekitUserDataInput {
  domain: string;
  /** API key pública de LiveKit (identificador, no secreto). */
  apiKey: string;
  /** Nombre del SSM SecureString donde el CLI dejó el apiSecret. */
  secretParamName: string;
  /** Nombre del stack CloudFormation (para cfn-signal). */
  stackName: string;
  /** Región AWS (para cfn-signal y SSM). */
  region: string;
}

/**
 * Marcador que el user-data deja donde va la Elastic IP para `rtc.node_ip` del media-box.
 * `buildStackTemplate` lo sustituye por `GetAtt LivekitElasticIP.PublicIp` vía `Fn::Join`.
 */
export const LIVEKIT_EIP_MARKER = '@@LIVEKIT_EXTERNAL_IP@@';

export function buildLivekitUserData(input: LivekitUserDataInput): string {
  return stripUserDataComments(`#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

STACK="${sh(input.stackName)}"
REGION="${sh(input.region)}"
DOMAIN="${sh(input.domain)}"
API_KEY="${sh(input.apiKey)}"
LK_SECRET_PARAM="${sh(input.secretParamName)}"

signal_fail() { cfn-signal -e 1 --stack "$STACK" --resource LivekitInstance --region "$REGION" || true; }
trap signal_fail ERR

# 0) Esperar salida a internet (ruta al IGW de VPC nueva).
for _ in $(seq 1 30); do curl -fsS --max-time 5 https://aws.amazon.com >/dev/null 2>&1 && break || sleep 5; done

# 1) Dependencias base.
apt_retry() { for _ in $(seq 1 5); do apt-get "$@" && return 0 || sleep 10; done; return 1; }
apt_retry update
apt_retry install -y ca-certificates curl gnupg git openssl python3-pip

# 2) cfn-signal.
pip3 install --break-system-packages https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.tar.gz \\
  || pip3 install https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.tar.gz

# 3) Docker desde repo APT firmado.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt_retry update
apt_retry install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\\nEnvironment="DOCKER_MIN_API_VERSION=1.24"\\n' > /etc/systemd/system/docker.service.d/min-api.conf
systemctl daemon-reload
systemctl enable docker
systemctl restart docker
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break || sleep 2; done
MINAPI=$(docker version --format '{{.Server.MinAPIVersion}}' 2>/dev/null || echo "")
if [ "$MINAPI" != "1.24" ]; then
  echo "ERROR: Docker MinAPIVersion=$MINAPI (esperado 1.24)." >&2
  signal_fail; exit 1
fi

# 4) awscli para leer el secret de SSM.
apt_retry install -y awscli

LK_SECRET=""
{ set +x; } 2>/dev/null
for _ in $(seq 1 12); do
  LK_SECRET=$(aws ssm get-parameter --name "$LK_SECRET_PARAM" --with-decryption --region "$REGION" --query Parameter.Value --output text 2>/dev/null) || LK_SECRET=""
  if [ -n "$LK_SECRET" ] && [ "$LK_SECRET" != "None" ]; then break; fi
  LK_SECRET=""
  sleep 5
done
{ set -x; } 2>/dev/null
if [ -z "$LK_SECRET" ]; then
  echo "ERROR: media-box: apiSecret ausente/vacío en SSM ($LK_SECRET_PARAM) tras reintentos." >&2
  signal_fail; exit 1
fi

# 5) Preparar config de LiveKit y Caddy.
install -d -m 0750 /opt/livekit
LIVEKIT_EIP="${LIVEKIT_EIP_MARKER}"

umask 077
cat > /opt/livekit/livekit.yaml <<'LKCFG'
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  node_ip: __NODE_IP__
room:
  max_participants: 20
  empty_timeout: 300
turn:
  enabled: true
  udp_port: 3478
logging:
  level: info
LKCFG
sed -i "s|__NODE_IP__|$LIVEKIT_EIP|" /opt/livekit/livekit.yaml

cat > /opt/livekit/Caddyfile <<"CADCFG"
meet.__DOMAIN__ {
  reverse_proxy livekit:7880
}
CADCFG
sed -i "s|__DOMAIN__|$DOMAIN|" /opt/livekit/Caddyfile

{
  # livekit-server lee las API keys de la env \`LIVEKIT_KEYS\` con formato "clave: secreto" (NO de vars
  # separadas LIVEKIT_API_KEY/SECRET — esas NO las lee). Sin esto arranca SIN keys → ningún token valida
  # → ninguna llamada conecta (mismo tipo de bug que la imagen v1.8.4). [fix HIGH]
  printf 'LIVEKIT_KEYS=%s: %s\\n' "$API_KEY" "$LK_SECRET"
} > /opt/livekit/.env
chmod 600 /opt/livekit/.env
unset LK_SECRET

cat > /opt/livekit/docker-compose.yml <<'COMPOSE'
services:
  livekit:
    image: livekit/livekit-server:v1.13.2
    restart: unless-stopped
    command: ['--config', '/etc/livekit.yaml']
    env_file: [.env]
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
    ports:
      # 7880 (signaling/API) SÓLO por loopback del host (127.0.0.1) para el healthcheck local — NUNCA público
      # (Caddy lo alcanza por la red docker \`livekit:7880\`; el SG tampoco abre 7880).
      - '127.0.0.1:7880:7880'
      - '7881:7881/tcp'
      - '7882:7882/udp'
      - '3478:3478/udp'
      # CRÍTICO: NO publicar el rango 30000-40000 acá. Docker spawnea un docker-proxy POR PUERTO (10.001
      # procesos) → OOM que mata el boot (hallado en el deploy from-zero REAL: el OOM killeó cfn-signal). El
      # bundled probado tampoco lo mapea; LiveKit usa el mux UDP single-port (7882). El SG abre el rango por
      # si un TURN relay futuro lo necesita, pero el compose NO debe mapearlo. [fix from-zero HIGH]
    mem_limit: 1g
    cpus: '1.0'
    networks: [livekitnet]
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on: [livekit]
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks: [livekitnet]
networks:
  livekitnet:
volumes:
  caddy-data:
  caddy-config:
COMPOSE

# 6) Levantar media stack.
cd /opt/livekit
docker compose pull
docker compose up -d

# 7) Readiness local: chequear LIVEKIT DIRECTO en 7880 (loopback), NO Caddy/HTTPS público. El cert ACME de
# Caddy necesita que meet.<dom> → esta EIP, pero el EIPAssociation ocurre DESPUÉS del cfn-signal → gatear la
# CreationPolicy con el HTTPS público haría deadlock. LiveKit up = 200/404/426 (426 = upgrade-required en el
# path de signaling). El cert público se emite después, post-deploy, cuando el DNS ya apunta. [review B-HIGH]
sleep 10
ok=
for _ in $(seq 1 36); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:7880/" 2>/dev/null || true)
  case "$code" in 200|404|426) ok=1; break;; esac
  sleep 5
done
if [ -z "$ok" ]; then
  echo "ERROR: LiveKit no responde en 127.0.0.1:7880 en el media-box (code=$code)" >&2
  docker compose logs --tail=50 caddy livekit >&2 || true
  signal_fail
  exit 1
fi

echo "bifrost-provision: media-box listo para $DOMAIN" > /var/log/bifrost-livekit.log

# 8) Éxito.
cfn-signal -e 0 --stack "$STACK" --resource LivekitInstance --region "$REGION"
`);
}
