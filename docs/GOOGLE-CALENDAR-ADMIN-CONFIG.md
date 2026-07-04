# Google Calendar — credenciales configurables desde /admin (diseño)

## Problema (feedback de A)
Hoy las credenciales OAuth de Google (`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`) sólo se setean por **env-var**
+ restart del servidor. El admin no puede activarlas desde `/admin`, y no hay guía de cómo obtenerlas.
Es **inconsistente** con el resto de Bifrost (S3, Meet, provisioning se configuran desde `/admin`, con el
secret cifrado en DB). El botón "Conectar con Google Calendar" queda invisible hasta configurar env → mala UX.

## Objetivo
Sección **"Google Calendar"** en `/admin` (gate `requireAdmin`, como Meet) donde el admin:
- pega `Client ID`, `Client Secret` (cifrado en DB), y ve el `Redirect URI` pre-armado con su dominio + copiar;
- lee una **guía paso a paso** embebida (crear proyecto OAuth en Google Cloud, sacar id/secret, scopes, test user);
- al guardar, la feature se activa **sin reiniciar** (invalidando el cache).
Compat: quien ya use env-var sigue andando (DB-o-env; DB manda).

## Patrón a seguir (molde: Meet/LiveKit)
- **Persistencia**: `SystemConfig` key `'googleCalendar'`, secret `clientSecretEnc: EncryptedPayload`
  (AES-256-GCM, `config/crypto.ts`). NUNCA se serializa el secret ni el ciphertext.
- **Resolución DB-o-env** (molde `services/meet/token-service.ts:resolveLivekitCreds`): si el **trío DB
  completo** (clientId+clientSecret+redirectUri) existe → DB (decrypt); si el decrypt lanza (clave rotada)
  → estado `'error'`, NUNCA mezcla con env; si el trío DB falta/parcial → env; si nada → `'none'`.
- **DTO admin** (molde `toAdminMeetSettings`): expone `clientId`, `redirectUri`, `hasClientSecret:boolean`,
  `source:'db'|'env'|'error'|'none'`. Nunca el secret.
- **Semántica del secret en el PATCH** (molde `setMeetSettings`): omitido = preserva; `''` = CLEAR (borra
  → vuelve a env-only); valor = SET `encrypt(...)`.

## Cambios backend
1. **`services/google/settings.ts`** (nuevo): `getRawGoogleConfig()` → devuelve el doc de SystemConfig TAL
   CUAL (SIN merge con env — clave para no romper el invariante, review B-MED). `setGoogleSettings(patch)`
   (3 semánticas del secret), `toAdminGoogleSettings()` → DTO admin (sin secret).
2. **`services/google/creds.ts`** (nuevo) — RESOLUCIÓN ATÓMICA (molde `token-service.ts:resolveLivekitCreds`):
   `resolveGoogleCreds()` lee **raw DB row + raw env** y decide fuente atómicamente, **sin mezclar campos**:
   - DB-trío COMPLETO (clientId + clientSecretEnc + redirectUri): `decrypt(clientSecretEnc)` →
     ok = `{source:'db', clientId, clientSecret, redirectUri}`; lanza = `{source:'error'}` (NUNCA aliasa a env).
   - si no, ENV-trío completo (3 env vars) → `{source:'env', ...}`.
   - si no → `{source:'none'}`.
   **Cache**: guarda SÓLO `{source, clientId, redirectUri, clientSecretEnc}` (payload cifrado) — **NUNCA el
   secret en claro** (review D-HIGH; Meet tampoco cachea secretos). El `source` se computa UNA vez al poblar
   (intentando el decrypt y DESCARTANDO el plano). El secret plano se obtiene descifrando el payload cacheado
   **just-in-time** en cada exchange/refresh, y no se retiene. TTL 30s + invalidación explícita en el PATCH.
3. **`googleEnabled(): Promise<boolean>`** (reemplaza `googleConfigured()` en `config/env.ts`): devuelve
   `source === 'db' || source === 'env'` del cache. **Fail-closed ALINEADO con la resolución** (review
   B-MED/D-HIGH): si el decrypt del secret DB falla → `source==='error'` → `googleEnabled()===false` → la UI
   muestra la sección en estado de error (no habilitada). NO chequea "presencia sin descifrar". **Call-sites
   sync→async (todos en contexto async, sólo `await`; GREP obligatorio `googleConfigured`/`googleEnabled`
   antes de mergear para no dejar un uso sync ni un flag calculado en import-time — review B/D-LOW):**
   `services/google/dispatch.ts:12`, `services/google/sync.ts:50`, `services/scheduling/reconciler.ts`,
   `routes/calendar.ts` (POST/PATCH/DELETE), `routes/google-calendar.ts`.
4. **`services/google/oauth.ts`**: `buildAuthUrl`/`exchangeCode`/`refreshAccessToken` usan
   `resolveGoogleCreds()` (ya async) en vez de `env.GOOGLE_*`. El `redirect_uri` sale de la MISMA resolución
   (el efectivo, DB o env) — no se re-arma por separado.
5. **`routes/google-calendar-admin.ts`** (nuevo, molde `meetAdminRoutes`): montado `/api/admin/google-calendar`
   (nombre consistente con `/api/calendar/google/*`, review B/D-LOW), `preHandler: requireAdmin`.
   `GET /settings` → DTO `{clientId, redirectUri: EFECTIVO (db o env), hasClientSecret, source}` (nunca el
   secret). `PATCH /settings` (Zod): para ACTIVAR DB exige el **trío completo** (clientId + clientSecret +
   redirectUri) — evita el parcial que deja el secret sin usar (review B/D-MED). Semántica explícita:
   `undefined`/omitido = preserva; **sólo `''`** limpia (Zod NO debe coercer `null`→`''`, review D-MED). Al
   guardar → invalida el cache (activación sin restart en el proceso único all-in-one de Bifrost).

## Cambios frontend
6. **`components/admin/AdminGoogleCalendar.vue`** (nuevo): form (clientId; **redirectUri = el EFECTIVO que
   devuelve el DTO** —db o env— con botón copiar, para que el admin copie a Google EXACTAMENTE el que usa el
   backend y evite `redirect_uri_mismatch`, review D-MED; clientSecret `type=password`
   `autocomplete=new-password`), patrón "secret configurado" (`secretAlreadyConfigured` +
   `admin.secretConfigured`/`admin.secretPlaceholderSet`). **Guía paso a paso** con links **hardcodeados** a
   Google Cloud Console (sin URLs dinámicas → sin open-redirect, review D-LOW). Llama
   `api.get/patch('/admin/google-calendar/settings')`.
7. **`AdminView.vue`**: `'google'` al `Tab`, item en `SECTIONS`, en `NAV_GROUPS.config`,
   `SECTION_PERMISSION.google = null` (admin-only, como Meet), `<AdminGoogleCalendar v-else-if="tab==='google'"/>`.
8. **i18n** (es/en): `admin.tabs.google`, `admin.google.*` (title/desc/guía/labels).

## Seguridad / invariantes
- Secret cifrado en DB; jamás sale por la API (sólo `hasClientSecret`/`source`).
- `requireAdmin` en todos los endpoints de config.
- Resolución fail-closed: decrypt que lanza → `'error'`, no aliasa a env (mismo invariante que Meet).
- DB manda sobre env; trío parcial en DB → cae a env (no mezcla).
- El `client_secret` sólo se descifra dentro de `resolveGoogleCreds` en el momento del intercambio/refresh.

## Riesgos
- **googleConfigured sync→async**: ripple a call-sites. Mitigado: todos en contexto async; cache evita coste.
- **Cache stale tras guardar**: invalidación explícita en el PATCH + TTL 30s de respaldo.
- **Redirect URI**: debe COINCIDIR EXACTO con el registrado en Google. La UI lo pre-arma y el admin lo copia
  a Google; si difieren, Google rechaza con redirect_uri_mismatch (se documenta en la guía).

## Fuera de scope (v1 de este addon)
- Botón "probar credenciales" (opcional, fase 2). El feedback real llega al intentar conectar.
- Rotación automática de secret.

## §Correcciones ronda B/D del diseño (v2)
- **HIGH (D) / MED (B) — googleEnabled vs resolve desalineados**: `googleEnabled()` ahora deriva del MISMO
  `source` de la resolución atómica; si el decrypt falla → `error` → deshabilitado. Cero "presencia sin descifrar".
- **HIGH (D) — no cachear el secret en claro**: el cache guarda sólo `{source, clientId, redirectUri,
  clientSecretEnc}`; el plano se descifra just-in-time por operación y no se retiene.
- **MED (B) — no merge DB+env por campo**: `getRawGoogleConfig()` devuelve el doc crudo; el merge/decisión
  vive sólo en `resolveGoogleCreds()` atómico.
- **MED (D) — redirect_uri_mismatch**: el DTO devuelve el redirectUri EFECTIVO; la UI copia ESE.
- **MED (D) — null/undefined en PATCH**: sólo `''` limpia; `null`/omitido preserva (Zod explícito).
- **MED (B/D) — parcial deja secret sin usar**: el PATCH exige el trío completo para activar DB.
- **LOW — endpoint `/api/admin/google-calendar`; guía con links hardcodeados; grep sync→async; single-instance.**

## Estado: IN_REVIEW_DOC v2 (re-revisar B/D)

## §Ronda B de la implementación
- MED cache-race → cerrado (token `generation`; el load en vuelo recarga si cambió).
- MED trío/huérfano → cerrado (setGoogleConfig ACOPLA: limpiar clientId/redirectUri descarta el secret).
- LOW env-live → cerrado (el secret de env se snapshotea CIFRADO en el cache; resolve descifra igual que db).
- LOW recuperación en 'error' → el DTO cae a los clientId/redirectUri CRUDOS de DB (el admin reingresa sólo el secret).
- **PRODUCT DECISION (B MED, aceptado): read-modify-write en `setGoogleConfig`.** Dos PATCH admin
  concurrentes podrían perder un update. Trade-off aceptado: es EL MISMO patrón que `setMeetSettings`
  (molde aprobado), la config admin NO es un path concurrente (un admin, un submit), y no rompe ningún
  invariante de seguridad (el secret sigue cifrado). Un lock optimista sería sobre-ingeniería para este uso.
