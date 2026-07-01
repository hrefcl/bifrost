# Bifrost Meet — estado del proceso (2026-07-01)

Videollamadas self-hosted (LiveKit) integradas al webmail, la agenda y el correo. **Opcional/modular**,
mismo EC2, sin SaaS. Este documento resume el estado del proceso al **pausar** el trabajo.

## Resumen ejecutivo
- **El core de Bifrost Meet está COMPLETO, mergeado a `main` y desplegándose** (PR #39, commit `097ee84`).
- Cubre backend, integración con agenda/correo, frontend de llamada (UI Google Meet + screen share),
  infra (compose + LiveKit), soporte de LiveKit externo/Cloud (por API), provisioner AWS y documentación.
- **Único pendiente (PAUSADO por decisión del PM): F3.7-frontend** — el panel *visual* admin para
  configurar LiveKit externo/Cloud. Hoy esa configuración se hace por la API del admin; el core funciona.

## Fases entregadas (todas en `main`, cada una revisada por B/Codex + C/GLM + D/Kimi, score ≥9 y 0 HIGH)

| Fase | Qué | Estado |
|---|---|---|
| Diseño v2.3 + Fase 0 funcional (7 pantallas) | `docs/meet/` | ✅ merged |
| **F3.1** backend base | MeetRoom, token-service (grants/ttl/identidad opaca/ventana temporal), rutas `/api/meet/*` + `/api/config/public`, gate | ✅ merged |
| **F3.2** integración agenda/correo | hook en createBooking (slug horneado, cero RPC en el lock, degradado), reschedule/cancel migran/cierran sala, link en email/ICS | ✅ merged |
| **F3.3** frontend llamada | UI estilo Google Meet + screen share (livekit-client), MeetJoin/MeetCall, i18n | ✅ merged |
| **F3.4** infra | servicio `livekit` (profile meet, imagen pinneada v1.8.4, límites cgroup), `livekit.yaml`, CSP deploy-time | ✅ merged |
| **F3.7-backend** | LiveKit externo/Cloud: credenciales en MeetSettings (DB, secret cifrado AES-GCM) + `POST /test` | ✅ merged |
| **F3.5** provisioner AWS | CFN 2º-SG (puertos media mínimos) + Route53 + `MeetMode` + piso `t4g.large` + user-data (EIP→node_ip vía Fn::Join, no IMDS) | ✅ merged |
| **F3.6** docs | guía de operación `docs/meet/INSTALL.md` (instalación/puertos/costos/troubleshooting/limitaciones/checklist) | ✅ merged |
| **F3.5b** turnkey | auto-enable Meet en deploys provisionados (`MEET_PROVISIONED` → `enabled=true` por default) | ✅ merged |

Detalle del proceso de revisión A/B/C/D en `docs/meet/REVIEW-LOG.md`.

## Cómo se usa hoy (con el core desplegado)
1. **Instalar con Meet**: `bifrost-provision --enable-meet` (o responder "sí" en el wizard). Sube la
   instancia a `t4g.large` (≥8 GiB), abre 3 puertos media (7881/tcp, 7882/udp, 3478/udp), crea DNS
   `meet.` / `turn.meet.`, y deja Meet **encendido** (turnkey, F3.5b).
2. **Usar**: activar la videollamada por tipo de evento/reserva en la agenda (toggle "Reunión con video").
   El link se hornea en la reserva, el email y el ICS.
3. **LiveKit externo/Cloud** (opcional): por la API del admin —
   `PATCH /api/admin/meet/settings { wsUrl, livekitApiKey, livekitApiSecret }` + `POST /api/admin/meet/test`.
   Guía completa: `docs/meet/INSTALL.md`.

## PAUSADO — F3.7-frontend (panel visual admin)
- **Estado**: **diseño terminado** (`docs/meet/DESIGN-F37-FRONTEND.md`), **implementación NO iniciada**.
- **Rama**: `feat/meet-admin-panel` (desde `main`; contiene sólo el diseño + este estado). No tocó `main`.
- **Alcance pendiente**: sección `meet` en la consola `/admin` (Google-Workspace) + `MeetAdmin.vue` +
  `lib/meetAdmin.ts` (lógica testeable env=node) + i18n + tests, contra la API F3.7 ya operativa.
- **Gate de diseño (Fase 2)**: **D/Kimi APROBÓ** (0 HIGH; 3 refinamientos: validar `livekitApiUrl` como
  el backend (`isSafeS3Endpoint`, no sólo http/https); icono `'video'` (no `'camera'`, inexistente en
  AppIcon); validar rango `maxParticipants` 2-1000 en cliente). **B/Codex quedó sin terminar** y **C/GLM
  falló por 529 (z.ai sobrecargado)** al pausar. Al retomar: incorporar los 3 refinamientos de D, cerrar
  B/C, y pasar a impl.
- **Por qué el panel**: hoy la config externa/Cloud es sólo por API; el panel la vuelve visual (mockup PM:
  server URL wss, API key, secret enmascarado, región, máx. participantes/resolución, auto-record
  [roadmap, deshabilitado], TURN/STUN, on-demand, status card, botón "Probar conexión").

## Deuda técnica registrada (no bloqueante)
- **TD-MEET-FLOOR-NONCATALOG** (LOW): el piso de instancia deja pasar tipos fuera de catálogo con <8 GiB
  (sólo avisa). Endurecer con `DescribeInstanceTypes` (RAM real).
- **node_ip CI-validation** (LOW): validar el `livekit.yaml` contra la imagen viva `v1.8.4` en CI.
- **TURN/TLS:443 diferido** (roadmap): redes que sólo abren 443/TCP pueden no conectar la media (ver
  `INSTALL.md` §5). Fast-follow post-MVP.
- **Grabación**: no implementada (roadmap; requiere LiveKit Egress/Cloud).

## Notas operativas
- Cron de auto-auditoría horaria: **cerrado** (a pedido del PM).
- Ningún proceso de revisión (B/C/D) queda corriendo.
