# Bifrost Meet — Documento de Diseño Consolidado · v2.3 (Fase 2)

**Estado:** IN_REVIEW_DOC (v2.3 tras B/C/D ronda 3)

> **⚠️ CORRECCIÓN F3.4 (autoritativa — sobre-escribe las menciones viejas de §3/§8).** La implementación
> de infra (commit F3.4, B=9.0/C=9.0/D=8.5) corrigió 2 puntos que el texto original de §3/§8/§10 describe
> mal. **F3.5 debe seguir ESTO, no las líneas viejas:**
> - **IP externa de LiveKit**: NO existe `rtc.external_ips` en livekit v1.8.x. Se usa **`rtc.use_external_ip: true`**
>   (autodetección STUN, válida) + un **`rtc.node_ip: <EIP>`** opcional (comentado en `livekit.yaml`) que F3.5/
>   user-data descomenta+sustituye con la Elastic IP (vía CFN `GetAtt ElasticIP.PublicIp`, NO IMDS). Verificar
>   el campo contra la imagen pinneada.
> - **CSP / origen wss**: NO se usa `MEET_WS_ORIGIN`. Hay **una sola fuente: `LIVEKIT_WS_URL`** — de ella derivan
>   la CSP del SPA (nginx, `MEET_CSP_CONNECT="${LIVEKIT_WS_URL:+ }${LIVEKIT_WS_URL:-}"`, comillas DOBLES en compose
>   porque las simples NO interpolan) **y** el `connect-src` de helmet (api). El provisioner siembra `settings.wsUrl ← LIVEKIT_WS_URL`.
> - Imagen pinneada concreta: `livekit/livekit-server:v1.8.4`; `nginx:1.27-alpine` en `Dockerfile.web`.
>
> **Changelog v2.3→v2.4 (alcance PM, 2026-06-30):** **LiveKit EXTERNO / Cloud configurable desde el admin.**
> Además del LiveKit bundled (mismo EC2, F3.4), el operador podrá apuntar a un LiveKit **externo self-hosted** o
> **LiveKit Cloud (pago)** desde el panel admin (mockup): URL wss + API key/secret + región + límites + "Probar
> conexión". Decisiones PM: (1) **modo auto por URL** (sin selector explícito; si apunta al bundled→self-hosted,
> si a otro host/*.livekit.cloud→externo). (2) **Grabación = solo Cloud/Egress** (toggle guardado; self-hosted=roadmap),
> región/resolución informativas. (3) **Coordinación: mergear PR #30 (rediseño /admin Google-Workspace) primero,
> luego rebasar Meet** y construir el panel como SECCIÓN de la consola nueva. **Habilitador backend (independiente
> de PR #30): mover `apiKey/apiSecret/apiUrl/region` a MeetSettings (DB), token-service lee DB→env-fallback, +
> endpoint "test connection".** → nueva fase F3.7 (diseño Fase 2 + B/C/D antes de implementar).

> **Changelog v2.2→v2.3** (alcance PM): **pantalla compartida (screen share) entra al MVP** + **UX in-call estilo Google Meet** (grilla oscura, active-speaker spotlight, barra de control inferior con mic/cam/compartir-pantalla/salir). El grant `canPublish` ya habilita screen share (track `screen_share`) → sin permiso backend extra. Cambio aditivo de frontend (F3.3); no afecta arquitectura ni HIGHs cerrados.

> **Changelog v2.1→v2.2** (cierra 1 HIGH nuevo de B + polish B/C): **readiness de user-data LOCAL/interno** (`curl --resolve meet.<dom>:443:127.0.0.1 -k` → Traefik local, NO la EIP que aún no está asociada; verificación pública post-deploy) · **backlink check en token** (404 si el `Booking`/`CalendarEvent` de respaldo falta/cancelado — orphan slug por crash) · **degraded-mode cubre CUALQUIER error de `MeetRoom.create`** (nunca aborta booking, nunca `video` sin URL); "atómico"→saga bajo lock con compensación · **TTL/expiry alineados a +30m**; `expiresAt` se hace cumplir pasivamente (LiveKit `empty_timeout` + janitor de status) · **`ensureRoom` clampa `maxParticipants` por-sala ≤ techo global** (+test).

> **Changelog v2→v2.1** (cierra 2 HIGH de B + MEDIUMs B/C/D): **MeetRoom = write Mongo REQUERIDO y atómico** (bookingId preasignado + retry E11000) — el endpoint de token depende de la fila, ya no es best-effort · **`external_ips` inyectado por CFN `!GetAtt ElasticIP.PublicIp` vía `Fn::Sub`** (NO IMDS — el EIPAssociation ocurre tras user-data) · **gate de ventana temporal** en token (`startAt−early ≤ now ≤ endAt+grace`) · **default global `room.max_participants` en livekit.yaml** (techo que heredan salas auto-creadas, cierra el bypass del cap) · **CSP deploy-time** (templado en user-data + helmet por env, no DB-runtime) · proyección CalendarEvent usa la URL horneada · redirect `/meet/:userSlug`→`/u/`.
**Tipo:** FEATURE opcional, modular, desactivable. **Rama:** `feat/bifrost-meet-livekit` (worktree desde `origin/main` @ d2166f7).
**Equipo A:** Claude Code · Cadena autoridad: B (codex) → D (kimi) · C (z/GLM) valida lógica.

> **Changelog v1→v2** (resuelve 8 HIGH + MEDIUM de B/C/D): slug global único · MeetRoom = insert Mongo idempotente por bookingId, **cero RPC LiveKit en el lock**, sala **lazy** al primer join · slug horneado en snapshot **antes** de `Booking.create` (link inmutable, reschedule lo hereda) · CSP `connect-src wss://meet.<dom>` · dominio público `webmail.<dom>` · TTL token = ventana+gracia + re-emisión · `rtc.external_ips:[EIP]` · `resolveFileSecrets` LIVEKIT · endpoint `/api/config/public` runtime para SPA estático · **2º SecurityGroup condicional** (base byte-idéntico) · límites cgroup en livekit · `ensureRoom` maxParticipants fuera del lock · pin de imagen · piso `t4g.large` al activar Meet.

---

## 1. Problema / objetivo
Añadir **Bifrost Meet**: videollamadas self-hosted con **LiveKit**, integradas a calendario, agenda pública y correo. **Opcional** (instalación funciona igual con Meet OFF), **modular**, costo mínimo, **mismo EC2** (no segundo EC2, no Caddy, no SaaS).

## 2. Hechos base CONFIRMADOS (sobre código real)
- Monorepo pnpm `packages/{api,shared,web,provisioner}`. API=Fastify+Mongoose8+Redis; Web=Vue3+Vite+Tailwind+Pinia+axios (SPA **estática prebuilt**, imagen genérica `ghcr.io/hrefcl/bifrost/web`).
- **Single-tenant, aislamiento por `userId`**. Auth=hook global JWT, `requiresAuth:true` default; público=`config:{requiresAuth:false}`; user=`request.user.userId`.
- Modelos Mongoose `interface/Schema/serialize*()→DTO @webmail6/shared`; rutas manuales en `app.ts` con prefijo.
- **Agenda**: `EventType.location.type ∈ {in_person,phone,video,custom}`; `Booking`=fuente de verdad con `snapshot` **inmutable** (`Booking.ts:54-65`); `createBooking()` corre bajo `withLock(lock:booking:host:<userId>)` **fail-closed, TTL 120s, hoy solo writes Mongo**; orden: idempotencia→revalida slot→`Booking.create`→backstop→`CalendarEvent.create`→link; **enqueue email DESPUÉS del lock** (`booking-service.ts:327-338`). El worker re-lee `snapshot.location.value` al enviar (`email.ts:46`).
- **Reschedule crea Booking+CalendarEvent NUEVOS**, hereda snapshot, marca viejo `rescheduled` (`:375-545`). Cancel = `cancelled`, idempotente.
- Idempotencia booking: `Idempotency-Key`/`auto:...` hasheado, índice único parcial (`Booking.ts:132-135`).
- **Email**: `sendBookingEmail(bookingId, kind)` desde SMTP del host + ICS (`buildIcs`).
- **Config**: `src/config/env.ts` Zod + `resolveFileSecrets()` (hoy solo `JWT_SECRET_FILE`, `ENCRYPTION_KEY_FILE`).
- **Prod stack real = `deploy/example-mailserver/docker-compose.yml`** (Traefik+mailserver+mongo+redis+api+web, red `mailnet`). Traefik flags+labels, certresolver `letsencrypt` HTTP-01, `DOCKER_MIN_API_VERSION=1.24` load-bearing. SPA servida en **`webmail.<dom>`** (router `bifrost`); `mail.<dom>`=mailserver.
- **CSP existente**: `nginx.conf` y `helmet` definen `connect-src 'self'` → bloquea wss cross-origin (HIGH si no se relaja).
- **CFN**: `stack-template.ts` `buildStackTemplate` (JS object). SG = **un recurso, ingress array literal** `MAIL_PORTS=[25,80,443,143,465,587,993]` TCP /0 + 22 SshCidr, **cero UDP**, exportado `MAIL_INGRESS_PORTS` (tests lo asertan). Conditions whole-resource/`Fn::If`-propiedad (**no por-regla**). Route53 RecordSetGroup (mail., webmail., MX, SPF, DMARC). InstanceType default `t4g.large`; catálogo: medium(4GB,$24)/large(8GB,$49)/xlarge(16GB,$98).
- **CLI** `bifrost-provision` (`@inquirer/prompts` v7, argv switch: default=install, `destroy`). `user-data.ts` `sed` reescribe `example.com`→dominio, secrets en box `openssl rand -hex 32`.
- Router web: `/meet/:userSlug` **y** `/u/:userSlug` ambos → `PublicProfileView` hoy; `meta.guestOk`=público.
- Rate-limit global 100/min `skipOnError:true` + override por ruta. Metrics in-memory (sin prom-client).

### LiveKit CONFIRMADO (docs + referencia `cv_cloud_formation/LiveKit`)
Imagen `livekit/livekit-server` (**pinnear**, no `:latest`); config `livekit.yaml`. Puertos: 7880 TCP signaling (tras proxy), 7881 TCP ICE/TCP, 7882 UDP mux (single-node), TURN embebido 3478/udp(+STUN), 5349/tcp(TLS). `rtc.use_external_ip` + `external_ips`. **LiveKit auto-crea la sala al primer join** con token válido (grant `roomCreate`) → no requiere RPC previo. SDKs: server `livekit-server-sdk` (`AccessToken` grants+ttl, `RoomServiceClient`), client `livekit-client` (vanilla en Vue). Referencia usa Caddy+host-net+SG-abierto → **NO replicar**.

## 3. Decisión arquitectónica (Path A — endosada por B/C/D)
```
EC2 Bifrost · deploy/example-mailserver (red mailnet)
  traefik(:80/:443 LE) ── router meet.<dom> ─wss─▶ livekit:7880    (signaling, TLS por Traefik)
  livekit (profile: meet, mem/cpu limits) ── publica 7881/tcp, 7882/udp, 3478/udp
  api · web(SPA webmail.<dom>) · mongo · redis · mailserver  (intactos con Meet OFF)
Route53 (cond. MeetMode): + A meet.<dom> + A turn.meet.<dom> → ElasticIP
```
- livekit en **`mailnet` bridge** (no host-net): Traefik lo encuentra por DNS; media por puertos publicados (mux 1 UDP + 1 TCP → SG trivial). Host-net = alternativa documentada si hay NAT issues.
- **`profiles:["meet"]`**: Meet OFF ⇒ nunca arranca ⇒ base intacta. Cloud-init `COMPOSE_PROFILES=meet` si habilitado.
- **TURN embebido** (no coturn). `turn.enabled:true, udp_port:3478` (+STUN). **TURN/TLS 5349 diferido** (§9).
- LiveKit **sin redis** (single-node). **Límites cgroup** (`mem_limit`, `cpus`) para no privar a mailserver/mongo. **`room.max_participants` global** en `livekit.yaml` (= `MeetSettings.maxParticipants` default) → toda sala auto-creada hereda el techo aunque un externo entre primero (cierra el bypass del cap; `ensureRoom` solo refina por-sala).
- **`rtc.external_ips:[<ElasticIP>]`** explícito, inyectado por **CFN** (`!GetAtt ElasticIP.PublicIp` vía `Fn::Sub` en el user-data base64) — **NO IMDS**: el `EIPAssociation` es un recurso aparte que asocia DESPUÉS de que user-data corre/señala, así que IMDS devolvería la IP efímera de launch (B-H2). Caveat: en path de VPC existente sin EIP gestionada, el operador provee la IP pública estable por parámetro.

## 4. Modelo de datos
**`MeetRoom`** (`packages/api/src/models/MeetRoom.ts`), `userId`-scoped, soft-lifecycle:

| campo | tipo | nota |
|---|---|---|
| `userId` | ObjectId idx | host |
| `slug` | string **UNIQUE GLOBAL** | `randomBytes(16).base64url`, no enumerable (C-H3) |
| `name` | string | nombre visible |
| `mode` | 'per_event' \| 'personal' | efímera por evento vs persistente |
| `status` | 'active' \| 'closed' | transición suave (no hard-delete) |
| `source` | 'manual' \| 'calendar' \| 'booking' | |
| `calendarEventId?` / `bookingId?` | ObjectId | enlace |
| `maxParticipants` | number | de MeetSettings (enforce en LiveKit, §5) |
| `allowExternalOverride?` | boolean | salas booking fuerzan true (C-M5) |
| `expiresAt?` / `purgeAt?` | Date | per_event expira; **purgeAt** para GC largo (no TTL sobre expiresAt — L1) |

Índices: **`{slug}` unique global**, `{userId, status}` (no único), `{bookingId}` **unique parcial** (idempotencia), `{calendarEventId}`, `{purgeAt}` TTL opcional largo.
- `CalendarEvent`: +`meetRoomId?`, +`meetUrl?` (URL pública con slug; no secreto).
- `EventType`: +`meetEnabled: boolean` (default false).
- `UserPreferences` (shared): `meet?: { autoCreateOnEvent, displayName?, roomMode:'per_event'|'personal', defaultInviteMessage? }`.
- `MeetSettings` singleton (SystemConfig key `meet`): `{ enabled, wsUrl, publicBaseUrl, turnDomain, maxParticipants, maxDurationMinutes, allowExternal, branding?, auditEnabled, recordingPolicy:'disabled' }`.

DTOs nuevos `@webmail6/shared`: `MeetRoomDto`, `MeetTokenResponse`, `MeetSettings`, `PublicConfig`, `UserPreferences.meet`.

## 5. API backend (`packages/api/src/routes/meet.ts`, prefix `/api/meet`) + config público

| método | ruta | auth | nota |
|---|---|---|---|
| GET | `/api/config/public` | **público** | runtime config SPA: `{meetEnabled, livekitWsUrl, meetPublicBaseUrl}` (D-M4) |
| POST | `/api/meet/rooms` | JWT | crea sala del `userId` (manual/personal) |
| GET | `/api/meet/rooms/:slug` | JWT host | metadata propia |
| POST | `/api/meet/rooms/:slug/rotate` | JWT host | regenera slug (salas personales) — invalida links viejos (C-M4) |
| DELETE | `/api/meet/rooms/:slug` | JWT host | `status:closed` + `RoomServiceClient.deleteRoom` best-effort (desconecta activos) |
| GET | `/api/meet/public/:slug` | **público** | metadata mínima; **404 idéntico** si no existe/closed; rate-limit IP+slug (D-M5) |
| POST | `/api/meet/public/:slug/token` | **público** | AccessToken invitado; rate-limit estricto **fail-closed**; gate `allowExternal` por-sala |
| POST | `/api/meet/rooms/:slug/token` | JWT | token host/interno |
| POST | `/api/calendar/events/:id/meet` | JWT | adjunta sala (idempotente) |
| DELETE | `/api/calendar/events/:id/meet` | JWT | desadjunta |
| GET/PATCH | `/api/admin/meet/settings` | JWT admin | MeetSettings |

- **Token SIEMPRE backend** (`livekit-server-sdk` `AccessToken`, `LIVEKIT_API_KEY/SECRET`). **Identidad de participante OPACA y única** (`guest-<randomBytes(8)>`, no del display name; el name es metadata) (B/D). Grants: host=`roomJoin+roomAdmin+canPublish+canSubscribe+canPublishData`; interno=`roomJoin+canPublish+canSubscribe+canPublishData`; externo=igual interno **sin** roomAdmin; **roomCreate** en el primer join para auto-crear (L2). **Nunca** roomList/roomRecord. **`canPublish` habilita cámara, micrófono y pantalla compartida** (track source `screen_share`/`screen_share_audio`) → screen share es parte del MVP para los 3 roles, sin permiso extra.
- **Gate de ventana temporal** (B-MED) para salas `booking`/`calendar`: el endpoint de token rechaza (403) fuera de `startAt − earlyJoinMin(15m) ≤ now ≤ endAt + graceMin(30m)` → un link no puede mintear tokens días antes ni crear/abusar la sala fuera de horario. Salas `personal` sin ventana.
- **TTL token** (D-H3) = `clamp(eventEnd + 30min grace − now, 15min, maxDurationMinutes_hard_cap)` (grace alineado a `MeetRoom.expiresAt = endAt+30m` — C); personal = `min(maxDurationMinutes, 12h)`. El cliente puede **re-fetch** el token (mismo endpoint) antes del expiry → reuniones largas **se re-autentican con reconexión breve** (LiveKit no refresca el token de una conexión en vuelo; re-fetch ⇒ reconnect — L1). `expiresAt` se hace cumplir pasivamente: LiveKit `empty_timeout` cierra salas vacías + janitor async pasa `status:closed` (sin sweeper agresivo en MVP).
- **El endpoint de token REQUIERE la fila `MeetRoom`** (404 si no existe) **y backlink válido** (B-MED/C): para salas `source:booking|calendar`, 404 si el `Booking`/`CalendarEvent` de respaldo no existe o está `cancelled` → un slug huérfano (crash entre insert de MeetRoom y `Booking.create`) **nunca** puede mintear tokens. Sin fila no hay autorización posible y el link del email quedaría muerto (B-H1) — por eso la sala es write Mongo requerido (saga bajo lock + compensación, §6).
- **`ensureRoom` clampa** `maxParticipants` por-sala a `min(MeetSettings.maxParticipants, room.max_participants global)` (D-caveat) → nunca excede el techo de `livekit.yaml`. Test explícito.
- **`ensureRoom(slug,{maxParticipants,emptyTimeout})`** vía `RoomServiceClient` **FUERA de todo lock**, en el endpoint de token, idempotente, **timeout corto + try/catch no-fatal** (si LiveKit lento/caído, el token igual se emite; la sala se auto-crea con defaults) (C-H2, C-M2). Esto fija el cap de participantes sin acoplar booking a video.
- **Gate global** `meetEnabled()`: si `MeetSettings.enabled=false` o `LIVEKIT_*` ausentes ⇒ endpoints `200 {disabled:true}`/404 (sin romper).
- **Rate-limit** por-ruta: rooms `max:10/min`, token público `max:20/min` key IP+slug; metadata público `max:60/min`. Token público fail-closed (no `skipOnError`).
- **Auditoría** (`auditEnabled`): log estructurado en room.create y token.issue (slug, userId|guest-opaco, ip, rol, ts). Joins reales = roadmap webhooks (L4).
- **Multi-tenant**: toda query host filtra `userId`; público solo por **slug global único**; nunca expone otros tenants.

## 6. Integración agenda/calendario/correo (resuelve C-H1/H2/M1)
- **Booking con `EventType.meetEnabled`** — dentro de `createBooking()`, **DENTRO del lock** (todo Mongo, **cero RPC LiveKit** → compatible con C-H2; el lock ya contiene `Booking.create`+`CalendarEvent.create`, un insert más es del mismo costo):
  0. **idempotencia primero** (orden existente preservado, B): el pre-check `Booking.findOne(idemFilter)` corre **antes** de todo lo de Meet; en replay retorna el booking existente (y su `MeetRoom` por `bookingId`) → nunca genera sala nueva.
  1. **preasignar** `bookingId = new ObjectId()` y generar `slug` (`randomBytes(16).base64url`) → `meetUrl = ${publicBaseUrl}/meet/${slug}`.
  2. **crear `MeetRoom` como write REQUERIDO** `{ _id, userId, slug(unique global), bookingId, source:'booking', mode:'per_event', status:'active', maxParticipants, expiresAt:endAt+30m }` — **retry en colisión de slug E11000** (≤3 intentos, regenerando slug). Es atómico con la reserva del slug: el endpoint de token siempre encuentra la fila (B-H1). Idempotente en replay: si ya existe `MeetRoom` por `bookingId`, se reusa su slug/meetUrl.
  3. `Booking.create({ _id: bookingId, snapshot.location: {type:'video', value: meetUrl}, ... })` → **URL horneada en el snapshot inmutable** (worker de email la lee tal cual; link nunca cambia).
  4. **Compensación**: el path existente de compensating-delete ante fallo posterior elimina también la `MeetRoom` huérfana (mismo `bookingId`). **Degradado** (email sin bloque de reunión, nunca `snapshot.location.type='video'` sin URL): el `try/catch` cubre **CUALQUIER** error de `MeetRoom.create` (no solo E11000), **nunca aborta el booking** — si la sala no se pudo crear, el snapshot NO marca `video`, se loggea + alerta al host. (Nota: misma DB que Booking, así que un outage golpea a ambos; el intent "fallo sala no aborta booking" se refleja en el código + test.)
  5. NO se llama a LiveKit en este flujo. La sala LiveKit se auto-crea al primer join (token con `roomCreate`); `ensureRoom(maxParticipants)` corre fuera del lock (§5) y el techo global de `livekit.yaml` protege aunque falle.
- **Proyección CalendarEvent** (B-LOW): en `booking-service.ts:291` la proyección hoy usa `eventType.location.value`; para bookings con Meet debe usar la **URL horneada del snapshot** (`snapshot.location.value`) → `event.meetUrl`/`meetRoomId`. Así el evento, el email y el ICS comparten exactamente la misma URL.
- **Reschedule** (C-M1): el nuevo Booking hereda el snapshot → **mismo `meetUrl` preservado automáticamente**. Migrar `MeetRoom.bookingId`→nuevo booking, `CalendarEvent.meetRoomId`→nuevo evento, recalcular `expiresAt = newEndAt+30m`. **Cancel**: `MeetRoom.status:closed` + deleteRoom best-effort.
- **Calendario manual**: `addMeet=true` → `POST /calendar/events/:id/meet` crea `MeetRoom(source:calendar, mode=userPref.roomMode)`, set `event.meetRoomId/meetUrl`. URL en email/ICS del evento.
- **Correo/ICS**: `sendBookingEmail`/invitación añaden bloque "Unirse: `${publicBaseUrl}/meet/<slug>`" en HTML/text + `URL`/`LOCATION` en VEVENT. **`publicBaseUrl` default `https://webmail.<dom>`** (D-H2; SPA real). Doble URL: signaling `wss://meet.<dom>` (interno SDK) vs join `https://webmail.<dom>/meet/<slug>` (público).

## 7. Frontend (`packages/web`)
- Dep `livekit-client`. **Boot**: store carga `GET /api/config/public` → `meetEnabled`/`livekitWsUrl`/`meetPublicBaseUrl` (no `import.meta.env`; imagen estática genérica) (D-M4).
- **Ruta pública** `/meet/:slug` (`meta.guestOk`) → `views/public/MeetJoinView.vue` (pre-join: pide nombre si externo, preview cam/mic, seleccionar dispositivos) → monta **`MeetCallView.vue`** (`livekit-client` `Room.connect(livekitWsUrl, token)`). **UX estilo Google Meet (MVP)**:
  - **Layout**: tema oscuro full-screen; grilla de tiles de video con **active-speaker spotlight** (el que habla o la pantalla compartida ocupa el tile principal; resto en miniaturas). Etiqueta de nombre + indicador de mute por tile.
  - **Barra de control inferior**: toggle **micrófono**, toggle **cámara**, **COMPARTIR PANTALLA** (`localParticipant.setScreenShareEnabled(true)` → `getDisplayMedia`; al activar, su track `screen_share` pasa a spotlight para todos), **copiar link**, **salir** (botón rojo hangup), contador de participantes.
  - Render del track `screen_share` (de cualquier participante) priorizado en el spotlight. Errores claros (permiso denegado de cam/mic/pantalla, sala llena, token expirado→re-fetch).
  - **Re-mapear** `/meet/:userSlug`→`/u/:userSlug` (grep links hardcoded + redirect; `/u/` ya sirve perfil — L5).
- **CalendarView**: checkbox "Agregar Bifrost Meet" (gated `meetEnabled`); link en modal detalle.
- **SchedulingView**: toggle "Incluir Bifrost Meet" (set `meetEnabled`) en sección Location del event-type.
- **PublicBookingView**: paso "confirmed" muestra el meet-link del DTO.
- **SettingsView**: sección "Reuniones" (NAV) → prefs `meet` vía `PATCH /auth/me/preferences`.
- **AdminView** + `components/admin/AdminMeetPanel.vue` (clon `AdminSchedulingPanel`): tab `meet` → enable/disable, dominio/wsUrl, maxParticipants, maxDuration, allowExternal, branding.
- i18n: namespace `meet:` en `es.ts`/`en.ts`. Iconos `video`/`mic`/`micOff` en `AppIcon.vue`.
- **Token nunca en frontend**; solo recibe el AccessToken efímero.

## 8. Infra / provisioning
- **`deploy/example-mailserver/docker-compose.yml`**: servicio `livekit` (`profiles:["meet"]`, red `mailnet`, **imagen pinneada** `livekit/livekit-server:v1.8.x`, labels Traefik `Host(meet.example.com)`→7880, publica `7881/tcp 7882/udp 3478/udp`, monta `./livekit.yaml`+secrets `livekit_api_*`, `mem_limit`/`cpus` límites). `livekit.yaml` plantilla (mux 7882, **`external_ips:[${EIP}]`** inyectado por CFN, **`room.max_participants` global** como techo, sin redis, turn udp-only).
- **CSP deploy-time** (D-H1/B-MED): la SPA es estática (nginx no reacciona a `MeetSettings` en DB; helmet se registra en boot). Solución **deploy-time, no runtime**: cuando el perfil Meet se despliega, `user-data` añade `wss://meet.<dom> https://meet.<dom>` al `connect-src` de `nginx.conf` (mismo mecanismo `sed`/envsubst que ya reescribe `example.com`) **y** el API lee `MEET_WS_ORIGIN` (env) para sumar el origen al `connect-src` de helmet. Meet OFF ⇒ CSP idéntico a hoy. E2E: handshake `wss://meet.<dom>` permitido ON / sin cambios OFF.
- **`stack-template.ts`**: Condition `MeetMode` (default disabled). **2º recurso `MeetSecurityGroup` condicional** (TCP 7881, UDP 7882, UDP 3478) — el SG base queda **byte-idéntico** (C-M6); se asocia al EC2 vía lista condicional. Route53: A `meet.${Domain}`+A `turn.meet.${Domain}` (cond.). **UserData**: `{'Fn::Base64': {'Fn::Sub': [userData, {MeetExternalIp: {'Fn::If':['MeetMode', {'Fn::GetAtt':['ElasticIP','PublicIp']}, '']}}]}}` → inyecta la EIP real (B-H2). Output `MeetUrl`. Param `MeetMode`. Tests `__tests__/*` actualizados (incl. aserción base SG sin cambios + EIP inyectada).
- **`cli.ts`**: `confirm("¿Habilitar Bifrost Meet (LiveKit self-hosted)? [y/N]")` + flag `--enable-meet` → `assembleStackParams` set `MeetMode`.
- **Piso instancia con Meet** (PM): `enforceMeetInstanceFloor(type)` en `catalog/instance-types.ts` (`MEET_INSTANCE_FLOOR='t4g.large'`, memGiB<8→bump) — aviso en wizard + reforzado en params/preflight (no bypasseable). Base sigue mínima; Meet +~$25/mo en el **mismo** EC2.
- **`user-data.ts`**: si Meet → generar `LIVEKIT_API_KEY/SECRET` (openssl), escribir `./secrets/livekit_api_*.txt`, **`external_ips` se sustituye por CFN (`${MeetExternalIp}` ← `!GetAtt ElasticIP.PublicIp`), NO IMDS**, añadir meet origin al CSP de nginx, `export COMPOSE_PROFILES=meet`. **Readiness LOCAL** (B-NEW-HIGH): `curl -k --resolve meet.<dom>:443:127.0.0.1 https://meet.<dom>/` (Traefik local → livekit:7880, 200/426) — **NO** apunta a la EIP (que se asocia DESPUÉS de que user-data señala; el mismo patrón que el readiness de webmail). Verificación pública (`https://meet.<dom>` vía DNS) queda como check **post-deploy** en el CLI/outputs, no gatea `cfn-signal`. `sed` ya reescribe meet./turn.meet.
- **`.env.example`**: bloque `# Bifrost Meet (opcional)`: `MEET_ENABLED`, `LIVEKIT_WS_URL`, `MEET_PUBLIC_BASE_URL`, `LIVEKIT_API_KEY(_FILE)`, `LIVEKIT_API_SECRET(_FILE)`.
- **`env.ts`**: LIVEKIT_* opcionales en Zod; **extender `resolveFileSecrets`** con `LIVEKIT_API_KEY_FILE`/`LIVEKIT_API_SECRET_FILE` (D-H5).

## 9. Seguridad
- **Puertos mínimos** (2º SG cond.): +7881/tcp, +7882/udp, +3478/udp sobre 22/80/443. NUNCA 1-65535. 7880 jamás público.
- **PRODUCT DECISION — TURN/TLS 5349 diferido**: no abre 5349. Cobertura honesta: **wss/443 es solo signaling**; media requiere UDP (7882/3478) o TURN/TCP (7881). Hueco real = redes que **solo** abren 443/TCP (algunas corporativas) → esos invitados externos podrían no conectar. **Fast-follow crítico post-MVP** (1ª limitación, roadmap TURN/TLS:443 vía L4/SNI passthrough+NLB/2ª IP). Trade-off aceptado por Equipo A. (B/C/D: MEDIUM, no HIGH.)
- Tokens: identidad opaca, por sala+participante, expiración corta + re-emisión, secret nunca expuesto.
- Slugs `randomBytes(16).base64url`, **únicos globales**, salas no enumerables, 404 idéntico.
- Rate-limit creación/token (token público fail-closed); cap participantes en LiveKit (`ensureRoom`) anti-DoS de recursos.
- Roles host/interno/externo con grants diferenciados (sin roomAdmin a externos).
- Multi-tenant: `userId` en todo; público por slug global.
- Auditoría create/issue; secrets docker `*_FILE`.
- STUN/TURN 3478/0 = superficie reflection (estándar; LiveKit mitiga; observar abuso — L8).

## 10. Plan por fases (Fase 3)
- **F3.1** shared+backend base: DTOs, `MeetRoom`, `meet.ts`+`/api/config/public`, token service (grants/ttl/identidad opaca), `ensureRoom` fuera de lock, gate, env+resolveFileSecrets. Tests: grants matrix, gate, multi-tenant, slug global, allowExternal, 404 idéntico, rate-limit.
- **F3.2** integración: campos CalendarEvent/EventType/UserPreferences, hook en `createBooking` (slug antes de Booking, upsert idempotente por bookingId, cero RPC en lock, degradado), reschedule/cancel migración, email/ICS link. Tests booking+meet (idempotencia, replay, reschedule preserva link, cancel cierra).
- **F3.3** frontend: dep, config público en boot, rutas+MeetJoin/MeetCall, checkbox/toggle/settings/admin panel, i18n, re-map `/meet/:userSlug`. Tests unit + playwright join smoke (mock LiveKit).
- **F3.4** infra: servicio livekit+profile+livekit.yaml+límites+CSP+.env.example. `docker compose config` válido Meet on/off.
- **F3.5** provisioner: CFN 2º-SG+Route53+output+MeetMode, piso instancia, CLI prompt/flag, user-data secrets+IMDS+readiness, tests (base SG byte-idéntico, puertos meet, floor).
- **F3.6** docs: **Fase 0 funcional por pantalla** + instalación/puertos/costos/troubleshooting/limitaciones/roadmap + checklist pruebas manuales + informe de decisiones.

Cada fase: implementar → B+C+D review → score ≥9 y 0 HIGH → siguiente.

## 11. Regresion Map (revisa B antes de F3.1)
| Componente | Dependencia | Riesgo | Validación |
|---|---|---|---|
| `app.ts` registro rutas + `/api/config/public` | nueva ruta pública | LOW | supertest 404/health/config |
| **`createBooking` (slug pre-Booking, upsert idempotente, NO RPC en lock)** | escribe snapshot+MeetRoom | **HIGH** | tests concurrencia/idempotencia verdes; assert **cero llamada LiveKit dentro del lock**; replay no duplica sala (`{bookingId}` unique); fallo sala no aborta booking |
| `snapshot.location`↔worker email | URL horneada inmutable | **HIGH** | test: email contiene link = snapshot.value; reschedule preserva |
| reschedule/cancel | migra meetRoomId/bookingId, expiresAt | **MEDIUM** | test migración + cancel cierra + deleteRoom best-effort |
| **slug único global** | namespace público | **HIGH** | índice `{slug}` unique; test colisión cross-user rechazada |
| **CSP nginx+helmet** | wss meet | **HIGH** | E2E handshake `wss://meet.<dom>`; Meet OFF ⇒ CSP sin cambios |
| **`resolveFileSecrets` LIVEKIT** | boot con `_FILE` | **HIGH** | test boot lee key; sin LIVEKIT (Meet off) boot OK |
| **token grants/ttl/identidad opaca/allowExternal** | seguridad | **HIGH** | matriz grants; externo sin roomAdmin; allowExternal=false→403 (salvo booking); ttl correcto; re-emisión |
| `ensureRoom` fuera de lock | cap participantes | MEDIUM | maxParticipants aplicado; LiveKit caído ⇒ token igual emitido |
| `CalendarEvent/EventType/UserPreferences` schema | +campos opcionales | LOW | serialize* compat, typecheck cross-pkg |
| `env.ts` Zod | +LIVEKIT_* opcionales | LOW | boot sin LIVEKIT OK |
| **2º SG condicional + Route53** | infra | **MEDIUM** | `__tests__`: base SG **byte-idéntico**; MeetMode on ⇒ puertos meet; records meet/turn |
| compose `livekit` profile+límites+pin | servicio | MEDIUM | `docker compose config` on/off; imagen pinneada; mem_limit presente |
| `external_ips` IMDS | ICE | **MEDIUM** | livekit.yaml válido; ICE manual gather |
| CLI/user-data/floor | provisioning | MEDIUM | install sin --enable-meet intacto; floor fuerza large; readiness meet |
| runtime config SPA | imagen genérica | MEDIUM | SPA sin rebuild lee wsUrl |
| router `/meet/:userSlug`→`/u/` | re-map | LOW-MED | perfil accesible en `/u/`; grep links |

## 12. Rollback
Backward compatible: campos nuevos opcionales, Meet OFF default. Revert = `git revert` rama; sin migraciones destructivas. `MeetMode=disabled` ⇒ infra (incl. SG base) byte-idéntica. Despliegue malo: readiness meet falla ⇒ quitar profile, resto sigue.

## 13. Observabilidad
Logs: room.create, token.issue (rol, guest-opaco, ip). Counters `meet_rooms_created`, `meet_tokens_issued` (`lib/metrics.ts`, in-memory single-node — documentar reset on restart, L6). Éxito: 200 en token público. Falla temprana: 5xx token / livekit unreachable / readiness meet fail.

## 14. Limitaciones conocidas (MVP)
1. **Sin TURN/TLS:443** (redes solo-443 → fracción de invitados externos puede fallar) — fast-follow crítico.
2. **Screen share básico SÍ está en MVP** (UI estilo Google Meet). Fuera de MVP: grabación/transcripción/chat/pantalla-compartida-avanzada (anotaciones/multi-share simultáneo)/salas-de-espera/moderación/webhooks (joins reales no auditados sin webhooks).
3. Single-node LiveKit (sin clustering); métricas in-memory.
4. EC2 compartido: presupuesto concreto de salas/participantes concurrentes a documentar (límites cgroup protegen mailserver).

## 15. Roadmap futuro
Grabación, transcripción, resumen IA, chat in-call, **pantalla compartida avanzada (anotaciones / multi-share simultáneo / spotlight manual)**, salas de espera, moderación, **webhooks LiveKit (join/leave→auditoría real)**, métricas calidad, **TURN/TLS:443 passthrough**, multi-nodo (redis), mobile. (Screen share básico ya está en MVP.)
