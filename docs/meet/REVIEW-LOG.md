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

## Próximos pasos
1. **F3.4** infra: servicio `livekit` en compose (profile meet, mailnet, imagen pinneada, límites mem/cpu), `livekit.yaml`, CSP deploy-time, `.env.example`.
2. F3.5 provisioner (CFN 2º SG + Route53 + piso instancia + user-data) · F3.6 docs.

> Observación al PM (otro repo, fuera de scope): `cv_cloud_formation/LiveKit/` tiene `id_rsa.pem` commiteado y la API secret de LiveKit en claro en `livekit.sh` — conviene rotarlas.
