# Post-mortem — saliente caído 11h por relay SES no persistido (box aulion.app)

> Incidente real en producción (box `aulion.app`, 2026-06-30). Detectado porque un correo del operador
> a un destinatario externo "no llegó". Severidad: ALTA (todo el envío externo caído, silencioso).

## Impacto
Durante ~11h el box **no entregó NINGÚN correo a dominios externos**. Los mensajes quedaron `deferred`
en la cola de postfix (reintentando), sin pérdida (no llegaron a expirar a los 5 días), pero sin entregar.
El operador sólo se enteró al notar que un correo puntual no llegaba.

## Causa raíz
El relay SES estaba configurado **manualmente** en postfix (no de forma persistente). Cuando el contenedor
`mailserver` reinició (~11h antes), docker-mailserver **regeneró su config desde cero** y el `relayhost`
quedó **vacío**. Sin relay, postfix intentó entregar **directo al MX del destinatario por el puerto 25** —
que **AWS bloquea en EC2** → `Network is unreachable` → todo el saliente externo `deferred`.

NO fue: sandbox (la cuenta SES estaba en producción y sana), ni supresión (lista vacía), ni reputación.

## Detección
- `postqueue -p` en el contenedor → mensajes `deferred` con `connect to smtp.google.com:25: Network is unreachable`.
- `postconf -h relayhost` → **vacío** (la prueba definitiva).
- SES `get-account` → `ProductionAccessEnabled=True`, `SendingEnabled=True`, `EnforcementStatus=HEALTHY`.

## Resolución (inmediata + persistente)
1. **Inmediata:** se reconfiguró el relay en postfix (`relayhost=[email-smtp.us-east-1.amazonaws.com]:587`
   + SASL con las creds del IAM user `bifrost-ses-smtp`) y se **flusheó la cola** (`postqueue -f`) →
   los correos atascados se entregaron (`status=sent 250 Ok`).
2. **Persistente (puente):** se agregó `config/user-patches.sh` (extension-point de docker-mailserver que
   corre en cada arranque) re-aplicando el relay → **verificado reiniciando el contenedor**: el relay
   sobrevivió (antes, un restart lo borraba).
3. **Test e2e** post-restart: envío instantáneo vía SES confirmado (`status=sent`, sin intento de puerto 25).

## Fix de raíz (en el repo — rama `feat/ses-outbound`)
La causa raíz es que el `deploy/example-mailserver` **no tenía un lugar persistente para la config del relay**.
La rama de SES turnkey ya lo corrige: el compose del mailserver ahora usa `env_file: mailserver.env`, y ese
archivo (en el volumen, persistente) es donde viven `RELAY_HOST/PORT/USER/PASSWORD` → **sobrevive restarts y
recreates**. La feature turnkey además lo puebla sola (helper `bifrost-ses-activate` + cron). El
`user-patches.sh` del box es el puente hasta desplegar esa rama.

## Acciones de seguimiento (deuda)
- [ ] **TD-OUTBOUND-MONITOR (P1):** el corte fue SILENCIOSO 11h. Falta una alerta cuando la cola de postfix
      crece o el relay no resuelve (p.ej. un cron que chequee `postqueue -p` / un healthcheck del 587 saliente).
      Sin esto, el próximo corte tampoco se detecta hasta que alguien note un correo perdido.
- [ ] **TD-OUTBOUND-MAILFROM (P2):** la identidad SES de aulion.app NO tiene custom MAIL FROM → SPF no
      alinea (DMARC pasa por DKIM, pero la alineación SPF mejora entregabilidad). El turnkey ya lo configura
      (`bounce.<dominio>`); aplicarlo al box.
- [ ] **TD-SES-IAM-CLEANUP (P3):** hay DOS IAM users SES (`aulion-ses-smtp` y `bifrost-ses-smtp`) — cruft de
      setups manuales. Consolidar a uno (el turnkey usa un nombre determinístico por dominio).

## Lección
Una config crítica aplicada "a mano" en un contenedor efímero es deuda latente: **sobrevive hasta el primer
restart**. Todo lo que deba persistir va en el volumen montado (env_file / config files), no en `postconf`
en caliente. Y todo control crítico necesita una señal cuando se cae (no descubrirlo por un usuario).
