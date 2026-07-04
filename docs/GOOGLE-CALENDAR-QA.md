# QA e2e — Integración Google Calendar (runbook ejecutable)

Plan de pruebas manual de extremo a extremo, ejecutable por un tercero, contra una instancia real con
credenciales de Google. Complementa los tests automatizados (unit/integration, 617/617). Cada caso indica
**pasos**, **resultado esperado** y **qué capturar**. Marcá ✅/❌ y anotá evidencia.

Feature-gate: sin `GOOGLE_*` la sección no aparece y la API responde 503 — eso ya es un caso (F0).

---

## 0. Setup (una vez)

1. Google Cloud Console → proyecto → OAuth consent screen (External, en Testing con tu Gmail como test user)
   → Credentials → OAuth client ID tipo **Web application**.
2. Authorized redirect URI EXACTO: `https://<host-webmail>/api/calendar/google/callback`.
3. En el operador (`.env` o docker-secret):
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://<host-webmail>/api/calendar/google/callback
   ```
4. Reiniciar la API. Tener a mano: Gmail de prueba, DevTools (Network + Application/Storage), acceso a Mongo
   (para verificar cifrado) y a los logs de la API.

---

## Grupo A — Camino feliz

| # | Caso | Pasos | Esperado | Capturar |
|---|------|-------|----------|----------|
| A1 | **Estado inicial** | Ir a Calendario | Panel lateral muestra sección "Google Calendar" con intro + botón "Conectar con Google Calendar" | screenshot |
| A2 | **Conectar** | Click "Conectar" → consent de Google → Allow | Vuelve a `/calendar`, banner "Google Calendar conectado", la sección muestra "Conectado como <tu-gmail>" + botón "Desconectar" | screenshot; URL final sin `?google=` |
| A3 | **Crear evento → Google** | Crear un evento en Bifrost (ej. mañana 15:00–16:00) | En 1-2 min aparece EXACTAMENTE ese evento en tu Google Calendar (verlo en Gmail/calendar.google.com) | screenshot de ambos lados |
| A4 | **Editar evento** | Cambiar título/hora del evento en Bifrost | El evento en Google se actualiza (NO se crea uno nuevo — sigue siendo 1 solo) | screenshot; contar que hay 1 |
| A5 | **Borrar evento** | Borrar el evento en Bifrost | Desaparece de Bifrost inmediatamente y de Google en 1-2 min | screenshot |
| A6 | **Evento all-day** | Crear un evento de todo el día | Aparece como all-day en Google (fecha, no hora) | screenshot |
| A7 | **Desconectar** | Click "Desconectar" | La sección vuelve a "Conectar"; en Google, la app deja de tener acceso (myaccount.google.com/permissions → ya no figura) | screenshot de permisos Google |

---

## Grupo B — Seguridad (crítico)

| # | Caso | Pasos | Esperado |
|---|------|-------|----------|
| B1 | **Refresh token NUNCA al frontend** | Con la conexión activa, en DevTools → Network, inspeccionar TODAS las respuestas de `/api/calendar/google/*` y `/api/calendar/*` | Ninguna respuesta contiene `refresh_token`, `access_token`, ni `ciphertext`. `GET /status` sólo trae `{configured, connected, email, status, lastSyncedAt}` |
| B2 | **Tokens cifrados en DB** | En Mongo: `db.googleconnections.findOne()` | `accessTokenEnc`/`refreshTokenEnc` son `{ciphertext, iv, tag}` (NO texto plano). No hay token legible |
| B3 | **Scope mínimo** | En la pantalla de consent de Google (paso A2) | Sólo pide "ver y editar eventos" (`calendar.events`) + email/perfil básico. NO pide contactos, Drive, ni lectura de otros calendarios |
| B4 | **Aislamiento entre usuarios** | Usuario U1 conecta su Google. Usuario U2 (otra cuenta Bifrost) crea/edita/borra eventos | Los eventos de U2 NO llegan al Google de U1. `GET /status` de U2 no muestra la conexión de U1 |
| B5 | **CSRF del callback** | Copiar la URL de callback de un flujo y abrirla en OTRO navegador/sesión (sin la cookie `gcal_oauth`) | Redirige a `/calendar?google=error` (rechazado por el double-submit cookie) — NO conecta |
| B6 | **Cancelar consent** | En A2, en vez de Allow, click "Cancel"/Deny | Vuelve a `/calendar?google=error&reason=cancelled`; NO queda conexión |

---

## Grupo C — OAuth lifecycle / fallas

| # | Caso | Pasos | Esperado |
|---|------|-------|----------|
| C1 | **Refresh transparente** | Conectar; esperar > 1h (o adelantar reloj / forzar) hasta que el access token venza; crear un evento | El sync refresca solo el token y el evento llega a Google; el usuario NO nota nada |
| C2 | **Revocación desde Google** | Con conexión activa, ir a myaccount.google.com/permissions → quitar el acceso de la app. Luego crear/editar un evento en Bifrost | El sync detecta 401/invalid_grant → la conexión pasa a "error", la UI muestra el aviso + "Reintentar/Reconectar". NO entra en loop de reintentos |
| C3 | **Reconectar tras error** | Tras C2, click "Reconectar" → Allow | La conexión vuelve a "connected"; los eventos creados/editados DESPUÉS de reconectar se sincronizan |
| C4 | **Google caído (transitorio)** | (Opcional, difícil de simular) Si Google devuelve 5xx | El evento queda en error y reintenta solo (BullMQ + reconciler); la conexión NO se desconecta por un blip |

---

## Grupo D — UI / UX / accesibilidad / responsive

| # | Caso | Esperado |
|---|------|----------|
| D1 | **Estado no-configurado** | En una instancia SIN `GOOGLE_*`: la sección Google NO aparece; `GET /api/calendar/google/connect` → 503 |
| D2 | **Estado "conectando"** | Al click Conectar, el botón se deshabilita y muestra "Conectando…" antes de redirigir |
| D3 | **Consistencia visual** | La sección usa los mismos tokens/estilo que el resto del panel (colores de acento, iconos AppIcon/Phosphor) |
| D4 | **Accesibilidad** | Banner con `role=status`, error con `role=alert`; botones con texto legible por lector de pantalla; foco navegable por teclado |
| D5 | **Responsive** | En desktop la sección se ve en el panel lateral. **Conocido:** <820px el panel lateral (y por ende la sección) se oculta — conectar desde móvil no está en v1 |
| D6 | **Consola limpia** | DevTools Console sin errores nuevos durante todo el flujo (salvo el `console.warn` intencional si `/status` falla) |

---

## Grupo E — Idempotencia / duplicados / concurrencia

| # | Caso | Esperado |
|---|------|----------|
| E1 | **Ediciones rápidas** | Editar el mismo evento 3-4 veces seguidas rápido | En Google queda 1 solo evento con el ÚLTIMO estado (no duplicados) |
| E2 | **Mismo id determinista** | Verificar en Mongo que el evento tiene `googleEventId` = `bif<hash>`; el evento en Google tiene ese mismo id | 1:1, estable |
| E3 | **Borrar y recrear** | Borrar un evento, luego crear uno nuevo | El borrado se refleja; el nuevo tiene su propio id; sin colisión |

---

## Qué reportar de vuelta

Por cada grupo: ✅/❌ + para los ❌ → caso, qué pasó vs. esperado, screenshot, y (si aplica) las líneas
de log de la API en ese momento. Prioridad de reporte: **Grupo B (seguridad) primero**, luego A, C, D, E.

Si algo falla, con el `googleSyncStatus` del evento en Mongo + el log de `[scheduling] job failed` +
el estado de la `GoogleConnection` alcanza para diagnosticar. Los fixes que surjan se batchean con los
LOW cosméticos pendientes (enum `deleted`, auto-dismiss del banner, índice `{status,userId}`) en UN PR.
