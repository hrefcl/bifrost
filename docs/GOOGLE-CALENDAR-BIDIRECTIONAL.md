# Google Calendar — sincronización BIDIRECCIONAL (Google → Bifrost) — diseño v2

Extiende la integración one-way (Bifrost → Google, ya en prod) con el camino inverso: eventos creados/
editados/borrados en el Google Calendar del usuario se importan a Bifrost. **Requisito de A (pilar):** los
eventos que vienen de Google quedan como un **calendario APARTE "Google"** — separado de los eventos propios
del usuario, **filtrable** (con el check de "Mis calendarios") y **borrable** individualmente.

> v2 incorpora la ronda B/D del diseño (§Correcciones al final): anti-loop robusto (no por prefijo), 410 con
> full-reconcile, ventana rolling, aislamiento por userId, params correctos de events.list, contrato de
> conflictos explícito + enforcement backend, borrado con tombstone, filtro de eventTypes, cadencia con jitter.

## Objetivo y alcance (v1 bidireccional)
- Importar a Bifrost los eventos NATIVOS de Google (los que el usuario creó/editó/borró en Google).
- Aparecen como un calendario separado ("Google"), filtrable y borrable.
- **NO** re-importa los eventos que Bifrost ya empujó a Google (anti-loop, ver §Anti-loop).
- v1: sólo el calendario `primary`; sólo `eventType:'default'` (se filtran birthday/fromGmail/workingLocation/
  focusTime/outOfOffice). Recurrentes: se importan EXPANDIDOS en instancias (`singleEvents`), sin RRULE.
- v1: los eventos importados de Google son **de sólo lectura en Bifrost** (editar = en Google), salvo BORRAR.

## Mecanismo: polling incremental con `syncToken` + refresh de ventana rolling
Google **NO permite** combinar `syncToken` con `timeMin/timeMax/singleEvents/showDeleted` en la misma llamada
(review B/D). Por eso hay DOS modos separados:
- **Sync inicial (sin syncToken):** `events.list` con `singleEvents=true`, `timeMin=hoy−30d`, `timeMax=hoy+12m`,
  `showDeleted=false`. Se pagina hasta el `nextSyncToken` (se guarda). Importa lo visible.
- **Sync incremental (con syncToken):** `events.list?syncToken=…` SIN otros filtros; devuelve TODOS los deltas
  incl. `status:'cancelled'` (borrados). Se pagina por `pageToken` hasta el `nextSyncToken` nuevo.
- **410 Gone** (syncToken venció, >7d): se descarta el token, se **BORRA todo lo local `source:'google'` del
  usuario** (excepto tombstones `googleDeletePending` — ver §Notas) y se hace sync inicial completo. Evita
  quedar con eventos stale que ya no llegan como delta (review B/D HIGH).
- **Ventana rolling (review B HIGH):** el incremental respeta la ventana del inicial → ocurrencias futuras que
  "entran" con el tiempo NO llegan como delta. Solución: **re-sync inicial periódico** (diario) que renueva
  `[hoy−30d, hoy+12m]` y reconcilia (borra local `source:'google'` que ya no esté en el feed). El incremental
  cubre el minuto-a-minuto; el diario cubre el corrimiento.
- Polling y NO webhooks: self-hosted detrás de NAT (§8 del one-way). **Cadencia con jitter + backoff**: cada
  ~5 min ± jitter por usuario, backoff exponencial ante 403/429 de cuota.

## Anti-loop ROBUSTO (review B/D HIGH — NO por prefijo)
El prefijo `bif` NO es confiable: Google acepta IDs custom `[a-v0-9]` y un ICS importado a Google puede traer
un `UID` arbitrario (incluso `bif…`). Anti-loop en DOS capas:
1. **Marca explícita al empujar (cambio en el one-way):** al crear/actualizar en Google (`calendar-api.upsertEvent`)
   se setea `extendedProperties.private.bifrostOrigin='1'`. El poller SALTA todo evento del feed con esa marca
   (Bifrost-origen, ya representado). Google no la pone en eventos nativos.
2. **Lookup local (defensa en profundidad):** antes de importar, si ya existe un `CalendarEvent` del usuario con
   ese `googleEventId` y `source∈{manual,booking}`, se saltea. Cubre eventos empujados antes de tener la marca.

## Modelo de una fuente de verdad — CONTRATO EXPLÍCITO (review B/D)
- **Bifrost-origen** (`source:manual|booking`): Bifrost manda. Editarlo EN GOOGLE se ignora y el próximo push lo
  sobrescribe. **Se documenta al usuario.**
- **Google-origen** (`source:'google'`): Google manda. En Bifrost son **read-only**: el backend RECHAZA
  (`PATCH /calendar/:id` → 409) editar un `source:'google'` — no se confía sólo en ocultar el botón. Borrar sí.
- Límites v1 documentados: sólo `primary` (mover a otro calendario de Google → sale de Bifrost); mover un
  Bifrost-origen entre calendarios en Google no se refleja.

## Modelo de datos (aditivo)
- `CalendarEvent.source`: enum → `'manual' | 'booking' | 'google'`.
- Evento importado: `source:'google'`, `googleEventId`=id NATIVO de Google; `calendarId:'google'`,
  `calendarName:'Google'`, `calendarColor` distintivo; `userId`+`accountId` del dueño. Se guardan
  `googleEtag`/`googleUpdated`, `iCalUID`, `recurringEventId`/`originalStartTime` (debug/recurrencia — LOW).
- **Aislamiento (review B HIGH):** upsert del import por **`{userId, googleEventId, source:'google'}`** (NO por
  `{accountId,calendarId,uid}`). Índice `{userId:1, googleEventId:1}` parcial (`source:'google'`).
- **Filtrable:** gratis vía "Mis calendarios" (calendarName 'Google' → su check). Sin UI de filtro nueva.
- **Borrable:** CalendarEvent normales → DELETE existente (ver §Borrado, tombstone bidireccional).

## Estrategia de aplicación de cambios (por delta del feed)
Por cada evento del delta que (a) NO tenga `bifrostOrigin`, (b) no matchee un Bifrost-origen local, (c) sea
`eventType:'default'`:
- `status:'cancelled'` → borrar/tombstonear el `source:'google'` local con ese `googleEventId`.
- creado/actualizado → **upsert idempotente** por `{userId, googleEventId, source:'google'}`: mapear summary,
  start/end (`dateTime`+`timeZone` o `date`), location, description; guardar etag/updated/iCalUID/recurringEventId.
  Con `singleEvents`, una instancia editada llega con su propio id → evento aparte (excepción). Correcto.

## Borrado bidireccional con tombstone (review B/D)
Borrar en Bifrost un `source:'google'` → tombstone local (`status:'cancelled'` + flag `googleDeletePending`)
+ `deleteEvent` remoto. `404/410` = éxito. El tombstone **tiene prioridad sobre el poller** (no lo recrea).
Al confirmar el delete remoto → se elimina el doc local. Fallos ≠404/410 → reintento con backoff (§Notas).

## Jobs / arquitectura
- Job repetible `gcal-poll` (BullMQ), ~5 min ± jitter. Itera `GoogleConnection.status==='connected'` (patrón del
  backstop). **Lock por-usuario** (`withLock('gcal:poll:'+userId)`). Guarda `syncToken` por conexión. Backoff 403/429.
- Job diario `gcal-window-refresh` → re-sync inicial de la ventana rolling (mismo path que el 410: purge+full).
- Reutiliza `getValidAccessToken` (refresh+cifrado) y `calendar-api` (agregar `listEvents(syncToken|window, pageToken)`).

## Seguridad / aislamiento
- Todo por `userId` del dueño. Scope `calendar.events` ya permite leer. Tokens cifrados, sin cambios.
- Backend enforcea read-only de `source:'google'` (PATCH → 409). El calendario 'Google' es del propio usuario.

## Fases de implementación
- **BD1** modelo: `source:'google'` (enum+shared) + etag/iCalUID/recurring; índice `{userId,googleEventId}` parcial; `calendar-api.listEvents`.
- **BD1b** anti-loop one-way: `upsertEvent` setea `extendedProperties.private.bifrostOrigin`.
- **BD2** motor import `services/google/import.ts`: aplica delta (upsert/borrado), mapeo, doble anti-loop, filtro eventType.
- **BD3** poller `gcal-poll` (por usuario, lock, syncToken, paginación, 410→purge+full, jitter/backoff) + `gcal-window-refresh`.
- **BD4** borrado bidireccional (tombstone + delete remoto + prioridad sobre poller + reintento) y PATCH 409 read-only.
- **BD5** UI: color/etiqueta del calendario "Google" (filtrable gratis); modal read-only si `source:'google'`.
- **BD6** tests: import upsert/delete, anti-loop (marca+lookup), 410 purge+resync, aislamiento cross-usuario, eventType, tombstone-vs-poller.

## §Correcciones ronda B/D del diseño (v2)
- **HIGH anti-loop por prefijo** → `extendedProperties.private.bifrostOrigin` + lookup local (no prefijo `bif`).
- **HIGH 410 incompleto** → purga TODO lo local `source:'google'` del usuario + full re-sync.
- **HIGH ventana congelada** → job diario de refresh de ventana rolling.
- **HIGH índice de aislamiento** → upsert por `{userId, googleEventId, source:'google'}` + índice parcial.
- **MED params events.list** → inicial (timeMin/Max/singleEvents, sin token) vs incremental (sólo syncToken, trae cancelled) + paginación.
- **MED contrato de conflictos** → explícito + backend RECHAZA editar `source:'google'` (409).
- **MED borrado race** → tombstone con prioridad sobre el poller; 404 = éxito.
- **MED eventTypes** → sólo `eventType:'default'`.
- **MED cuota/cadencia** → jitter + backoff.
- **LOW** → etag/updated/iCalUID/recurringEventId; límites de "mover entre calendarios" documentados.

## §Notas de implementación (ronda B/D v2 — APPROVE 8.5/8.5)
- **Purge del 410 NO borra tombstones `googleDeletePending` activos** (review B): procesar/excluir los deletes
  pendientes ANTES del full sync, para no re-importar un evento borrado localmente durante la carrera.
- **El refresh diario de ventana** reusa el mismo path que el 410 (purge+full reconcile) — review D.
- **Tombstones `googleDeletePending` que fallan** por algo ≠404/410 → reintentos con backoff (el job los re-drena) — review D.

Gate del diseño: **CERRADO** (B 8.5 APPROVE + D 8.5 APPROVE, 0 HIGH abiertos).
