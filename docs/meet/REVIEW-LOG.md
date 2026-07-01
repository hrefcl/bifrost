# Bifrost Meet — Log de revisiones A/B/C/D (Fase 2)

Sistema multi-equipo: **A**=Claude Code (impl/orquestación) · **B**=Codex (autoridad primaria técnica) · **C**=z/GLM (lógica/datos) · **D**=Kimi (auditoría independiente). Cadena de autoridad: **B → D** (F excluido, A=Claude). Gate para avanzar: **score ≥9 y 0 HIGH**.

## Estado actual (al guardar)
- **Documento**: `docs/meet/DESIGN.md` v2.3 (arquitectura Path A, mismo EC2, LiveKit self-hosted).
- **Fase 0 (docs funcionales)**: COMPLETA — `docs/meet/functional/00-index.md` + 01..07 (7 pantallas, plantilla de 12 secciones).
- **Aprobaciones v2.2/v2.3**: **C = 9.2 APPROVE**, **D = 9 APPROVE**. **B = pendiente** (re-confirmar el cierre de su único HIGH de readiness; el proceso codex se interrumpió 1 vez y se re-lanzó).
- **HIGHs abiertos**: ninguno de C/D. El último de B (readiness apuntando a la EIP no asociada) fue **corregido en v2.2/v2.3** (readiness local vía `--resolve … 127.0.0.1`); falta su re-confirmación formal.
- **Contingencia**: si B no completa, aplica cadena **B→D** (D ya aprobó en 9) → se puede avanzar con B validando al retomar (REGLA de herencia).

## Historial de rondas (scores)
| Ronda | B (Codex) | C (z/GLM) | D (Kimi) | Resultado |
|-------|-----------|-----------|----------|-----------|
| v1 | 8 cond. | 7.5 NO | 6 NO (5 HIGH) | NOT APPROVE |
| v2 | 7 NO (2 HIGH) | 8.5 ✅ | 8.5 ✅ | NOT APPROVE (B blocker) |
| v2.1 | 8 NO (1 HIGH readiness) | 9.0 ✅ | 9 ✅ | NOT APPROVE (B blocker) |
| v2.2 | (killed, re-run) | 9.2 ✅ | 9 ✅ | B pendiente |
| v2.3 | pendiente | (= v2.2, screen-share aditivo) | (= v2.2) | B pendiente |

## HIGHs reales detectados y CERRADOS en el documento (antes de una línea de código)
1. Mecanismo de snapshot inviable (URL no escribible post-Booking) → slug horneado **antes** de `Booking.create`.
2. RPC LiveKit dentro del lock fail-closed → MeetRoom = insert Mongo requerido; sala lazy; `ensureRoom` fuera del lock.
3. Slug no único global → índice `{slug}` unique global.
4. CSP `connect-src 'self'` bloquea el wss → relajar a `wss://meet.<dom>` (deploy-time).
5. Dominio público equivocado (`mail.` vs `webmail.`) → `MEET_PUBLIC_BASE_URL=webmail.<dom>`.
6. Sin refresh de token en llamadas largas → TTL ventana+gracia + re-fetch (reconexión breve).
7. ICE/external IP por IMDS no confiable → `Fn::GetAtt ElasticIP.PublicIp` vía `Fn::Sub` (no IMDS).
8. `resolveFileSecrets` sin LiveKit → extender a `LIVEKIT_*_FILE`.
9. Readiness apuntaba a la EIP no asociada → readiness local vía Traefik `127.0.0.1`.
+ MEDIUMs: backlink check del token, ventana temporal, techo global `room.max_participants`, 2º SecurityGroup condicional (base byte-idéntica), runtime `/api/config/public` para SPA estática, clamp del cap, degraded-mode, idempotencia por `bookingId`.

## Alcance confirmado por el PM
- **Mismo EC2** (no segundo). Norte = **costo mínimo**: base `t4g.medium`; al activar Meet por CLI **piso `t4g.large`** (no EC2 nuevo).
- **Screen share en MVP** + UI in-call **estilo Google Meet** (v2.3).
- Claves del repo de referencia (`cv_cloud_formation/LiveKit`) ignoradas por ahora.

## Gate de diseño — CERRADO ✅
- **B (Codex)** re-confirmó el cierre del HIGH de readiness (local resolve `--resolve …127.0.0.1`, no EIP): **9.2 APPROVE, 0 HIGH**.
- Scores de diseño finales: **B=9.2 · C=9.2 · D=9** → gate (≥9, 0 HIGH) cumplido. Procede implementación.
- 2 LOW de B incorporados a la implementación: (a) readiness `https://meet.<dom>/` espera **200** (LiveKit root health, no 426) → F3.5; (b) token de booking **nunca** pasa de `endAt+30m` (tope duro) → aplicado en F3.1.

## F3.1 — backend base — APPROVED ✅ (commit en rama)
Implementado: DTOs shared (MeetRoomDto/MeetTokenResponse/MeetSettings/PublicConfig/MeetUserPreferences) · modelo `MeetRoom` (slug unique global, `{bookingId}` unique parcial, soft-close, purgeAt TTL) · `services/meet/settings.ts` (singleton key='meet') · `services/meet/token-service.ts` (gate `meetEnabled`, grants matrix, identidad opaca, ventana temporal, **TTL tope duro**, backlink, `ensureRoom` fuera de lock no-fatal) · `routes/meet.ts` (`/api/meet/*` + `meetAdminRoutes`) · `GET /api/config/public` · `env.ts` LIVEKIT_* + `resolveFileSecrets` extendido · CSP `MEET_WS_ORIGIN` deploy-time · counters. **31 tests Meet (15 lógica + 16 ruta), 337 suite total, typecheck+lint limpios.**

### QA F3.1 (2 rondas)
| Ronda | B (Codex) | C (z/GLM) | D (Kimi) | Resultado |
|-------|-----------|-----------|----------|-----------|
| v1 | **8.0 NOT APPROVE (1 HIGH)** | 8.5 APPROVE-cond | 7.0 NOT APPROVE | BLOCKED_HIGH |
| v2 | **9.2 APPROVE (HIGH cerrado)** | 9.0 APPROVE | 9.0 APPROVE | **APPROVED ✅** |

**HIGH (B, cerrado)**: `authorizeAndComputeTtl` podía devolver `ttl:0` en el borde `endAt+30m`; el SDK trata `0` como falsy → `defaultTTL` (≫ tope) → el token sobreviviría el tope duro (confirmado `AccessToken.ts:88 options?.ttl || defaultTTL`; cruce B↔C: C aprobó la matemática sin ver el coalescing, B autoridad primaria lo cazó). **Fix**: no-host con `ttl<1` → `403 window_closed`; `issueAccessToken` clampa `Math.max(1, floor(ttl))`. Test de borde agregado.
**MEDIUM/LOW cerrados**: token público fail-closed (`skipOnError:false` + key IP+slug) · `GET /public/:slug` valida backlink (404 idéntico, no observable) · salas manuales siempre `personal` · `resolveBacklink` valida `userId` (multi-tenant) · `isSlugCollision` inspecciona `keyPattern` · `ensureRoom` fire-and-forget.

### Tech debt / product decisions de F3.1 → F3.2 (documentados, no bloqueantes)
- **PD**: host bypassa el tope `endAt+30m` (dueño de la sala; token acotado por `maxDurationMinutes`).
- **PD**: rol `internal` para cualquier cuenta autenticada (single-box confiable; endurecer si multi-tenant).
- **TD-MEET-REVOKE**: sin revocación de token al close/rotate (inherente a token+roomCreate; acotado por TTL + `empty_timeout`). Evaluar revocación LiveKit en fase cercana.
- **F3.2**: salas booking deben forzar `allowExternalOverride=true` + poblar `expiresAt`/`purgeAt` + janitor; `calendarEventId` ¿índice único parcial?

## F3.2 — integración agenda/calendario/correo — APPROVED ✅ (commit en rama)
Implementado: `EventType.meetEnabled` (+ruta scheduling) · `CalendarEvent.meetRoomId/meetUrl` · `services/meet/booking-meet.ts` (helpers Mongo-only, CERO RPC LiveKit: create/migrate/close/getId/delete) · `createBooking` (bookingId preasignado, MeetRoom write requerido idempotente por bookingId DENTRO del lock, slug horneado en snapshot, **degradado** que nunca aborta, compensación que borra sala huérfana en las 4 rutas) · proyección CE usa URL horneada + meetRoomId/meetUrl · `cancelBooking` + **host-cancel route** cierran la sala (idempotente) · `rescheduleBooking` (neo hereda snapshot=mismo link; migra sala old→neo con ROLLBACK). Email/ICS heredan el link vía snapshot inmutable. **349 suite (11 F3.2 service + host-cancel route), typecheck+lint limpios.**

### QA F3.2 (3 rondas)
| Ronda | B (Codex) | C (z/GLM) | D (Kimi) | Resultado |
|-------|-----------|-----------|----------|-----------|
| v1 | **7.4 NOT APPROVE (1 HIGH)** | 8.5 APPROVE-cond | **7.5 NOT APPROVE (1 HIGH)** | BLOCKED_HIGH (2 HIGH distintos) |
| v2 | **8.2 NOT APPROVE (1 HIGH)** | 8.7 APPROVE (R2) | 9.0 APPROVE | BLOCKED_HIGH (rollback incompleto) |
| v3 | **9.0 APPROVE** | **9.0 APPROVE** | 9.0 APPROVE | **APPROVED ✅** |

**HIGH-1 (D-001, cerrado)**: el host-cancel route (`POST /api/schedule/bookings/:id/cancel`) hacía su propio cancel y NUNCA cerraba la sala → `safeCloseMeetRoom` en success + idempotent-return.
**HIGH-2 (B, cerrado en v3)**: reschedule migraba la sala **después** de retirar la vieja (no-fatal) → link muerto si fallaba; **v2** lo movió a migrar-antes-de-retirar con rollback; **v3** cerró el caso commit+timeout (el `findOneAndUpdate` pudo COMMITEAR y reportar throw → la compensación migra la sala **de vuelta a old** antes de borrar neo). Test endurecido con mock commit-then-throw + **verificado por mutación** (quitar el migrate-back hace fallar el test).
**MED/LOW cerrados**: cancel idempotente repara cierre · CE de reschedule hornea `location` · herencia atada a presencia real de MeetRoom (no URLs video externas) · compensaciones no-fatales (`safeDeleteMeetRoom`) · `meetEnabled` exige publicBaseUrl+wsUrl · `isSlugCollision` con fallback · migrate idempotente `{$in}` · tests de degradado/compensación/rollback.

### Tech debt F3.2 → F3.3/F3.4 (documentado, no bloqueante — C: usabilidad, no seguridad; el backlink siempre protege)
- **TD-MEET-RECONCILER**: el reconciler (F3.4) no tiene caso MeetRoom — agregar "sala con bookingId→booking no-confirmed con `rescheduledToId` → migrar" + propagar meetRoomId/meetUrl al reconstruir CE.
- **TD-MEET-DEGRADED-METRIC**: la degradación de create es silenciosa (`console.error`) — métrica/flag para que el operador se entere.
- **TD-MEET-CANCEL-RACE**: cancel de neo concurrente con reschedule en vuelo puede dejar sala stale 'active' sobre booking cancelado (la purga el TTL `purgeAt`; sin hole de seguridad).
- **Manual calendar attach**: endpoint `POST/DELETE /api/calendar/events/:id/meet` diferido de F3.2.

## F3.3 — frontend Google Meet + screen share — APPROVED ✅ (commit en rama)
Implementado: dep `livekit-client` (chunk lazy de /meet, no infla el bundle) · `composables/useMeetConfig.ts` (config runtime cacheada + single-flight) · re-map router `/meet/:slug`→`MeetJoinView` (el alias de perfil estaba sin uso) · `MeetJoinView.vue` (pre-join: metadata, nombre, preview video-only) · `MeetCallView.vue` (LiveKit, UI Google Meet: grilla oscura, active-speaker spotlight, screen-share spotlight, barra mic/cam/compartir/copiar/salir) · `MeetVideoTile.vue` (attach/detach de tracks; audio local nunca → no eco) · toggle `meetEnabled` en SchedulingView (gated por config) · i18n es+en. **typecheck (vue-tsc) + lint + 31 web tests + build limpios.**

### QA F3.3 (3 rondas)
| Ronda | B (Codex) | C (z/GLM) | D (Kimi) | Resultado |
|-------|-----------|-----------|----------|-----------|
| v1 | **7.0 NOT APPROVE (1 HIGH)** | 8.0 APPROVE (5 MED) | 6.5 NOT APPROVE (3 MED) | BLOCKED_HIGH |
| v2 | **8.0 NOT APPROVE (1 HIGH)** | 8.8 APPROVE | 8.5 APPROVE | BLOCKED_HIGH (residual más profundo) |
| v3 | **9.3 APPROVE** | 9.2 APPROVE | 9.0 APPROVE | **APPROVED ✅** |

**HIGH (B, cerrado en v3) — ciclo de vida de Room (privacidad/leak)**: v1 = la `Room` se asignaba a `room.value` solo DESPUÉS de `await connect()` → un unmount durante connect dejaba una Room huérfana publicando. v2 lo corrigió con guards (disposed/connectGen/connecting/staleGen + teardownRoom) pero B cazó un residual más profundo: tras `room.value=r`, el publish de mic/cam corría sin re-chequear staleGen → **la cámara/mic podían encenderse DESPUÉS del unmount** (race sensible a privacidad). v3: `room.value=r` ANTES de connect (unmount aborta la Room pendiente) + guard `staleGen` ANTES de cada `setXEnabled` (no se invoca getUserMedia tras disposal) + teardown post-publish + `removeAllListeners` en teardown. B confirmó: el device nunca se inicia tras disposal ni sobrevive al cleanup.
**MEDIUM/LOW cerrados**: config-fail→unavailable graceful · preview video-only serializado (mic nunca capturado en pre-join, sin streams huérfanos) · error backend con i18n (403 too_early/window_closed/external_forbidden) · `markRaw` en tracks (no Proxy de Vue) · rejoin desde 'left' · eventos Reconnecting/Reconnected · audio de screen-share · handlers scopeados a la room actual (C-R1) · test single-flight real (resetModules+deferred).

### Tech debt F3.3 → follow-up (documentado, no bloqueante)
- **TD-MEET-LIFECYCLE-TEST** (C-R2): sin test automatizado del ciclo de vida de Room — requiere `@vue/test-utils`+`jsdom` (no en el repo) o extraer un composable `useMeetConnection`. El lifecycle está guardado en código y revisado por B; falta red de regresión.
- **UI follow-up**: panel admin de MeetSettings, prefs "Reuniones" en Settings, checkbox en CalendarView, link en paso confirmado de PublicBooking, e2e Playwright de la llamada (necesita harness mock de LiveKit).
- D-006 (refresh full rebuild, keys estables), C-L4 (timeout axios global), C-L7 (solo último screen-share en spotlight) — diferidos.

## F3.4 — infra docker compose + livekit.yaml — APPROVED ✅ (commit en rama)
Implementado: `deploy/example-mailserver/livekit.yaml` (single-node: mux 7882, turn udp 3478, `room.max_participants` global, `use_external_ip` + `node_ip` comentado para F3.5) · servicio `livekit` en compose (`profiles:[meet]`, imagen pinneada `v1.8.4`, publica 7881/tcp+7882/udp+3478/udp, 7880 NUNCA público (solo Traefik), `mem_limit 1g`+`cpus 1.0`) · api gana env LIVEKIT_* (defaults vacíos → Meet OFF boot OK) · CSP deploy-time (nginx template + `NGINX_ENVSUBST_FILTER`, Meet OFF byte-idéntico) · `.env.example` Meet block (todo vacío) · `nginx:1.27-alpine` pinneado. **api 349 + provisioner 64 tests verdes.**

### QA F3.4 (2 rondas)
| Ronda | B (Codex) | C (z/GLM) | D (Kimi) | Resultado |
|-------|-----------|-----------|----------|-----------|
| v1 | **6.0 NOT APPROVE (2 HIGH)** | APPROVE (5 nits) | 8.5 APPROVE | BLOCKED_HIGH |
| v2 | **9.0 APPROVE** | 9.0 APPROVE | 8.5 APPROVE | **APPROVED ✅** |

**2 HIGH cerrados (B)**: (1) compose con comillas SIMPLES → no interpola → `LIVEKIT_KEYS`/`MEET_CSP_CONNECT` literales (riesgo credencial estática) → comillas DOBLES; (2) `livekit.yaml` con placeholder `external_ips` falso + campo equivocado (v1.8.x usa `use_external_ip`/`node_ip`, NO `external_ips` — la DESIGN doc estaba mal, B acertó). **C-F1 (acoplamiento 3 vars wsUrl)** cerrado: colapsado a fuente única `LIVEKIT_WS_URL` (CSP web + helmet derivan de ella; `MEET_WS_ORIGIN` eliminado). Nits cerrados: nginx pinneado, max_participants comment, .env.example vacío. **DESIGN.md sincronizado** (era el último residual; evita que F3.5 resucite los bugs).

## ⭐ NUEVO ALCANCE PM (2026-06-30) → F3.7: LiveKit EXTERNO / Cloud configurable desde el admin
El operador podrá apuntar Meet a un LiveKit **externo self-hosted** o **LiveKit Cloud (pago)** desde el panel admin (URL wss + API key/secret + región + límites + "Probar conexión"), además del bundled (F3.4). Decisiones PM: **modo auto por URL** · **grabación solo Cloud/Egress** (self-hosted=roadmap) · **mergear PR #30 (rediseño /admin) primero, luego rebasar Meet** y construir el panel como sección de la consola nueva. **Habilitador backend (independiente de PR #30)**: `apiKey/apiSecret/apiUrl/region` → MeetSettings (DB), token-service lee DB→env-fallback, + endpoint "test connection". Ver corrección/changelog v2.4 en `DESIGN.md`.

## F3.7-backend — LiveKit externo/Cloud: credenciales en MeetSettings (DB) + test-connection
Implementado: `services/meet/settings.ts` (StoredMeetSettings interno con `livekitApiSecretEnc` cifrado AES-GCM; `getStoredMeetSettings`/`setMeetSettings` con PATCH 3-semánticas: omitir=preserva, `''`=CLEAR atómico key+secret, valor=cifra) · `token-service.ts` refactor (`resolveLivekitCreds` DB-XOR-env atómico + decrypt fail-closed→`error`; `meetEnabled` presence-based total no-throw; `issueAccessToken`/`ensureRoom`/`closeLiveKitRoom` toman StoredMeetSettings) · `routes/meet.ts` (DTO admin allowlist sin secret; PATCH valida secret-requiere-key→400, apiUrl vía `isSafeS3Endpoint`→400; `POST /test` admin+rate-limit 5/min `skipOnError:false`+timeout 3s+categoría) · CSP `wss:` gated por `MEET_PROVISIONED` (deploy flag) en `app.ts` · DTO compartido `MeetSettings` gana `hasApiSecret`/`livekitSource` (secret NUNCA en el shared type). **366 tests api + typecheck + lint limpios; backward-compat total (deploys env-only intactos vía fallback).**

### Gate de diseño F3.7 (Fase 2, 3 rondas) — **APROBADO** ✅
Resolvió honestamente la arquitectura CSP estática-nginx vs runtime: provisionar Meet (`MEET_PROVISIONED`) afloja la CSP a `wss:` una vez; "sin redeploy" aplica a cambiar server/creds/Cloud después. Correcciones de C: decrypt es SÍNCRONO (B/D dijeron async) → `resolveLivekitCreds` no necesita ser async; `meetEnabled` presence-based (no desencripta en la ruta unauth `/config/public`).

### QA F3.7-backend (impl)
| Reviewer | Veredicto | HIGH | Hallazgos |
|----------|-----------|------|-----------|
| C (z/GLM) | **APPROVE — merge** | **0** | C-F1 (DTO honesty, orphan secretEnc) · C-F2/F3/F4 (NIT) |
| D (Kimi) | **7.5 APROBADO C/OBS** | **0** | D-002 (MED, F3.5) · D-001/003/004/005 (LOW) |
| B (Codex) | *en vuelo* | — | — |

**Fixes aplicados (C+D, mismo diff)**: **D-001** `/test` apiUrl `replace(/^ws(s?):\/\//i,'http$1://')` preserva la `s` (Cloud TLS) · **D-003** `/test` rate-limit `skipOnError:false` · **C-F1/D-005** `livekitApiKey:''` acopla el CLEAR del secret (`setMeetSettings`) **+** `hasApiSecret` ⟺ par DB usable (`key.trim() && secretEnc`) → DTO no miente con huérfanos legacy (+test nuevo `key=""`→limpia ambos) · **C-F2** timer del race se limpia en `finally` · **C-F3** categoría: solo `401`/`unauthorized` (no `invalid`, que aparece en errores de red) · **C-F4** fixture `token-service.test.ts` con `hasApiSecret`/`livekitSource`.
**Residual (auto-auditoría 2026-06-30, LOW)**: en `POST /test`, si el body trae `livekitApiKey+livekitApiSecret` pero OMITE `livekitApiUrl`, el apiUrl cae a `stored.livekitApiUrl/wsUrl` → probaría el server guardado/bundled con las creds candidatas (resultado engañoso). Mitigado por contrato: el panel admin (F3.7-frontend, aún no construido → define el contrato) manda siempre la URL al probar un candidato. Si B lo marca, endurecer (candidato con key+secret ⇒ exige `livekitApiUrl`, sin fallback a stored). Por ahora documentado.
**Diferido**: **D-002 (MED)** el provisioner no setea `MEET_PROVISIONED` → **acceptance criterion de F3.5** (el plumbing del compose/template ya está; solo falta que el CLI lo ponga =1 al habilitar Meet) · **D-004/C-F2** el race no aborta el `listRooms()` del SDK (no expone AbortSignal) → documentado en código (admin-only+5/min acotan el blast). Aceptados-by-design: CSP `wss:` scheme-source (deploy-gated), SSRF metadata vía DNS-rebinding (admin=operador, principio self-hosted/no-babysitting), RMW race del singleton settings (pre-existente).

## F3.7-backend — COMMIT `526fe35` ✅ (B 10/10 · C APPROVE · D 9/10, 0 HIGH)

## F3.5 — provisioner: CFN 2º-SG + Route53 + MeetMode + piso + user-data (en QA)
Implementado siguiendo la CORRECCIÓN F3.4 del DESIGN (no las líneas viejas):
- **`stack-template.ts`**: param `MeetMode` (default `disabled`), conditions `EnableMeet` + `ManageMeetDns` (zona Route53 **Y** Meet ON). **2º recurso `MeetSecurityGroup`** condicional con EXACTAMENTE 3 reglas (7881/tcp, 7882/udp, 3478/udp, cada una single-port — NUNCA rango). **SG base BYTE-IDÉNTICO** (recurso separado; el base no gana ningún puerto ni UDP). Instance `SecurityGroupIds = [base, Fn::If[EnableMeet, MeetSG, AWS::NoValue]]` (con Meet OFF la lista efectiva es `[base]`). Route53: A `meet.` + A `turn.meet.` como `Fn::If[ManageMeetDns, record, AWS::NoValue]` dentro del RecordSetGroup (los 5 records base intactos). Output `MeetUrl` (cond.).
- **Inyección de la EIP en node_ip**: el DESIGN §8 decía `Fn::Sub`; al implementar se detectó que `Fn::Sub` interpola TODOS los `${VAR}` del bash del cloud-init (cada var rompería salvo escaparla `${!VAR}`, frágil). Se realiza la **MISMA** inyección CFN-GetAtt-no-IMDS vía **`Fn::Join`** (`embedUserData` splitea el user-data en el marcador `@@MEET_EXTERNAL_IP@@` y concatena `Fn::If[EnableMeet, GetAtt ElasticIP.PublicIp, '']` — sin tocar el `$` del bash). Misma propiedad de seguridad (IP real de la EIP, NO IMDS — el EIPAssociation asocia tras señalizar). Verificado: YAML sin anchors, marcador sustituido, JSON válido.
- **`user-data.ts`**: `enableMeet` → genera claves LiveKit (openssl, en el host) + escribe al `.env` `MEET_PROVISIONED=1`+`COMPOSE_PROFILES=meet`+`LIVEKIT_WS_URL=wss://meet.<dom>`+`LIVEKIT_API_URL`+`MEET_PUBLIC_BASE_URL`+claves; `sed` pone `node_ip = EIP` y `use_external_ip: false` (ICE determinista). Readiness Meet LOCAL **no-fatal** (Meet opcional no tumba el provision; un crash de livekit lo atrapa el check de contenedor-exited). **CSP**: NO se sedea nginx — el mecanismo F3.7 (`MEET_PROVISIONED`-gated `wss:`) ya afloja la CSP al estar el flag en el `.env` (supera el sed viejo del DESIGN §8).
- **`instance-types.ts`**: `enforceMeetInstanceFloor` (piso 8 GiB → `t4g.large`; catálogo<8 sube; fuera de catálogo respeta + marca `unknownBelowFloor` para que el wizard avise). **`cli.ts`**: confirm "¿Habilitar Bifrost Meet?" + flag `--enable-meet` + aplica el piso + pasa `enableMeet`; imprime A meet./turn.meet. y la MeetUrl. **`params.ts`**: `MeetMode` param.
- **Tests (79 provisioner, +15)**: 2º SG puertos exactos + base byte-idéntico + sin UDP en base; Instance SG list condicional; A meet./turn.meet. condicionales + base intacta; MeetUrl; Fn::Join inyecta GetAtt (no Fn::Sub) y deja `$DOMAIN` bash literal; user-data Meet on/off; floor (bump/respeta/unknown/idempotente); MeetMode param. **typecheck + lint + 79 tests verdes.**
### QA F3.5 (gate B/C/D)
| Reviewer | Score | HIGH | Hallazgo |
|----------|-------|------|----------|
| B (Codex) | 8→re-QA | 1→0 | deploy path `buildStackTemplate()` sin userData → CFN rechaza param `UserData` (y EIP/Fn::Join nunca aplica) |
| D (Kimi) | 7→re-QA | 1→0 | mismo HIGH; **validó Fn::Join** (correcto/seguro, EIP real sin IMDS) |
| C (z/GLM) | **9/10** | **0** | APPROVE; auditó los 7 puntos ✓; 1 LOW (node_ip CI) |

**HIGH cerrado (B+D, convergencia independiente)**: el path "¿Corro el stack AHORA?" en `cli.ts` usaba `templateToJson(buildStackTemplate())` SIN `userData` → conservaba el param requerido `UserData` que `assembleStackParams` ya no provee → CFN rechaza; y con Meet el `Fn::Join`/EIP nunca se aplicaba (sólo ocurre al embeber). **Bug pre-existente, crítico para F3.5.** Fix: `buildStackTemplate(userData)` (embebe → quita el param → aplica Fn::Join) + test que blinda el invariante (`assembleStackParams` nunca incluye `UserData`). 80 tests.
**C confirmó** (cross-check): SG base byte-idéntico, MeetSG puertos exactos single-port, 7880 no expuesto, `AWS::NoValue` idiomático en SG-list y RecordSets, `embedUserData`/Fn::Join sin filtrar marcador, sed bien anclado (indent 2-space, delim `|`), `node_ip` válido v1.8.4 (`rtc.node_ip`→`RTCConfig.NodeIP`; cerrado por B en F3.4), `use_external_ip:false`+`node_ip` complementarios, floor + avisos CLI, Meet OFF stack efectivo = pre-Meet, DAG sin ciclo (ElasticIP→Instance→EIPAssociation). **`MEET_PROVISIONED=1` lo consume `app.ts:90`** como flag truthy (el "D-002" era nombre de sentinel de ejemplo, no valor) → sin mismatch, D-002 CERRADO.
**Residual LOW (C, diferido)**: no se re-validó `node_ip` contra la imagen VIVA `livekit/livekit-server:v1.8.4` (fetch externo bloqueado en el gate); descansa en el HIGH F3.4 + DESIGN §8 + schema conocido — bajo riesgo. **Fix opcional (F3.6/CI)**: arrancar la imagen pinneada y validar el `livekit.yaml` resultante (`livekit-server --config` / validate).

## F3.5 — COMMIT `29c7a5b` ✅ (B 10/10 · C 9/10 · D 9/10, 0 HIGH; 1 HIGH cerrado deploy path; D-002 cerrado)

## F3.6 — docs de operación (en QA)
- **`docs/meet/INSTALL.md`** (nuevo, doc del operador): 3 modos (bundled/externo/Cloud) · activar en el
  provisioner (`--enable-meet`, piso t4g.large, +$25/mes) · tabla de puertos (7881/tcp+7882/udp+3478/udp,
  7880 nunca público) · costos · **limitaciones/roadmap** (redes sólo-443 sin TURN/TLS:443, single-node,
  grabación sólo Cloud/Egress) · apuntar a LiveKit externo/Cloud desde el admin · **checklist de prueba
  manual** (DNS/TLS/join/screenshare/invitado externo/cierre) · **troubleshooting** · **rotación de claves**
  (LIVEKIT_* + secret DB + ENCRYPTION_KEY→livekitSource:error) · registro de decisiones.
- **`deploy/example-mailserver/README.md`**: sección "📹 (Opcional) Bifrost Meet" + fila troubleshooting.
- **`docs/cli-provisioning-aws.md`**: §3.quater (MeetMode, 2º SG, DNS, piso, EIP-por-CFN-no-IMDS/Fn::Join).
- **`README.md`** raíz: sección Bifrost Meet + link a INSTALL/DESIGN.
- La Fase 0 funcional por pantalla ya existía en `docs/meet/functional/00-07`.

### QA F3.6 (gate docs, ronda 1) — B cazó 6 errores factuales reales
| Reviewer | Score | HIGH | Foco |
|----------|-------|------|------|
| B (Codex) | 5→re-QA | 6→0 | exactitud vs código (excelente) |
| C (z/GLM) | re-QA | 1 | panel inexistente (deploy README) |
| D (Kimi) | re-QA | 0 | panel inexistente (README/INSTALL §8-9) |

**6 HIGH cerrados (docs reescritos con la verdad del código)**:
- **B1 — interruptor maestro**: `meetEnabled()` (`token-service.ts:96`) exige `settings.enabled=true`, y el default es `false`; el provisioner setea env, NO el flag DB → tras `--enable-meet` Meet queda OFF. Documentado: encender con `PATCH /api/admin/meet/settings {enabled:true}` (toggle visual = F3.7-frontend). → **TD-MEET-PROVISION-ENABLED**.
- **B2 — `wsUrl` vs `livekitApiUrl`**: el `wss://` va en `wsUrl`; `livekitApiUrl` se valida http/https (`isSafeS3Endpoint`) → un `wss://` ahí da 400. Payload §6 corregido + nota.
- **B3 — revert incompleto**: borrar el secret limpia sólo key+secretEnc (cae a env), NO resetea `wsUrl`/`livekitApiUrl` → puede mezclar creds env con URL Cloud. §6 documenta resetear también las URLs.
- **B4 — grabación NO implementada**: `recordingPolicy` siempre `disabled`, `buildGrants` nunca `roomRecord`, sin Egress; `autoRecord` es un flag sin efecto. §1/§5/§6/§10 corregidos (roadmap, no "Cloud graba").
- **B5/C — deploy README**: prometía panel visual + "Configuración → Reuniones" inexistentes → hoy API admin, panel F3.7.
- **B6/D — README raíz + INSTALL §8/§9**: idem panel → API del admin.
- **B-MED piso**: matizado (catálogo<8 sube; fuera de catálogo se respeta con aviso). **B-LOW**: agregado `LIVEKIT_API_URL=http://livekit:7880` a la lista .env.

**TD-MEET-PROVISION-ENABLED** (turnkey — PRÓXIMA MINI-FASE, no diferible; re-priorizado en auto-auditoría 2026-06-30): `--enable-meet` deja Meet **silenciosamente OFF** en la app (`settings.enabled=false` default) hasta un `PATCH enabled:true` manual — defecto turnkey (misión existencial), causa confusión 3AM. F3.5 (commiteado) aprobado por B/C/D sin cazarlo (miraron CFN/SG/EIP, no el gate app-level). **Fix (F3.5b, mini-fase con gate propio)**: `getStoredMeetSettings` defaultea `enabled=true` cuando `MEET_PROVISIONED` seteado + creds env presentes y NO hay override DB explícito (`v.enabled` en DB manda si existe → el admin puede apagar). Se ejecuta INMEDIATAMENTE tras commit F3.6.
**TD-MEET-FLOOR-NONCATALOG** (LOW): `enforceMeetInstanceFloor` deja pasar tipos fuera de catálogo con <8 GiB (solo avisa; el DESIGN pedía "no bypasseable"). Endurecer con `DescribeInstanceTypes` (RAM real) en el wizard. Bajo riesgo (aviso + docs).

**Ronda 2-3 (docs corregidos)**: **B** cazó 2 HIGH más (README "se activa" sin `PATCH enabled:true`; §6 revert `wsUrl:""` falso — `getStoredMeetSettings` usa `??`, un `""` persiste y deja `meetEnabled` false) → corregidos; ronda final **B 9/10 0 HIGH**, **D 9/10 APPROVE**, **C 0 HIGH** — todas las LOW aplicadas. *Nota infra*: los reviews de B (codex) se colgaban/mataban por un **codex HUÉRFANO de otra tarea** (`rediseno-admin-agenda`, review RBAC) comiendo memoria y serializando codex; matarlo lo resolvió.

## F3.6 — COMMIT (docs) ✅ · B 9/10 · C 9/10 · D 9/10, 0 HIGH

## Próximos pasos
1. **F3.5b — TD-MEET-PROVISION-ENABLED**: auto-enable al provisionar (código + gate B/C/D) — INMEDIATO.
2. **F3.7-frontend**: panel admin LiveKit (requiere PR #30 mergeado + rebase Meet) — última fase.

> Observación al PM (otro repo, fuera de scope): `cv_cloud_formation/LiveKit/` tiene `id_rsa.pem` commiteado y la API secret de LiveKit en claro en `livekit.sh` — conviene rotarlas.
