# Deuda técnica y gates de producción — Webmail 6.0

Registro vivo de los follow-ups detectados durante F3.0–F3.9 por el equipo A/B/C/D.
No bloquean el cierre de las fases (cada una quedó APPROVED por B/C/D), pero deben
atenderse antes de declarar el producto **production-ready**.

## Re-auditoría 3 rondas (jun 2026, post-PR #1 verde)

Protocolo arquitecto / auditor hostil / operador-3AM. **Sin HIGH nuevos** — verificado
(no confiado en los .md):
- **Arquitecto:** CI+E2E en verde en GitHub (PR #1); no reinvención (sanitize-html, Fastify,
  imapflow, ioredis-mock). Tooling de lint/format determinista y completo.
- **Auditor hostil (XSS, máxima superficie = HTML de email atacante-controlado):** el sanitizador
  (`lib/sanitizeHtml.ts`, sanitize-html) es correcto: allowedTags sin script/iframe/style/svg/object;
  sin `on*` ni `style` attr; schemes sólo http/https/mailto (bloquea `javascript:`/`data:`); `a` con
  `rel=noopener noreferrer target=_blank`. CSP `script-src 'self'` como 2ª capa. (Img remoto/tracking
  = privacidad MED, ya es follow-up F4.)
- **Operador 3AM:** build de producción sirve y hace SPA-fallback (nginx `try_files … /index.html`
  + verificado con `vite preview` en `/settings`, sin refresh-404); `index.html` referencia assets
  que existen en disco (code-splitting OK); nginx CSP/anti-spoof-XFF/bloqueo de `/api/metrics` OK.

## Re-auditoría adversarial (post-F3.9, jun 2026)

Barrida hostil de sistema completo por B+D buscando lo transversal que las reviews
por-fase no ven. **Corregido en esta ronda** (con boot real re-verificado):
- ✅ **HIGH bypass de rate limit por X-Forwarded-For** — nginx ahora SETea XFF a `$remote_addr`
  (no appendea el del cliente) → con `trustProxy` Fastify usa el IP real.
- ✅ **HIGH Redis colgaba comandos** — `redis.ts` con `maxRetriesPerRequest` finito + timeouts.
- ✅ **HIGH boot sin manejo** — `main().catch` + handlers `unhandledRejection`/`uncaughtException`.
- ✅ createRefreshToken atómico (pipeline); interceptor 401 de refresh en el front (sesión >15min);
  `/body` devuelve metadata de adjuntos (evita 2º fetch IMAP); delete de draft en `sending`→409;
  graceful shutdown cierra HTTP+interval; leak DOM de descarga; mass-assignment de PATCH draft.
- ✅ **Fix-QA ronda 2** (B 9/APPROVE, D 9/APPROVE, C/APPROVE): `restore()` ahora corre ANTES de
  `app.use(router)` (evitaba falso `/login` en reload con cookie válida — MEDIUM de B); setup-mode
  asigna `serverApp` (LOW de B, gracefulShutdown cubre ese listener); `gracefulShutdown` idempotente
  vía promesa compartida (2ª señal awaitea el cierre en curso) + cada deps-close aislado en try/catch
  (nits de C/B). Boot real de `dist/index.js` + SIGTERM verificado: health 200, exit 0, cierre en 11ms.

**Pendiente de la re-auditoría:**

- ✅ **TD-SYNC-OOM (HIGH, prod-gate) — RESUELTO** (jun 2026, B 8.5/APPROVE, D 9/APPROVE).
  `syncFolderHeaders` rediseñado: ya no carga documentos locales completos en RAM. Scan `1:*`
  liviano `{uid,flags}` que reconcilia flags por lotes (`SYNC_WINDOW`, lookup por `$in` de UIDs
  explícitos → independiente del orden de respuesta del servidor, RFC 9051); detección de
  expunges por cursor `.select('uid')` (memoria O(1)); fetch de envelope sólo de UIDs nuevos en
  PASO 3 (sin anidar comandos IMAP dentro del scan). Único estado O(N): `serverUids: Set<number>`
  (enteros, mínimo inevitable). `flushDeletes` borra Mongo→Redis (fuente de verdad primero).
  Cubierto por `sync-batching.test.ts` (orden no-monótono, ventana pequeña). Para folders de
  **millones** el camino O(cambios) es CONDSTORE/QRESYNC → ver TD-SYNC-CONDSTORE.
- 🟠 Races transversales (eventual-consistency, se auto-curan en el próximo sync, severidad MEDIUM):
  M-2 caché de body huérfana si GET /body corre justo después de DELETE; M-3 PATCH flags vs sync
  puede revertir `seen` hasta el próximo sync; M-8 sync no atómico ante fallo de Mongo (estado parcial).
- 🟠 M-7 IMAP sin pool persistente ni timeouts; M-9 health no chequea IMAP/SMTP; M-11 `/drafts`
  sin paginación; M-13 mutex de sync sin timeout (un IMAP colgado bloquea syncs del folder);
  M-6 CORS del app de setup `origin:true`.

## 🔴 Gates de producción (must-fix-before-prod)

- ✅ **TD-E2E — RESUELTO** (jun 2026). E2E full-stack real del flujo **login → sync → leer
  → enviar** corriendo la API REAL contra `mongodb-memory-server` + Redis mock + transportes
  IMAP/SMTP fake inyectados por un seam nuevo (`services/mail-transport.ts`, sin flags de
  test en los hot-paths). Server E2E en `packages/api/e2e/server.ts`; spec en
  `packages/web/e2e/mailbox.spec.ts`; Playwright levanta ambos servers. **Destapó y arregló
  2 bugs de producción que ningún test previo cubría** (el smoke sólo cargaba la página de
  login):
  - 🔴 **`POST /auth/refresh` tiraba 400 con body vacío** — el cliente web refresca SÓLO con
    la cookie httpOnly (sin body); `z.object().parse(undefined)` → 400 → `restore()` fallaba
    y **el usuario caía a /login en CADA reload** pese a cookie válida. Fix: `refreshBodySchema`
    con `.default({})`.
  - 🔴 **Axios destruido por Pinia** — el store exponía la instancia de axios (`api`) en su
    return; como axios es CALLABLE, el setup store de Pinia la trataba como *action*, la
    envolvía y **borraba `.get/.post/...`** → `auth.api.get is not a function` en TODA carga
    de datos autenticada. Fix: el cliente HTTP pasa a ser singleton de módulo
    (`packages/web/src/lib/http.ts`); el store sólo configura header+interceptor.
  Cobertura E2E (4 tests, serial): (1) flujo login→sync→leer→enviar con aserción del PATCH
  /flags; (2) reply con threading; (3) interceptor refresh-on-401 (JWT_ACCESS_TTL configurable,
  '3s' en E2E → el token vence y la request se rescata sola); (4) smoke de login. Hardening
  post-review (B 8/APPROVE, D APPROVE): `set*Factory` del seam con guard `NODE_ENV=test`;
  `refreshBodySchema` `.strict()` + normaliza `refreshToken:""`→cookie. CI: `e2e.yml` (autónomo).

- ✅ **Reply/Forward — RESUELTO** (jun 2026, hallado en auto-auditoría). Los botones Reply/
  Forward existían pero estaban ROTOS: `ComposerView` sólo leía `route.params.draftId` e
  ignoraba `route.query` → abrían un composer EN BLANCO. El backend ya estaba 100% construido
  (drafts route acepta `replyToEmailId/messageId/references`, valida ownership, smtp.ts pone
  `In-Reply-To`/`References`). Fix frontend-only: `ComposerView.prefillFromOriginal()` precarga
  destinatario/`Re:`-`Fwd:`/cita y setea el contexto de threading; `draftStore.createDraft`
  lo reenvía. E2E lo cubre (precarga + persistencia de `replyTo.messageId`). Deuda LOW: no hay
  reply-all (cc) ni adjuntos en forward.

  Deuda residual de la tanda E2E (LOW, no bloqueante): tipar el seam con interfaces propias (hoy
  `as never` en el borde test); el fake IMAP no ejercita expunge/append-fail; **`TD-COVERAGE-WEB`
  sube de prioridad** (el frontend casi no tenía cobertura y shipeó 2 bugs de ruptura total +
  reply/forward roto); **SettingsView**: `v-model="settings.theme"` saltea `setTheme` → el tema
  no persiste en localStorage (LOW); **CalendarView**: "Account ID" es input de texto crudo
  (post-MVP).
- **TD-DOCKER-VERIFY** — Los Dockerfiles y `docker.yml` fueron corregidos (faltaban
  `pnpm-lock.yaml`, `tsconfig.build.json`; tags semver/`latest`), pero NO se pudo correr
  `docker build`/`docker run` localmente (docker no disponible en el entorno de desarrollo).
  Verificar build de ambas imágenes + `docker run` de la API sirviendo `/api/health`. CI
  (`docker.yml`) lo ejecuta en cada push/tag.

## 🟠 Mejoras priorizadas

- **TD-SEND-QUEUE** — Cola BullMQ + worker para auto-retry de fallos SMTP transitorios.
  Hoy el envío es síncrono e idempotente (transición atómica + Message-ID + recovery de
  colgados); el reintento es manual. Trigger: cuando el volumen de fallos lo justifique.
- **TD-SYNC-DISTLOCK** — El mutex de sync por folder es in-process; para multi-instancia
  hace falta un lock distribuido (Redis) por `{accountId,folderId}`.
- **TD-SYNC-CONDSTORE** — Sync por `HIGHESTMODSEQ`/`CONDSTORE` para evitar el rescan O(N)
  de `1:*` en carpetas grandes.
- **TD-AUTH-MINOR** — Ventana de crash entre GETDEL y emisión en la rotación; TTL absoluto
  de refresh (hoy deslizante sin tope); `isNew` no atómico con el upsert (cosmético).
- **TD-AUTH-CONCURRENT-REFRESH (MEDIUM, hallado en re-auditoría jun 2026)** — `rotateRefreshToken`
  usa GETDEL atómico (una rotación gana) + reuse-detection (revoca la familia si el token ya fue
  consumido). Pero dos refresh **concurrentes con la MISMA cookie** (multi-tab: los tabs comparten
  cookie; el single-flight del front es por-instancia, no cruza tabs) hacen que el perdedor reciba
  `null` y revoque la familia, pudiendo **nukear el token nuevo del ganador** según el interleaving
  → ambos tabs deslogueados. Ventana angosta (refresh simultáneo real) y recuperable (la cookie ya
  es la nueva). NO reproducible con `ioredis-mock` (ordena determinista); requiere repro contra
  Redis real. Fix correcto (NO un parche): **reuse-leeway** estilo Auth0 — al rotar, marcar el
  rawId predecesor con TTL corto (p.ej. `refreshgrace:{familyId}:{hash(rawId)}` 10–30s); en el
  camino `null`, si existe la marca de grace → concurrencia benigna → devolver `null` SIN revocar
  la familia; sin marca → reuse/robo real → revocar. Requiere review de seguridad B/C/D (no
  rush-patch del backbone de auth). El test concurrente actual sólo asierta "uno gana", no la
  supervivencia del ganador.
- **TD-FE-MINOR** — Bloqueo/proxy de imágenes remotas en emails (privacidad/tracking) según
  preferencia de usuario; fallback de carpeta Trash localizado; tests de componente Vue.
- **TD-STREAM** — Streaming real de adjuntos / `bodyParts` selectivos (hoy se carga el RFC822
  completo en RAM, mitigado con cap de 25MB).
- **TD-COVERAGE-WEB** — `web` y `shared` no tienen gate de cobertura (sólo API: 75/65/80,
  real ~87/78/90). Agregar tests de componente/unit y thresholds.

## 🟡 Hardening de producción (F4)

- CSP ya añadida al SPA (nginx); evaluar política de imágenes remotas y proxy.
- Secretos: migrar de `.env` plano a Docker secrets / KMS.
- `Dockerfile.api` single-stage con devDeps → multi-stage con prune para imagen prod pulida.
- Rate limit distribuido (store Redis) para multi-instancia.
