#!/bin/bash
# Updater del lado del HOST para el botón "Actualizar" del admin (Fase 2). El API (en contenedor) NUNCA
# toca el socket de Docker: deja un MARKER en ./update-trigger/requested y ESTE script (corrido por root
# vía systemd-timer/cron en el host) hace el pull+up del build pedido, con rollback si no levanta.
#
# SEGURIDAD (review B/D):
#  - El marker es INPUT NO CONFIABLE (si el API se compromete, podría escribirlo). El único dato que se
#    consume es el TAG target, VALIDADO con una regex estricta `^sha-[0-9a-f]{7,40}$` → cero inyección de
#    shell/paths. No se usa ningún otro campo del marker para nada.
#  - flock EXCLUSIVO: no hay updates concurrentes ni solapamiento del timer.
#  - Pin por SHA (no `:latest`): web+api del MISMO commit (consistencia) y rollback determinístico.
#  - Rollback automático: si el build nuevo no responde 200 en el healthcheck, se revierte al tag anterior.
#  - Audit: cada corrida loguea a journald (logger) con el tag aplicado y el resultado.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
TRIGGER="$DIR/update-trigger"
REQUESTED="$TRIGGER/requested"
STATE="$TRIGGER/state.json"
LOCK="$TRIGGER/.lock"
log() { logger -t bifrost-update "$*"; echo "$(date -Is) $*"; }
write_state() { printf '%s\n' "$1" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"; }

install -d -m 0750 "$TRIGGER"
# Sin pedido → nada que hacer.
[ -f "$REQUESTED" ] || exit 0

# Lock exclusivo NO bloqueante: si otro update corre, salir (no encolar).
exec 9>"$LOCK"
flock -n 9 || { log "otro update en curso; salgo"; exit 0; }

# Leer y VALIDAR el tag target (única dato confiable-tras-validación del marker). Una sola línea.
TARGET="$(head -n1 "$REQUESTED" 2>/dev/null | tr -d '[:space:]')"
if ! printf '%s' "$TARGET" | grep -qE '^sha-[0-9a-f]{7,40}$'; then
  log "marker inválido ('$TARGET') — ignoro y limpio"
  write_state "{\"status\":\"failed\",\"reason\":\"invalid-marker\"}"
  rm -f "$REQUESTED"
  exit 0
fi

# Tag actual (para rollback). El .env del compose guarda BIFROST_TAG.
CURRENT="$(grep -E '^BIFROST_TAG=' .env 2>/dev/null | cut -d= -f2 || true)"
[ -n "$CURRENT" ] || CURRENT="latest"
log "update pedido: $CURRENT -> $TARGET"
write_state "{\"status\":\"in_progress\",\"from\":\"$CURRENT\",\"to\":\"$TARGET\"}"

# set_tag <tag>: escribe BIFROST_TAG en .env de forma ATÓMICA (no parte el archivo si algo falla).
set_tag() {
  local tag="$1"
  { grep -vE '^BIFROST_TAG=' .env 2>/dev/null || true; echo "BIFROST_TAG=$tag"; } > .env.tmp
  mv -f .env.tmp .env
}

healthy() {
  # Healthcheck contra el CONTENEDOR (web→api por /api/health), NO por Traefik: lo que valida el update es
  # que las imágenes nuevas de web+api levanten sanas; el ruteo de Traefik es ortogonal (sus labels no
  # cambian) y re-sincroniza solo. Pegarle por Traefik daría falso-negativo durante la ventana de re-sync.
  for _ in $(seq 1 30); do
    if docker compose exec -T web wget -qO- --timeout=4 http://127.0.0.1/api/health 2>/dev/null \
         | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

apply() { # apply <tag>
  set_tag "$1"
  docker compose pull web api >/dev/null 2>&1 || return 1
  docker compose up -d web api >/dev/null 2>&1 || return 1
}

if apply "$TARGET" && healthy; then
  log "update OK a $TARGET"
  write_state "{\"status\":\"succeeded\",\"from\":\"$CURRENT\",\"to\":\"$TARGET\"}"
else
  log "build $TARGET no levantó/healthcheck falló → ROLLBACK a $CURRENT"
  if apply "$CURRENT" && healthy; then
    write_state "{\"status\":\"rolledback\",\"from\":\"$CURRENT\",\"to\":\"$TARGET\"}"
    log "rollback a $CURRENT OK"
  else
    write_state "{\"status\":\"failed\",\"reason\":\"rollback-failed\",\"to\":\"$TARGET\"}"
    log "ROLLBACK también falló — intervención manual"
  fi
fi
# Limpiar imágenes viejas (anti disco-lleno a las 3AM) y el pedido.
docker image prune -f >/dev/null 2>&1 || true
rm -f "$REQUESTED"
