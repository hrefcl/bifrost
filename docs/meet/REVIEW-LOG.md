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

## Próximos pasos (próxima sesión)
1. Confirmar/cerrar gate con B (re-lanzar `codex exec` sobre `docs/meet/DESIGN.md` si hace falta; o aplicar herencia B→D).
2. **F3.1** backend base (modelo MeetRoom, rutas `/api/meet` + `/api/config/public`, token service, gate, env+resolveFileSecrets). Tests vitest. QA B/C/D.
3. F3.2 integración · F3.3 frontend (Google Meet + screen share) · F3.4 infra · F3.5 provisioner · F3.6 docs.
- Tasks #1–#8 registradas en el sistema de tareas de la sesión.

> Observación al PM (otro repo, fuera de scope): `cv_cloud_formation/LiveKit/` tiene `id_rsa.pem` commiteado y la API secret de LiveKit en claro en `livekit.sh` — conviene rotarlas.
