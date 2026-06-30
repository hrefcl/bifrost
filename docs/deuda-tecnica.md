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
- **Auditor hostil (descarga de adjuntos — IDOR + XSS-inline + header-injection):** seguro en los 3
  vectores. `GET /emails/:id/attachments/:idx` valida `idx` (rechaza NaN/negativo→400), exige
  `requireOwnedEmail` (sin IDOR multi-tenant; `.at(idx)` undefined→404 sin crash), y sirve con
  `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment` (nunca inline → un adjunto
  text/html o svg no ejecuta en el origen) con filename ASCII-saneado (strip CRLF/comillas →
  anti header-injection) + `filename*=UTF-8''` (RFC 5987). Verificado, no confiado en el MD.
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
- ✅ **TD-DOCKER-VERIFY — RESUELTO** (jun 2026, verificado en CI real):
  - **`docker build` de ambas imágenes** VERIFICADO — `docker.yml` corre en `pull_request`
    (build sin push) → se valida en cada PR, no sólo al pushear a main. Job `build` verde.
  - **`docker run` de la API arranca y sirve HTTP** VERIFICADO — job `smoke` aislado: levanta el
    contenedor (setup-mode + `REDIS_URL=mock`, sin Mongo/Redis externos) y `curl /api/setup/status`
    responde. Job `smoke` verde en PR #1. Replica el boot real ya validado con `node dist/index.js`.
  - Local sigue sin docker/mongod (6 runtimes chequeados, ausentes) pero GitHub Actions sí tiene →
    el gate completo (build + run + serve) está cubierto en CI. Landmine de `ioredis-mock` (devDep
    importado en prod) neutralizado con carga perezosa (`createRequire` sólo si `REDIS_URL=mock`).

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
- **TD-AUTH-CONCURRENT-REFRESH (LOW — sólo multi-instancia; MEDIDO jun 2026)** — Teoría: dos refresh
  concurrentes con la MISMA cookie (multi-tab) podrían hacer que el perdedor (GETDEL→`null`) revoque
  la familia y nukee el token del ganador. **Medido contra Redis REAL: 2000/2000 iteraciones →
  winner nukeado 0.00%.** Causa: producción usa UNA sola conexión Redis (singleton) → todos los
  comandos se serializan en su cola FIFO, así que el `smembers` del perdedor nunca cae entre el
  `getdel` y el `sadd` del ganador. **No manifiesta en single-instance** (el deployment actual).
  Sólo podría aparecer con **múltiples instancias** (conexiones Redis separadas) — caso ya cubierto
  por la deuda de multi-instancia (ver TD-SYNC-DISTLOCK). Si/cuando se escale horizontal: fix
  correcto = **reuse-leeway** atómico (Lua) estilo Auth0 (marca de grace del rawId predecesor con
  TTL corto; en el camino `null`, si hay grace → concurrencia benigna, no revocar; sin grace →
  revocar) + repro multi-conexión + review B/C/D. NO amerita tocar el backbone de auth hoy.
- **TD-FE-MINOR** — Bloqueo/proxy de imágenes remotas en emails (privacidad/tracking) según
  preferencia de usuario; fallback de carpeta Trash localizado; tests de componente Vue.
- **TD-COMPOSE-MINOR (LOW, review B/D de features jun 2026)** — Lo accionable de la review se
  corrigió (reply-all case-insensitive + correo-propio + E2E del CC; Link protocol-validation
  cliente; test adversarial de firma javascript:/onerror/iframe; hook pre-save que auto-cura
  displayName). Residual LOW: (1) reply-all no usa el header `Reply-To` del original para el To
  (Reply-To no se guarda en el modelo Email — requiere persistirlo en sync); (2) `parseAddresses`
  (drafts store) parte por `,` → rompe `'Nombre, Apellido' <a@b>` (pre-existente, sólo afecta
  entrada manual con display-names); (3) al recargar un draft existente, `replyContext` queda
  null en el front (el backend conserva `replyTo`, así que el envío threadea bien); (4) editor:
  sin manejo de paste limpio ni placeholder (MVP).
- **TD-STREAM** — Streaming real de adjuntos / `bodyParts` selectivos (hoy se carga el RFC822
  completo en RAM, mitigado con cap de 25MB).
- **TD-COVERAGE-WEB** — `web` y `shared` no tienen gate de cobertura (sólo API: 75/65/80,
  real ~87/78/90). Agregar tests de componente/unit y thresholds.

## 🟡 Hardening de producción (F4)

- CSP ya añadida al SPA (nginx); evaluar política de imágenes remotas y proxy.
- Secretos: migrar de `.env` plano a Docker secrets / KMS.
- `Dockerfile.api` single-stage con devDeps → multi-stage con prune para imagen prod pulida.
- Rate limit distribuido (store Redis) para multi-instancia.

---

## Estado tras las 5 auto-auditorías (jun 2026) — ver [`estado-final.md`](estado-final.md)

El subsistema de **adjuntos/storage/admin** se construyó y auditó en profundidad (5 rondas
B=Codex / D=Kimi). **6 issues reales de producción cerrados** (todos con review adversarial,
ningún merge con HIGH abierto o score <9):

| PR | Issue cerrado |
|----|----------------|
| #16 | Fuga de blobs huérfanos (refCount muerto) → GC mark-and-sweep con lease atómico |
| #17 | Footgun S3 (activar config mala rompía uploads) → endpoint "Probar conexión" |
| #18 | Disk-fill DoS (subir-sin-adjuntar + gracia GC) → cuota optimista por usuario |
| #19 | Defensa anti-XSS sin tests → 17 tests de regresión (B+D atacaron sin bypass) |
| #20 | **CVEs CRÍTICOS**: fast-jwt auth-bypass + cache-confusion (mixup identidad) + nodemailer SMTP-injection → upgrade @fastify/jwt 10 / nodemailer 9 |
| #21 | CI sin chequeo de CVEs → `pnpm audit --prod --audit-level high` como gate + hardening de workflows |

### Deuda viva (no bloqueante) tras las auditorías
- **TD-IMG-PRIVACY (MEDIUM)** — `autoLoadImages`/`blockRemoteContentUnknown` existen en
  `UserPreferences` pero NO se enforcan → imágenes remotas siempre cargan (tracking pixels).
  Enforcement = sanear `img src` según preferencia + toggle "cargar imágenes" en la UI.
- **TD-EMAIL-IFRAME-SANDBOX — HECHO + endurecido (review B/C/D)** — el cuerpo del email se renderiza en
  un **iframe sandbox** (`EmailBodyFrame.vue`, `sandbox` sin `allow-scripts`, srcdoc) → aísla el HTML
  del email del DOM de la app y cierra la categoría entera de mXSS/CSS-redress sin depender del regex
  del sanitizador. Review C 8/10 (sin HIGH): cero ejecución de JS confirmada. Cierres del review:
  CSP en el srcdoc (`script-src 'none'` + `base-uri/object-src/form-action 'none'`); altura capeada a
  24000px con scroll interno (evita DoS de layout por `height:500000px`); invariante documentado
  (NUNCA `allow-scripts` + `allow-same-origin`); reverse-tabnabbing ya cerrado en backend
  (`sanitizeHtml` fuerza `rel=noopener noreferrer`); CSRF-GET descartado (no hay GET que mute estado);
  CSP también en `print-email.ts`. **Residual LOW (largo plazo): origen-sandbox separado** para el
  render del email → elimina del todo el `allow-same-origin` (modelo Gmail con dominio aislado). No es
  HIGH: hoy no hay JS en el iframe que pueda abusar del mismo-origen.
- **TD-EMAIL-SEND-EXTERNALIZE (MED, review B/C/D)** — hoy `externalizeDataImages` (data:image → URL
  hosteada, para que Gmail no rompa la foto de la firma) corre SÓLO al guardar preferencias. Una firma
  guardada ANTES de la feature sigue con `data:` hasta re-guardarla, y las imágenes pegadas en el
  composer nunca se externalizan. **Fix (C 9/10 APPROVED, D 8/10):** externalizar también en `/send`
  sobre el `bodyHtml` final (cuerpo+firma) — es la única autoridad última donde existe el HTML
  ensamblado, replica a Gmail y **auto-cura firmas legacy** sin migración. Companion changes
  OBLIGATORIOS: (1) **degradar explícito** — `try/catch`; si la subida falla, enviar el HTML original
  (con data:) + log/métrica, NUNCA bloquear el correo ni stripear el `<img>`; (2) `baseUrl` =
  `env.FRONTEND_URL` (ya existe, no derivar de headers); (3) mantener el externalize al guardar (preview
  inmediato); (4) NO escribir-back la firma como side-effect del envío (race con PATCH concurrente) — sí
  persistir las imágenes (assets dedup'd por sha256). Opcional: script one-shot de backfill (patrón
  `admin-grant.ts`). Seguridad de la ruta pública `/api/signature-images/:id` (sin auth, semi-pública):
  rate-limit + **cuota de almacenamiento por usuario** + considerar UUID en vez de ObjectId (anti
  enumeración/IDOR). El usuario eligió el parche simple (re-guardar la firma) para el caso inmediato.
- **TD-AUTH-BOOTSTRAP-RESIDUAL (LOW, review B/C/D)** — el bootstrap admin (primer usuario creado queda
  admin si no hay ninguno) quedó endurecido a `isNew` + `$setOnInsert` (cierra el HIGH de promover
  existentes; B 8/D 8). Residuales aceptados, no-HIGH: (1) **race** de dos primeros logins de emails
  distintos → ambos admin (nil en single-org: el operador hace el 1er login; full-atómico requeriría un
  marker durable "bootstrap claimed"); (2) **ceremonia** — el modelo "1er login = admin" asume que el
  primer login lo hace el operador (si la app queda pública antes, cualquier credencial IMAP válida
  reclama admin) → documentar en el runbook del provisioner; (3) **audit persistido** — hoy hay warn
  estructurado + counter Prometheus; un evento auditable en DB (no sólo logs) sería más robusto; (4)
  **trustProxy** (B) — el rate-limit por IP del login sólo es confiable detrás de nginx/traefik que
  pisa `X-Forwarded-For`; verificar que el API nunca se exponga directo.
- **TD-SELFUPDATE-SCALE (LOW/escala, review C 7.5/D 6)** — el chequeo de actualización (Fase 1) ya tiene
  cache L1+L2 (Redis compartido) + TTL-corto-en-fallo + REPO validado. Residuales para escala 10x /
  resiliencia, NO bloqueantes para single-box: (1) **token GitHub opcional** (`UPDATE_GH_TOKEN` PAT →
  5000/h en vez de 60/h no-auth) — el fix de raíz del rate-limit si hay MUCHAS réplicas/instalaciones
  tras un mismo IP; (2) el **piso de force es por-réplica** (in-memory) → un admin clickeando "Buscar
  ahora" en round-robin puede pegarle a N réplicas; un lock NX en Redis lo haría cluster-wide; (3)
  respetar `X-RateLimit-Reset`/`Retry-After` para backoff real (hoy reintenta cada 60s); (4) `WORKFLOW
  = 'docker.yml'` hardcodeado → si renombran el archivo, 404 silencioso y todas las instalaciones dejan
  de chequear sin alerta → env-config `UPDATE_WORKFLOW` + log.warn en 404 persistente; (5) subtleza: si
  el job `smoke` falla con `build` OK (igual pusheó `:latest`), el run queda `conclusion=failure` → el
  check sub-reporta (nunca falso-positivo) → consultar la conclusion del job `build`, no del run.
- **TD-SELFUPDATE-FASE2 (feature, requiere review B/C/D)** — auto-update estilo WordPress de 1 click.
  La Fase 1 (aviso "hay build N nuevo" en el admin, sólo lectura vía la API de GitHub) ya está. La
  Fase 2 = APLICAR la actualización (pull de las imágenes + recreate) desde el botón. Diseño propuesto
  (NO darle el socket de Docker a la API — superficie enorme): un **sidecar updater** chico en el
  compose (con el socket o el docker CLI) que ESCUCHA un pedido del admin (clave Redis / endpoint
  interno / archivo en volumen compartido) y ejecuta `docker compose pull web api && up -d web api`
  desde `/opt/bifrost/deploy/example-mailserver`. La API (admin) sólo SETEA el pedido; el updater
  ejecuta (privilegio aislado). Consideraciones a revisar: auth del canal API→updater (que no lo
  dispare cualquiera), versión objetivo (pinear el tag exacto, no `:latest` ciego → reproducible +
  rollback), healthcheck post-update + rollback automático si el nuevo build no levanta, downtime
  (~30s, avisar en UI), migraciones de DB que un update pudiera requerir, y que el updater NO pueda ser
  usado para correr imágenes arbitrarias (validar el repo/tag origen). Topología del box: stack
  docker-compose en `/opt/bifrost/deploy/example-mailserver`, imágenes `ghcr.io/hrefcl/bifrost/{web,api}`.
- **TD-THREADING-UI / backfill (review B/C/D)** — el threading (write-side + endpoint /emails/thread/:id
  + inbox agrupado) ya está (B 7.5/C 7/D 6). **Backfill RESUELTO** (HIGH de C): el sync re-fetchea
  automáticamente los emails existentes sin threadId (RETHREAD_CAP=2000/folder/sync) → el inbox
  histórico se enhebra solo en los próximos syncs tras el upgrade, sin acción del operador. Pendientes
  no-bloqueantes: (2) **pane
  apilado** — hoy abrir un hilo muestra el mensaje más reciente; falta la vista Gmail de toda la
  conversación apilada (cargar GET /emails/thread/:id, colapsar viejos); (3) **marcar-leído por hilo**
  (hoy sólo el mensaje abierto); (4) **grouping paginado** — colapsa sobre lo cargado; un mensaje de
  otra página agrupa al cargarse → para escala, colección `Thread` denormalizada + cursor por max-date
  del hilo (MED de C); (5) **normalización de Message-ID** (MED de C) — hoy se conservan `<>` y no se
  lowercasea el dominio; un cliente no-compliant podría no joinear; (6) **fallback por Subject**
  (Re:/Fwd: normalizado) para mensajes sin References/In-Reply-To (decisión de scope, JWZ lo hace).
- **TD-QUOTE-COLLAPSE (MED, review B 6.5/C 7/D 6)** — el colapso de citas "···" cubre los markers de
  alta confianza (Gmail/Apple/Thunderbird/Yahoo/Proton/OWA) con corte cut-from-node, falla "hacia
  mostrar de más" y el sandbox sin allow-scripts neutraliza mXSS. Refinamientos pendientes: (1)
  **recall de Outlook desktop/Word** (estilos border-top, `#OLK_SRC_BODY_SECTION`, `x_`-prefijados) y
  **Zimbra** (`hr[data-marker="__DIVIDER__"]`) — talon los reconoce; (2) **forwards** — `#appendonsend`/
  `.OutlookMessageHeader` pueden marcar un FORWARD cuyo contenido es payload legítimo → si el usuario
  pone "FYI" arriba, se escondería el forward (B: MED, HIGH en bottom-posting/inline-reply donde el
  texto nuevo va DEBAJO del marcador y se ocultaría); (3) **fallback textual** estilo talon
  (delimitadores "On … wrote:"/"El … escribió:" + heurística de líneas) para citas sin markers; (4)
  **mXSS (C, MED no-HIGH)** — el re-parse/re-serialize de DOMParser podría des-sanear un fragmento
  crafteado; mitigado por el sandbox, pero lo ideal es re-pasar `main`/`quoted` por el sanitizer del
  backend antes de renderizar. Validar todo contra un corpus real de .eml.
- **TD-S3-TURNKEY-RESIDUAL (review B/D)** — S3 turnkey con el rol del EC2 (IMDS, sin claves) ya está
  (B/D empujaron el rol sobre IAM-user). Residuales no-bloqueantes: (1) **admin UI** — el wizard de
  storage no muestra/permite el modo "rol del EC2" (sólo claves estáticas); en AWS no hace falta tocarlo
  (lo siembra el boot), pero si el admin abre y guarda, el schema exige claves → soportar instance-role
  en la ruta/UI; (2) **DeletionPolicy Retain** en bucket+CMK para PROD (B: HIGH para datos reales —
  borrar el stack hoy borra el bucket/clave → adjuntos perdidos/ilegibles; para el test fresco da igual);
  (3) **IAM eventual consistency** — la primera escritura S3 podría fallar segundos tras crear el rol;
  el provisioner debería smoke-testear un put→get→delete antes de declarar éxito; (4) **bucket policy
  que exija header SSE-KMS** rompería el PutObject (hoy usa default encryption — OK, pero verificar al
  endurecer); (5) S3 no-AWS (MinIO/R2) sigue por claves estáticas vía el wizard admin.
- **TD-PROVISION (PR-E)** — provisioning de buzones desde el admin (feature-gated). Es la única
  feature pendiente. RCE-remoto (SSH/API a docker-mailserver), no integration-testeable local.
  Diseño en `admin-config-y-providers.md §5/E`. Slice segura inicial: interfaz `ProvisioningProvider`
  + feature-gate + default "none".
- **TD-CI-PIN** — pin de GitHub Actions por SHA (requiere Dependabot); alinear `docker.yml`
  (`ubuntu-latest`→pin + `timeout-minutes`).
- **TD-MAIL-STARTTLS-REQUIRED (LOW)** — el `secure=false` del login es STARTTLS *oportunista*, no
  *requerido*; un MITM podría forzar downgrade a texto plano. Hardening: modo `requireTLS` explícito en
  el cliente IMAP/SMTP de la API cuando `secure=false`. No-HIGH (B lo dejó como residual de pulido en
  la re-validación de F-E). El cliente local al `mail.<dominio>` ya usa 465/993 (TLS directo) por def.
- **TD-PROVISION-LE-RATELIMIT (MEDIUM, op)** — el compose usa el endpoint **producción** de Let's
  Encrypt sin fallback a staging. Un loop de redespliegue (box recreado/EBS nuevo) quema el rate-limit
  de LE (5 certs duplicados/semana/dominio) → sin TLS por hasta una semana. Mitigación: flag/​env para
  usar `acme.caserver` staging en pruebas, o documentar el riesgo en el wizard. Riesgo real para un
  turnkey donde el usuario podría reintentar. (Hallado en re-auditoría 3-lentes, lente operador-3AM.)
- **TD-PROVISION-CLONE-PIN (MEDIUM → plumbing HECHO, falta cablear release)** — el user-data hacía
  `git clone --depth 1` de `main` HEAD → un `main` roto rompía TODA provisión nueva. **Resuelto el
  plumbing**: `buildUserData` acepta `ref` (branch o tag), emite `git clone --depth 1 --branch "<ref>"`
  (escapado anti-inyección), default `main`. Tests en `user-data.test.ts`. **Pendiente (cuando exista
  el sistema de releases que pidió el PM):** que el wizard pase el ÚLTIMO TAG de release en vez de
  `main` → provisión reproducible. Hoy default `main` = sin cambio de comportamiento (no hay releases).
  Revisión B **9.5/10 0-HIGH (APPROVED)**: fast-fail con `git check-ref-format` + `signal_fail` explícito
  (un ref inválido avisa a CFN YA, no por timeout de 15 min del CreationPolicy) + guard
  `case "$REF" in refs/*)` que rechaza la forma totalmente-calificada ANTES del clone (permite nombres
  cortos con slash como `release/1.2`). D 8/10 APPROVE; C TEAM_UNAVAILABLE (z.ai 529). Reproducibilidad fuerte (B-LOW): los tags no son inmutables → para
  garantía dura, proteger el tag o verificar tag/commit firmado.
- **TD-PROVISION-SED-ESCAPE (LOW, defensa en profundidad)** — los valores domain/mailHostname/
  adminEmail se escapan para bash (`sh()`) pero se usan como **reemplazo en `sed`**; `/ & \` romperían
  el sed. NO explotable: `validateDomain` restringe el dominio a `[a-z0-9-]`+puntos. Endurecer
  escapando chars sed-especiales sería defensa en profundidad, pero el cambio toca el bootstrap crítico
  (no testeable sin box) → diferido. (Re-auditoría 3-lentes, lente auditor hostil — cerrado por validación.)
- **TD-PROVISION-CFN-CI — HECHO (gate de CI implementado)** — los artefactos del turnkey (template
  CloudFormation + user-data bash) que genera el provisioner ahora se validan en **cada push** vía
  `ci.yml`: `scripts/emit-artifacts.mjs` los emite y corre `cfn-lint --non-zero-exit-code error`
  (sólo un ERROR de CFN-spec rompe; los W1030 falsos-positivos por defaults vacíos guardados por
  `Fn::If`/`Condition` se muestran pero no rompen) + `shellcheck --severity=warning` (infos SC2015
  [retry idiom seguro] / SC1091 [/etc/os-release] no rompen). Atrapa regresiones que romperían el
  deploy real en AWS y que los unit tests NO ven (validez CFN-spec / sintaxis+semántica de shell) —
  estas validaciones manuales encontraron 2 bugs reales (Rule subnet/VPC, readiness sin signal a CFN).
  Verificado localmente con cfn-lint 1.46 + shellcheck 0.11 (`pnpm --filter provisioner emit-artifacts`).
- **TD-PROVISION-SUBNET-VPC-MEMBERSHIP (LOW, límite de CFN — documentado)** — la `Rule`
  `SubnetRequiredWithExistingVpc` obliga a pasar ambos `ExistingVpcId`+`ExistingSubnetId` juntos, pero
  NO valida que el subnet PERTENEZCA a esa VPC (una CFN Rule sólo asierta parámetros, sin lookups AWS).
  No es fallo silencioso: el wizard lista subnets de la VPC elegida (imposible mismatch por CLI), y en
  deploy standalone CloudFormation RECHAZA el launch si la subnet es de otra VPC (error menos elegante,
  no silencioso). Pre-validarlo exigiría un custom resource Lambda → desproporcionado. (Hallazgo D 8/10
  RESUELTO sobre el bug principal; este residual es límite intrínseco de CFN, no HIGH abierto.)
- **TD-INBOUND-ATTACH-PERF** — descarga de adjuntos entrantes re-fetchea+parsea el MIME completo
  por adjunto (tradeoff consciente de no persistir inbound; mitigado por cap de 25MB).

### TD-UI-MAQUETA (UI COMPLETA, falta review B/D — hallada en auto-auditoría #7)
La UI implementada era un MVP funcional plano que **no coincidía con la maqueta**
(`maqueta/Webmail 6.0/`, prototipo React pulido). **Reconstruida por completo (auto-auditorías
#8–#12).**

**Base:** sistema de diseño con tokens de la maqueta (`src/assets/theme.css`, accent `#1b66ff`,
Public Sans, light/dark), **marca Bifrost parametrizable** (`src/config/brand.ts`, env
`VITE_BRAND_*`), **i18n completo** (`vue-i18n`, español por defecto + inglés, conmutable;
`src/i18n/`), componentes (AppIcon/AppAvatar/AppLogo).

**Los 7 views reescritos a la maqueta + i18n, cableados a datos reales:** Login (account card),
shell/TopBar (logo, búsqueda, iconos, avatar con menú idioma+logout, shield admin solo-rol),
Inbox (sidebar iconos/contadores reales, categorías, filas avatar/estrella/preview/adjunto,
panel lectura), Composer (estilo Gmail, adjuntos+guard, reply/forward), Settings (dos paneles;
Tema/Idioma/**acento configurable en runtime**/Firma/Seguridad), Contacts (lista con avatares),
Calendar (header + agenda), Admin (wizard storage local/S3).

**Bugs reales hallados al verificar (no teatro de MD):** (a) flake e2e admin = **rate limit
100/min** agotado por la suite serial (no "timing/TTL" como decían sesiones previas) → env-gated;
(b) **crear evento de calendario estaba 100% roto** (datetime-local ≠ ISO `.datetime()` → 400)
→ fix conversión a ISO, verificado POST 400→200.

Verificado: unit web 7/7 + api 147/147, **e2e 10/10 estable (×3)**, typecheck+lint+build limpios,
screenshots de los 7 views vs maqueta. El e2e fija `locale=en` sólo para determinismo (toda la
UI está i18n).

**Pendiente:**
1. **Review B+D del rebuild completo** (regla de oro: no cerrar fase sin B+C+D). Único bloqueante
   para declarar la fase cerrada.
2. Afordances visuales no funcionales (mirror de la maqueta): categorías Novedades/Promociones
   (sin categorización en backend), búsqueda (filtra sólo la carpeta cargada en cliente), iconos
   posponer/etiquetar/imprimir/filtrar/más.
3. Branding **runtime** editable por admin (además del build-time + el acento por-usuario ya hecho).
4. Cobertura e2e de Contacts/Calendar (hoy sin specs propios).

Para verlo: `pnpm demo`.
