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

## Próximos pasos
1. **F3.2** integración agenda/calendario/correo (slug pre-Booking, MeetRoom write requerido idempotente por bookingId, CERO RPC en lock, degradado, reschedule/cancel, email/ICS link).
2. F3.3 frontend (Google Meet + screen share) · F3.4 infra · F3.5 provisioner · F3.6 docs.

> Observación al PM (otro repo, fuera de scope): `cv_cloud_formation/LiveKit/` tiene `id_rsa.pem` commiteado y la API secret de LiveKit en claro en `livekit.sh` — conviene rotarlas.
