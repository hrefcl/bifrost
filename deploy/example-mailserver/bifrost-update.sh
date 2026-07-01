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
# HARDENING (B HIGH): el dir update-trigger es bind-mount del API (root). Si el API se compromete, puede
# plantar symlinks/FIFOs ahí → el host-updater (root) NO debe escribir/leer siguiéndolos (clobber/DoS de
# archivos root del host). Por eso: (a) el LOCK y el tmp del STATE viven en /run (root-only, FUERA del
# mount, intocable por el API); (b) se valida que update-trigger y requested sean archivos REGULARES y NO
# symlinks antes de tocarlos; (c) el STATE final se escribe con mv (reemplaza, no escribe a través de un
# symlink). Esto preserva la frontera "el API no toca el host".
LOCK="/run/bifrost-update.lock"
STATE_TMP="/run/bifrost-update.state.tmp"
log() { logger -t bifrost-update "$*"; echo "$(date -Is) $*"; }
# write_state: escribe en /run (root-only) y mv a STATE → si STATE fuera un symlink plantado, mv lo
# REEMPLAZA (no escribe a través). Nunca se hace `> "$STATE"` directo.
write_state() { printf '%s\n' "$1" > "$STATE_TMP" && mv -f "$STATE_TMP" "$STATE"; }

# El dir debe ser un directorio REAL (no un symlink que el API plante apuntando a otro lado).
if [ -L "$TRIGGER" ] || { [ -e "$TRIGGER" ] && [ ! -d "$TRIGGER" ]; }; then
  logger -t bifrost-update "update-trigger no es un dir regular — abortando"; exit 1
fi
install -d -m 0750 "$TRIGGER"
# Sin pedido, o pedido que NO es un archivo regular (symlink/FIFO/dir plantado) → no hacer nada.
[ -f "$REQUESTED" ] && [ ! -L "$REQUESTED" ] || exit 0

# Lock exclusivo NO bloqueante (en /run, intocable por el API): si otro update corre, salir.
exec 9>"$LOCK"
flock -n 9 || { log "otro update en curso; salgo"; exit 0; }

# Leer y VALIDAR el tag target (único dato confiable-tras-validación del marker). Una sola línea. El
# archivo ya se verificó regular+no-symlink arriba, así que head no puede colgarse en un FIFO.
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
  # [B-MED] chequear set_tag: si no se pudo fijar BIFROST_TAG en .env, abortar (si no, se haría pull/up con
  # el tag VIEJO y se marcaría 'succeeded' para un target que nunca quedó fijado).
  set_tag "$1" || return 1
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
