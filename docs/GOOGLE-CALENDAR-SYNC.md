# Integración Google Calendar — sincronización de eventos (diseño v2)

**Estado:** DISEÑO v2 — endurecido tras gate B/D (D 6.5–7 NO-APPROVE, HIGH de OAuth+idempotencia; B
alineado). Los HIGH/MED están incorporados en **§Hardening (obligatorio)** al final. Worktree
`google-calendar-sync`. 2026-07-03.

## Objetivo y alcance
Cada usuario conecta su cuenta de Google (OAuth 2.0) y los eventos que crea/edita/elimina en el
calendario de Bifrost se reflejan en su Google Calendar.

- **v1 = UNIDIRECCIONAL** (Bifrost → Google): crear/editar/eliminar. OAuth + UI conexión/desconexión +
  estado de sync + reintento + tokens cifrados + tests + docs.
- **Bidireccional (Google → Bifrost) = INVESTIGADA, NO implementada en v1.** Recomendación abajo (§8).

## Principio rector (OPEN SOURCE + self-hosted per-tenant)
Bifrost es open source y self-hosted por-tenant (ver memoria self-hosted-no-babysitting). El proyecto
**NO entrega credenciales de Google** — no hay un client id/secret compartido. Implicancias de diseño:
- **Cada operador configura SU propio proyecto Google Cloud** y provee `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` por env (o docker-secret `_FILE`). NO vienen embebidas.
- **Feature-gate:** si esas env vars no están, la integración está **DESHABILITADA** — los endpoints
  `/google/*` responden `404/"no configurado"`, `GET /google/status` devuelve `{ available:false }` y la
  UI muestra "Sincronización con Google no disponible en esta instalación" (nunca rompe el calendario).
- **Setup del operador (va a la doc técnica/README):** crear proyecto en Google Cloud Console → habilitar
  Google Calendar API → crear credenciales OAuth 2.0 (tipo Web) → agregar el redirect URI de su dominio →
  copiar client id/secret a las env → (mientras la app OAuth esté en "testing", agregar usuarios de prueba
  o publicarla). Documentado paso a paso; sin esto la feature simplemente no aparece.
- **Sin webhooks entrantes garantizados** (muchos deploys están detrás de NAT/sin dominio público) →
  la bidireccionalidad, si se hace, va por **polling con syncToken**, no por Push Notifications.
- **v1 UNIDIRECCIONAL confirmado por el PM** (Bifrost → Google). Bidireccional = investigada (§8), fase 2.

## Anclas en el código existente (se reutiliza, no se inventa)
- `models/CalendarEvent.ts` — evento local, scopeado `userId`+`accountId`, `status:'cancelled'` (soft),
  `source:'manual'|'booking'`, índice único `{accountId,calendarId,uid}`. **Le faltan campos Google.**
- `routes/calendar.ts` — CRUD manual INLINE (POST L64 / PATCH L98 / DELETE L144). **Se extrae a servicio.**
- `services/scheduling/booking-service.ts` — proyecta eventos de booking (create/cancel/reschedule).
- `config/crypto.ts` — `encrypt/decrypt` AES-256-GCM + `EncryptedPayload`. **Tokens OAuth se cifran acá.**
- `models/Account.ts` — molde `EncryptedFieldSchema {ciphertext,iv,tag}` para credenciales cifradas.
- `services/scheduling/{queue,worker,reconciler}.ts` — BullMQ + reconciler + `withLock`. **Backbone de
  la sync async/retry/idempotencia.** No-op cuando `REDIS_URL='mock'` (tests).
- `config/env.ts` — schema zod + docker-secrets `_FILE` (plantilla `LIVEKIT_*` opcional).
- `CalendarView.vue` sidebar (~L392 "Mis calendarios") — dónde va "Conectar con Google". Usa `AppIcon`+`theme.css`.
- Tests: `test/integration-helper.ts` + patrón `vi.mock('imapflow')` → se mockea la Google API igual.

## Arquitectura (limpia, OAuth desacoplado del calendario)
Módulo nuevo `services/google/` — la lógica de Google NO se acopla al CRUD del calendario:
```
services/google/
  oauth.ts       # authUrl(state), exchangeCode(code)→tokens, refreshAccessToken(conn), revoke(conn)
  calendar-api.ts# cliente REST: insertEvent/patchEvent/deleteEvent (fetch + bearer; refresh transparente)
  sync.ts        # syncEventToGoogle(eventId): lee CalendarEvent + GoogleConnection → op idempotente
  connection.ts  # get/set GoogleConnection, cifrado de tokens, estado
```
- **Enganche (choke-point):** se extrae el CRUD de eventos manuales a `services/calendar-events.ts`
  (`createEvent/updateEvent/deleteEvent`) que `routes/calendar.ts` delega. Ahí, tras el commit local,
  se **encola** un job `gcal-sync {op, eventId, userId}` (si el user está conectado). Los eventos de
  **booking** (booking-service) opcionalmente encolan igual (config; v1: sólo manuales para acotar).
- **Async:** nuevo job name en la cola BullMQ existente + un `startGoogleWorker`/procesador. Reintentos
  (attempts+backoff) y DLQ ya vienen del patrón. Un **reconciler** repara eventos con `syncStatus:'error'`.
- **Fail-soft:** un fallo de Google NUNCA rompe el CRUD local (se encola y reintenta; el evento local
  se guarda igual). El estado se refleja en `googleSyncStatus`/`googleSyncError`.

## Modelo de datos (aditivo — NUNCA rompe lo existente)

### Nuevo modelo `GoogleConnection` (1 por usuario)
```
userId: ObjectId (unique, index)      // aislamiento: la conexión es del usuario
accessTokenEnc:  EncryptedPayload      // cifrado (crypto.ts) — NUNCA sale por la API
refreshTokenEnc: EncryptedPayload      // cifrado — NUNCA al frontend
tokenExpiresAt:  Date                  // googleTokenExpiresAt
scope:           string                // permisos otorgados
googleCalendarId: string               // calendario destino, default 'primary'
googleUserEmail?: string               // email de la cuenta Google conectada (para mostrar)
status: 'connected' | 'error' | 'revoked'
syncError?: string                     // último error legible (googleSyncError a nivel conexión)
connectedAt:  Date                     // googleConnectedAt
lastSyncedAt?: Date                    // googleLastSyncedAt
timestamps                             // createdAt/updatedAt
```
Desconexión = **soft**: `status:'revoked'` + `$unset` de los tokens (no se borra el doc → histórico).

### Campos nuevos en `CalendarEvent` (todos OPCIONALES)
```
googleEventId?:     string   // id del evento en Google (relación clara evento↔Google)
googleSyncStatus?:  'pending' | 'synced' | 'error' | 'skipped' | 'deleting' | 'deleted'  // ausente = nunca tocó Google
googleSyncError?:   string   // último error de sync de ESTE evento
googleLastSyncedAt?: Date
```
Sin migración de datos (campos opcionales nuevos). Docs viejos siguen funcionando (ausencia = 'skipped').

### Anti-duplicados (idempotencia)
Google Calendar permite **client-generated event IDs** (base32hex, 5–1024 chars). Se usa el `uid` del
`CalendarEvent` (normalizado a base32hex) como el `id` del evento en Google. Así:
- Crear dos veces el mismo evento → Google devuelve 409 (ya existe) → se trata como "ya sincronizado"
  (se guarda `googleEventId`), nunca duplica.
- El worker es idempotente: si el evento ya tiene `googleEventId`, la op de create se degrada a patch.

## Endpoints (prefix `/api/calendar/google`, todos auth del propio usuario)
- `GET  /google/status` → `{ connected, email, calendarId, lastSyncedAt, status, error }` (NUNCA tokens).
- `GET  /google/connect` → `{ url }` con la URL de consentimiento OAuth (incluye `state` anti-CSRF firmado).
- `GET  /google/callback?code&state` → intercambia el code, cifra y guarda tokens, redirige al calendario.
- `POST /google/disconnect` → revoca en Google + soft-delete de la conexión.
- `POST /calendar/events/:id/resync` → reencola la sync de un evento en error (reintento manual).
- (interno) el CRUD existente `POST/PATCH/DELETE /api/calendar/:id` gatilla el encolado de sync.

## Flujo OAuth 2.0
1. Usuario → "Conectar con Google" → front pide `GET /google/connect` → redirige a la URL de Google.
2. **Scope MÍNIMO:** `https://www.googleapis.com/auth/calendar.events` (gestionar eventos, NO el calendario
   completo ni contactos ni otra cosa). `access_type=offline` + `prompt=consent` para obtener refresh token.
3. `state` = token firmado (HMAC con JWT_SECRET, patrón `hmacToken` de crypto.ts) que ata el callback al
   usuario y evita CSRF. Se valida en el callback.
4. Callback: `exchangeCode` → access+refresh+expiry. Se **cifran** (crypto.ts) y se guardan en
   `GoogleConnection`. El refresh token **jamás** se serializa a ninguna respuesta.
5. **Refresh transparente:** antes de cada llamada a la API, si `tokenExpiresAt` pasó (o falta &lt;60s),
   `refreshAccessToken` renueva y re-cifra. Si el refresh falla (revocado/expirado) → `status:'error'`,
   la UI pide reconectar.
6. **Desconexión:** `POST /google/disconnect` → revoke en Google (`oauth2.revoke`) + soft-delete.

## Estrategia de sincronización (v1, Bifrost → Google)
- **Crear** evento manual → job `gcal-sync {op:'upsert', eventId}` → `insertEvent` con id derivado del uid
  → guarda `googleEventId`, `googleSyncStatus:'synced'`, `googleLastSyncedAt`.
- **Editar** → `op:'upsert'` → `patchEvent(googleEventId, ...)`; si no había googleEventId, `insert`.
- **Eliminar** (hard delete local hoy) → ANTES de borrar, encolar `op:'delete'` con el `googleEventId`
  → `deleteEvent` en Google. (Se guarda el googleEventId en el payload del job porque el doc local ya no
  estará.) Alternativa considerada: soft-cancel local (`status:'cancelled'`) para eventos con Google —
  se decide en B/C/D (el DELETE actual es hard; la tarea pide "soft delete cuando aplique").
- **Mapeo de campos**: summary/description/location/start/end/timezone/allDay/recurrenceRule/attendees →
  el equivalente del recurso `events` de Google (fechas RFC3339, `date` vs `dateTime` según allDay).
- **Idempotencia + estado**: cada job es reintentable; el `syncStatus`/`syncError` por evento se muestra
  en la UI; el reconciler barre `googleSyncStatus:'error'` cada N min y reintenta.

## §8 Bidireccionalidad (Google → Bifrost) — investigación y recomendación
**Opción A — Push Notifications (watch channels):** Google hace POST a un webhook cuando cambia el
calendario. Requiere **endpoint HTTPS público** + verificación de dominio + los canales **expiran** (máx
~1 mes) y hay que renovarlos. El POST sólo dice "algo cambió" → igual hay que hacer **incremental sync
con `syncToken`**. Riesgo alto en self-hosted (NAT/sin dominio), operación (renovación de canales),
complejidad.
**Opción B — Polling con `syncToken`:** un job periódico hace `events.list(syncToken)` incremental por
usuario conectado y aplica cambios. Sin infra pública, encaja con el reconciler existente. Costo: latencia
(cada N min) + cuota de API. Conflictos: last-write-wins o marca de conflicto.
**RECOMENDACIÓN:** **NO** implementar bidireccional en v1. Si se pide, ir por **Opción B (polling)** por el
modelo self-hosted; documentar resolución de conflictos y cuota. Proponer arquitectura detallada antes de
construir (fase 2 separada con su propio gate B/C/D).

## Seguridad
- Tokens cifrados AES-256-GCM (`crypto.ts`), refresh **nunca** en respuestas ni frontend.
- `GOOGLE_CLIENT_SECRET` como env/docker-secret (`_FILE`), o cifrado en SystemConfig (molde meet/settings).
- `state` firmado (anti-CSRF) atado al userId. Considerar PKCE (defensa extra).
- **Aislamiento:** toda query de `GoogleConnection`/sync scopeada por `userId`; un usuario sólo sincroniza
  SUS eventos (mismo patrón que `routes/calendar.ts`). El callback valida que el `state` sea del usuario.
- Scope mínimo (`calendar.events`). Logs con `redact` de tokens (logger ya redacta secretos).

## Observabilidad
- `counters` (metrics.ts): `gcal_sync_ok`, `gcal_sync_fail`, `gcal_token_refresh_fail`.
- Logs estructurados por job (pino) con userId + op + eventId (sin tokens).
- `googleSyncError` legible expuesto en la UI + botón "Reintentar".

## UI / UX (minimalista, alineado al sistema existente)
- Sidebar de `CalendarView.vue`: nueva `cal-section` "Google Calendar" con estado (Conectado como
  `email` / Desconectado / Error) + botón Conectar/Desconectar. Usa `AppIcon` + `theme.css`.
- Badge de estado de sync por evento (o un aviso si hay eventos en error + "Reintentar").
- Errores entendibles (token expirado → "Reconectá tu cuenta"; fallo de API → "Reintentar").
- Sin improvisar: respetar el sistema visual (Google Workspace-like) y los componentes existentes.

## Fases de implementación
- **G1** Modelo: `GoogleConnection` + campos en `CalendarEvent` + env `GOOGLE_*`.
- **G2** OAuth: `services/google/oauth.ts` + endpoints connect/callback/disconnect/status + cifrado tokens.
- **G3** Cliente + sync: `calendar-api.ts` + `sync.ts` + job `gcal-sync` en la cola + worker + reconciler.
- **G4** Enganche: extraer `services/calendar-events.ts`, delegar desde `routes/calendar.ts`, encolar sync.
- **G5** UI: sección de conexión + estado + reintento en `CalendarView`.
- **G6** Tests: unit (oauth refresh, sync idempotente, mapeo), integración (crear/editar/eliminar →
  Google mockeado), expiración/refresh de token, desconexión, errores (token inválido/permiso/API).

## Riesgos / decisiones para B/C/D
- **Elección de dep:** `googleapis`/`google-auth-library` (robusto, +peso) vs `fetch` directo (liviano,
  en el estilo del repo: SigV4/GitHub por fetch). Propongo `google-auth-library` sólo para OAuth + `fetch`
  para la REST API de eventos; alternativa: fetch puro para todo.
- **Hard vs soft delete** del evento local cuando tiene Google (la tarea pide soft cuando aplique).
- **Sync de eventos de booking** a Google (v1 sólo manuales; bookings = decisión).
- **Cuota / rate-limit** de la Google Calendar API (backoff ya en la cola).
- **TOCTOU/race:** dos ediciones concurrentes del mismo evento → el job idempotente (upsert) + `withLock`
  por `eventId` evita pisadas.

## §Hardening (obligatorio — cierra el gate B/D)

### OAuth (HIGH)
- **`state` de un solo uso, no predecible (H1).** NO `hmacToken(userId)` (determinístico). Formato:
  `state = base64url(nonce | userId | ts | HMAC(nonce|userId|ts))` con `nonce` aleatorio (16B). Se guarda
  el `nonce` en Redis con TTL 10 min (`SETEX`, patrón de la cola). Validación en callback: HMAC OK **y**
  `ts ≤ 10min` **y** `state.userId === request.user.userId` (usuario autenticado) **y** `nonce` presente en
  Redis (consumir/borrar → single-use). Cierra CSRF + confusión de cuentas.
- **PKCE obligatorio (H2).** `code_verifier` aleatorio → `code_challenge = S256(verifier)`; el verifier se
  guarda junto al nonce (Redis, TTL). No opcional.
- **Callback autenticado (MED8).** El endpoint `/google/callback` exige sesión (JWT); si el `state.userId`
  no coincide con el usuario logueado → 403. `redirect_uri` exacto (match con el registrado).

### Idempotencia / anti-duplicados (HIGH)
- **`googleEventId` derivado del `_id` del evento, no del `uid` (H3 + MED5).** El id de evento de Google
  debe ser base32hex (`[a-v0-9]`, 5–1024). El `uid` iCal puede traer mayúsculas/`-`/`:` → NO sirve directo,
  y dos accounts del mismo user podrían compartir uid (colisión). Se usa un id determinístico y único por
  evento: `gid = 'bif' + base32hex(sha256(String(event._id)))[0..40]`. Único (ObjectId) + formato válido →
  `insert` con id fijo es idempotente (409 = ya existe → tratar como sincronizado, guardar `googleEventId`).
- **jobId por evento (MED9).** El job se encola con `jobId = 'gcal:' + eventId` → una edición nueva
  **supersede** la pendiente (BullMQ dedup), evita pilas de syncs viejos del mismo evento.

### Delete sin huérfanos (HIGH4)
- El DELETE actual es hard. Para eventos con Google (`googleEventId` presente) el DELETE pasa a ser **SOFT
  con tombstone**: `status:'cancelled'` + `googleSyncStatus:'deleting'` (NO se borra el doc). Se encola el
  job de delete con el `googleEventId`. El worker borra en Google → al confirmar, marca `'deleted'` (el
  tombstone puede quedar o purgarse por un GC posterior). Si el enqueue/worker falla, el reconciler ve
  `'deleting'` y reintenta → **nunca queda un evento huérfano en Google** ni se pierde el borrado.
  (Eventos sin Google: hard delete como hoy.)

### Modelo / decisiones
- **Conexión POR USUARIO, no por account (MED5).** Un usuario Bifrost puede tener varias cuentas de correo,
  pero UNA identidad Google → una `GoogleConnection` por `userId`, calendario destino `primary`. El
  `googleEventId` deriva del `_id` (único global) → sin colisión entre accounts del mismo user.
- **`syncToken` opcional desde ya (LOW10).** `GoogleConnection.syncToken?: string` (para la fase 2 de
  polling bidireccional; en v1 no se usa) — forward-compatible sin costo.
- **env `GOOGLE_*` (MED6).** Agregar a `config/env.ts` (plantilla `LIVEKIT_*` opcional):
  `GOOGLE_CLIENT_ID?`, `GOOGLE_CLIENT_SECRET?` (+ `_FILE` docker-secret), `GOOGLE_REDIRECT_URI?`.
  Helper `googleConfigured()` → gate de la feature.

### Sync robusto
- **Worker re-verifica ownership (MED7, defensa en profundidad).** El job trae `eventId`+`userId`; el
  worker re-lee `CalendarEvent.findOne({_id, userId})` y la `GoogleConnection` del mismo `userId` — nunca
  cruza usuarios aunque el payload venga mal.
- **`withLock('gcal:'+eventId)` con timeout (LOW12).** Serializa ediciones concurrentes del mismo evento;
  timeout acotado (p.ej. 15s) para no colgar el worker si Google tarda; ante timeout → reintento por la cola.
- **Access token revocado ≠ refresh revocado.** Si una llamada da 401 → intentar refresh; si el refresh da
  `invalid_grant` → `status:'error'`, la UI pide reconectar (no reintentar en loop).

### UI / backfill (LOW11)
- Estados explícitos: **cargando** (spinner), **no disponible** (operador no configuró Google), **desconectado**
  (botón Conectar), **conectado** (email + últimos sync), **error** (mensaje + Reconectar/Reintentar).
- **Backfill:** v1 sincroniza eventos **de ahí en adelante** (al crear/editar). Los eventos previos NO se
  empujan automáticamente al conectar (evita una avalancha + sorpresas). Opción explícita "Sincronizar
  eventos existentes" = fase posterior / acción manual acotada. Documentado como limitación conocida.

## §Estado del gate
Arquitectura APROBADA (servicios Google desacoplados, cola+reconciler, cifrado reutilizado, feature-gate
self-hosted, recomendación bidireccional). Con §Hardening incorporado (state single-use+PKCE, googleEventId
por _id, delete con tombstone, conexión por-usuario, worker re-verifica ownership) se cierran los HIGH/MED
de D. Sugerido: re-check de D sobre v2 antes de G1.

---

## §As-built (implementación G1–G6) — desviaciones vs. el diseño y su justificación

Todo lo del diseño + §Hardening se implementó, con estos ajustes deliberados:

- **Callback PÚBLICO basado en `state`, NO autenticado por sesión (cambia MED8).** La cookie de sesión es
  `SameSite=strict` (`routes/auth.ts`), así que NO viaja en el redirect top-level cross-site que hace Google
  hacia `/callback`. Exigir sesión ahí rompería el flujo en producción. La identidad recae —como es el patrón
  OAuth estándar— en el `state`: firmado con HMAC (infalsificable), atado al `userId` que inició, con TTL 10min
  y **single-use** en Redis. Un atacante no puede fabricar un state para otra víctima ni reusar uno ajeno, así
  que se cierra CSRF/confusión de cuentas SIN la cookie. `consumeState()` devuelve el `userId` de confianza.
- **`googleEventId = 'bif' + sha256(String(_id)).hex` (afina la idempotencia HIGH).** Se deriva del `_id`
  (único, evita colisión multi-cuenta y normalización de `uid`), y se usa **hex** en vez de base32hex porque el
  hex `0-9a-f` ya cae dentro del regex válido de Google `[a-v0-9]{5,1024}` — mismo resultado, sin encoder extra.
- **Sync sólo de eventos MANUALES en v1.** Los bloques `source:'booking'` (agenda) NO se sincronizan todavía:
  evita tocar la lógica transaccional del booking. Follow-up documentado.
- **Backstop en el reconciler (nuevo pass 4).** Re-encola eventos `googleSyncStatus ∈ {pending,error,deleting}`
  más viejos que el grace — recupera enqueues perdidos (Redis caído) o reintentos agotados. Idempotente.
- **Sin endpoint `/resync` por-evento en v1.** El reconciler reintenta solo los errores por-evento; la UI
  "Reintentar" resuelve el error a nivel conexión (refresh revocado) reconectando. Simplicidad.
- **Tombstone oculto del GET.** El delete de un evento ya sincronizado deja `status:'cancelled' +
  googleSyncStatus:'deleting'`, excluido del `GET /calendar` (`$ne:'deleting'`), y el sync lo borra en Google y
  recién ahí elimina el doc local (sin huérfanos). Si el dueño ya no tiene Google, el tombstone se limpia local.
- **Config del operador (open source):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (+ `_FILE` docker-secret),
  `GOOGLE_REDIRECT_URI` (= `https://<host>/api/calendar/google/callback`). Sin ellas, la feature responde 503 y
  la UI oculta la sección. Scope mínimo `calendar.events`.

**Cobertura de tests:** `google-connection` (4, cifrado/unicidad/no-exposición), `oauth` (4, state single-use/
anti-forgería/PKCE), `connection` (5, refresh+lock/invalid_grant/disconnect), `sync` (4, upsert/tombstone/
skipped/error-retry), `google-calendar` endpoints (5, gate/401/callback-público/idempotencia). Suite existente
281/281 sin regresiones.
