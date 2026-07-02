#!/usr/bin/env bash
# Asistente de configuración: deja el stack listo para `docker compose up -d`.
# Reemplaza el dominio, genera los secretos e imprime los DNS que tenés que cargar.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Asistente de configuración — Servidor de correo + Bifrost"
echo

# 1) Datos del usuario
read -rp "Tu dominio (ej. tudominio.com): " DOMAIN
read -rp "Tu email de admin (para Let's Encrypt) [admin@${DOMAIN}]: " ADMIN_EMAIL
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${DOMAIN}}"

if [[ -z "$DOMAIN" || "$DOMAIN" != *.* ]]; then
  echo "❌ Dominio inválido." >&2
  exit 1
fi

# 2) Reemplazar el dominio de ejemplo en el compose (backup .bak por las dudas)
sed -i.bak \
  -e "s/admin@example.com/${ADMIN_EMAIL}/g" \
  -e "s/example.com/${DOMAIN}/g" \
  docker-compose.yml
rm -f docker-compose.yml.bak
echo "✅ docker-compose.yml configurado para ${DOMAIN}"

# 3) Generar secretos (si no existen)
mkdir -p secrets
gen() { # gen <archivo> <comando-de-generación>
  if [[ -s "secrets/$1" ]]; then
    echo "   (secrets/$1 ya existe, no lo toco)"
  else
    eval "$2" >"secrets/$1"
    chmod 600 "secrets/$1"
    echo "   generado secrets/$1"
  fi
}
gen jwt_secret.txt "openssl rand -hex 32"
gen encryption_key.txt "openssl rand -hex 32" # 64 hex = 32 bytes (AES-256)
gen compliance_hmac_secret.txt "openssl rand -hex 32" # evidencia HMAC de compliance (lo exige el API en prod)
gen provision_api_key.txt "openssl rand -hex 32" # API-key del provisioning máquina-a-máquina (/api/provision/*)
echo "✅ Secretos listos en ./secrets/ (NO los subas a git)"

# 3.b) fail2ban: el API es un PROXY IMAP confiable — TODOS los logins de TODOS los usuarios salen de la IP del
# contenedor API. Sin este ignoreip, los fallos de password de UN usuario banean la IP del API → lockout de TODO
# el tenant. La red 172.16/12 es interna (no enrutable desde internet), no debilita el anti-bruteforce externo.
# docker-mailserver copia este archivo a /etc/fail2ban/jail.d/user-jail.local en cada arranque.
mkdir -p config
if [[ ! -s config/fail2ban-jail.cf ]]; then
  printf '[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 172.16.0.0/12 192.168.0.0/16\n' > config/fail2ban-jail.cf
  echo "✅ fail2ban: whitelisteada la red Docker (evita lockout del tenant por el proxy del API)"
elif ! grep -q '172.16.0.0/12' config/fail2ban-jail.cf; then
  # Deploy manual previo con un fail2ban-jail.cf propio que NO whitelistea la red Docker → vulnerable al
  # lockout del tenant. No lo piso (puede tener customizaciones), pero aviso fuerte. [review B]
  echo "⚠️  config/fail2ban-jail.cf existe pero NO whitelistea la red Docker (172.16.0.0/12)." >&2
  echo "    Sin eso, los fallos de password de UN usuario banean la IP del contenedor API → lockout de TODO" >&2
  echo "    el tenant. Agregá manualmente a [DEFAULT]: ignoreip = 127.0.0.1/8 ::1 172.16.0.0/12 192.168.0.0/16" >&2
fi

# 4) Imprimir DNS
PUBIP="$(curl -fsS https://api.ipify.org 2>/dev/null || echo 'TU.IP.PUBLICA')"
cat <<EOF

==================== CARGÁ ESTOS DNS ====================
  A     mail.${DOMAIN}      ${PUBIP}
  A     webmail.${DOMAIN}   ${PUBIP}
  MX    ${DOMAIN}           mail.${DOMAIN}   (prioridad 10)
  TXT   ${DOMAIN}           "v=spf1 mx ~all"
  (DKIM/DMARC se generan en el Paso 5 del README)
========================================================

Próximos pasos:
  1) Cargá esos DNS y esperá la propagación.
  2) docker compose up -d
  3) docker compose exec mailserver setup config dkim
  4) docker compose exec mailserver setup email add tu-usuario@${DOMAIN}
  5) Entrá a https://webmail.${DOMAIN}

EOF
echo "🎉 Listo."
