# F3.7-frontend — panel admin de Bifrost Meet (LiveKit) · Diseño (Fase 2)

Panel visual para configurar Meet/LiveKit desde el admin, como **sección nueva de la consola
Google-Workspace** de `/admin` (PR #30). El backend + la API ya existen (F3.7-backend, en main); esto es
sólo la UI.

## 1. Alcance
- Nueva sección **`meet`** en la consola admin (junto a accounts/branding/storage/compliance/scheduling/preferences).
- Componente **`MeetAdmin.vue`** (patrón de `ComplianceAdmin.vue`/`AdminSchedulingPanel.vue`).
- Lógica de mapeo (DTO↔form, semántica del secret) EXTRAÍDA a **`lib/meetAdmin.ts`** (testeable en env=node,
  igual que `lib/adminStorage.ts`) — porque los tests web del repo son vitest `env=node`, sin jsdom/@vue/test-utils.
- i18n es+en.

## 2. Contrato con el backend (ya en main)
- **GET `/api/admin/meet/settings`** → `MeetSettings` (DTO shared): `enabled, wsUrl, publicBaseUrl,
  turnDomain?, maxParticipants, maxDurationMinutes, allowExternal, branding?, auditEnabled,
  recordingPolicy:'disabled', livekitApiKey?, livekitApiUrl?, region?, maxResolution?('720p'|'1080p'),
  autoRecord?, onDemand?, hasApiSecret:boolean, livekitSource:'db'|'env'|'error'|'none'`. **El secret NUNCA
  viene** (sólo `hasApiSecret`).
- **PATCH `/api/admin/meet/settings`** ← subconjunto editable + `livekitApiSecret?` (plano). Semántica del
  secret: **omitir**=preserva · **`""`**=CLEAR (vuelve a env) · **valor**=setea (cifra). Validaciones del
  backend: secret exige key (400); `livekitApiUrl` http/https sin userinfo (400).
- **POST `/api/admin/meet/test`** → `{ ok:boolean, category:'reachable'|'unauthorized'|'unreachable'|'invalid', activeRooms? }`.
  Admin-only + rate-limit 5/min. Puede recibir un candidato (`wsUrl`+`livekitApiKey`+`livekitApiSecret`) o
  probar la config guardada.

## 3. UI (mockup PM)
Tarjetas dentro de la sección:
1. **Estado** (arriba): badge según `livekitSource` — `db`/`env`→"Servidor operativo" (verde) · `error`→
   "Error de credenciales (revisá key/secret o ENCRYPTION_KEY)" (rojo) · `none`→"No configurado" (gris).
   Botón **"Probar conexión"** → POST /test → muestra la categoría traducida + `activeRooms` si `reachable`.
2. **Interruptor** `enabled` (master).
3. **Servidor LiveKit**: `wsUrl` (URL wss del servidor) · `livekitApiKey` · **`livekitApiSecret`**
   (input password, placeholder según `hasApiSecret`: "•••• (guardado)" vs "sin configurar"; botón "Limpiar"
   que marca clear→`""`; dejar vacío = preservar) · `livekitApiUrl` (opcional, http/https; ayuda: "se
   deriva del wsUrl si se omite").
4. **Límites**: `maxParticipants` (number) · `maxResolution` (select 720p/1080p) · `allowExternal` (toggle).
5. **Avanzado**: `region` (texto, informativo) · TURN/STUN (`turnDomain`, informativo) · `onDemand` (toggle).
6. **Grabación**: `autoRecord` toggle **deshabilitado** con nota "no implementada (roadmap; requiere Egress/
   Cloud)" — honesto con el backend (`recordingPolicy` siempre `disabled`; ver F3.6 §5). NO se promete grabar.

## 4. Semántica del secret (crítica, en `lib/meetAdmin.ts`)
- El form arranca con el secret **vacío** (nunca se precarga; el DTO no lo trae).
- Al guardar: si el usuario NO tocó el secret → **omitir** `livekitApiSecret` del PATCH (preserva).
- Si tocó "Limpiar" → enviar `livekitApiSecret: ""` (CLEAR).
- Si escribió uno → enviar el valor.
- Validación cliente (además del backend): secret escrito exige `livekitApiKey`; `wsUrl` empieza con `ws://`/
  `wss://`; `livekitApiUrl` (si se da) http/https. Errores inline, sin pegarle al backend en balde.

## 5. Wiring en AdminView.vue
- Sumar `'meet'` al type `Tab` + una entrada en `SECTIONS` (`key:'meet'`, `icon:'video'|'camera'`,
  `label:'admin.tabs.meet'`).
- Import de `MeetAdmin.vue` + render cuando `tab==='meet'` (mismo patrón que Compliance/Scheduling).
- Sólo admin (la vista ya está gateada por rol admin).

## 6. Tests (env=node)
- `lib/__tests__/meetAdmin.test.ts`: DTO→form (secret nunca precargado); form→patch (omitir/clear/set del
  secret); validaciones cliente (secret sin key, wsUrl no-wss, apiUrl no-http); estado del badge por
  `livekitSource`; categoría /test → mensaje i18n.
- No se testea el render del .vue (sin jsdom); la lógica vive en el lib.

## 7. No-objetivos / decisiones
- **Grabación**: sólo se muestra el flag (deshabilitado, roadmap) — no se implementa Egress.
- El panel NO expone `maxDurationMinutes`/`auditEnabled`/`branding` en v1 (fuera del mockup; se pueden
  sumar luego). `publicBaseUrl` es informativo (viene del deploy).
- No hay "selector de modo" (bundled/externo/Cloud): el modo es **automático por la URL** (decisión PM) —
  el panel sólo edita `wsUrl`+creds; el backend resuelve DB-XOR-env.
