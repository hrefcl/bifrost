# Plan Técnico Consolidado — Webmail 6.0

> Documento de Fase 2 del sistema multi-equipo A/B/C/D. Consolida la auditoría independiente de
> Equipo A (Claude Code), B (Codex), C (z.ai GLM) y D (Kimi) sobre la **realidad operativa** del
> sistema (no lo que afirman los `.md`). Objetivo del PM: dejar el proyecto **funcionando de
> verdad**, hecho **de la forma correcta y bien a nivel de arquitectura** (no por rapidez).
>
> Fuente de verdad: el **código** + `docs/webmail-6.0-documento-funcional.docx`.

## 1. Diagnóstico: estado real vs documentado

`pnpm typecheck/lint/build/test` → **verdes**, pero la suite cubre solo crypto/health/setup: **9 tests
en total en el workspace** (api 6 — crypto 4, setup 1, health 1; web 2; shared 1). "Integración y E2E"
de los docs es **inexistente**. El proyecto **compila y bootea**, pero
el **core operativo de un webmail no funciona de verdad**: no se puede leer un email legible, el envío
puede duplicar y no deja copia en Sent, el primer setup deja credenciales irrecuperables, y hay fuga
de datos entre tenants.

Las dependencias `postal-mime` y `bullmq` están declaradas pero **sin un solo import** en el código.

## 2. Hallazgos consolidados (convergencia A/B/C/D)

Severidad final por acuerdo; "Equipos" indica quién lo detectó (la coincidencia refuerza severidad).

### HIGH (bloqueantes)

| ID | Hallazgo | Evidencia | Equipos |
|----|----------|-----------|---------|
| **H-SEC-IDOR** | **Fuga de lectura cross-tenant** sin verificar `userId`: `GET /emails/:id` metadata (`emails.ts:42`, solo `findById`); `GET /accounts/:id/folders` (`accounts.ts:126`, `Folder.find({accountId})`); `GET /accounts/:id/folders/:fid/emails` (`accounts.ts:145`); y corrupción de integridad: folder-sync valida la cuenta (`accounts.ts:137` ✓) pero **no** asserta que `folderId` pertenezca a esa cuenta (`accounts.ts:141`→`imap.ts:115`). `GET /emails/:id/body` (`emails.ts:60`) **ya** valida ownership; solo migra al helper. | emails.ts, accounts.ts, imap.ts | A,B,C,D |
| **H-CRYPTO-SETUP** | En modo setup `crypto.ts:9` usa `Buffer.alloc(32)` (clave de ceros). El admin se crea cifrando credenciales con esa clave; luego `env-writer` genera un `ENCRYPTION_KEY` aleatorio → tras reiniciar, **credenciales IMAP/SMTP del admin irrecuperables**. El wizard brickea la 1ª cuenta. | `setup-service.ts:38-104`, `crypto.ts`, `env-writer.ts` | D |
| **H-DATA-TTL** | Índices TTL borran datos solos: `User.ts:49` `expireAfterSeconds:63072000` (usuarios a los 2 años); `Draft.ts:68` `2592000` (drafts a los 30 días). Pérdida de datos silenciosa. | `User.ts:49`, `Draft.ts:68` | D |
| **H-BODY** | Parseo de email = stub: `getMessageBody` devuelve RFC822 crudo como `text`, no usa `postal-mime`, `html` siempre `undefined`; **no abre el mailbox** del folder antes de `fetchOne(uid)` (UID es por-carpeta) → lee casilla equivocada o falla; `sanitizedHtml: body.html` sin sanitizar. | `imap.ts:206`, `emails.ts:55,65` | A,B,C,D |
| **H-SYNC** | Sync IMAP no incremental: siempre `fetch(seq '1:limit')` (los más viejos), sin UIDVALIDITY/UIDNEXT/HIGHESTMODSEQ/CONDSTORE, sin expunge ni delta de flags; estado de folder persiste en 0. | `imap.ts:79,110,132` | A,B,C,D |
| **H-SEND** | Envío no confiable: sin idempotencia (doble click o reenvío de `sent` → doble mail), sin dedupe tras fallo parcial (no persiste `sentMessageId`), **sin copia a Sent** (no `APPEND`), sin cola BullMQ ni reintentos. | `smtp.ts`, `drafts.ts:133-159` | A,B,C,D |
| **H-AUTH-ROT** | Rotación de refresh token no atómica (get→check→setex): dos refresh concurrentes del mismo token emiten ambos token nuevo y **bypassean la detección de reuse**. | `auth.ts:135` | A,B,C,D |
| **H-OPS-PREFIX** | **Contrato de routing `/api` roto en dev y prod.** App usa `axios baseURL:'/api'` (`stores/auth.ts:7`) pero el backend registra rutas SIN prefijo `/api` (`app.ts:52`). Vite proxya `/api` **con** `rewrite` que quita `/api` (`vite.config.ts`), pero `main.ts:11`/`SetupWizard.vue:49` llaman `/setup/*` **sin** `/api` → no proxeado → setup roto en dev. En prod nginx pasa `/api` **sin** strip → 404, y `/setup/*` cae al SPA. Hay 2 apps Fastify (`buildApp`/`buildSetupApp`). | `app.ts:52`, `setup/index.ts`, `nginx.conf:11`, `vite.config.ts`, `main.ts:11`, `SetupWizard.vue:49` | B |
| **H-SETUP-CREDS** | El wizard (`SetupWizard.vue:49-63`) envía la config de correo **sin password**; `performSetup` usa `payload.admin.password` como credencial IMAP/SMTP (`setup-service.ts:89`). Si la password del admin ≠ la del buzón, la 1ª cuenta queda **inservible** aun arreglando la clave de cifrado (TD-2). | `SetupWizard.vue:49`, `setup-service.ts:89`, `setup-service.ts:6-30` | B |

> **Corrección de severidad (acuerdo C+D, verificado en código):**
> - **H-USER-RACE → MEDIUM** (no HIGH). `primaryEmail` SÍ es único (`User.ts:16`) y `Account.email` SÍ es único (`Account.ts:90`); dos logins concurrentes **no** crean duplicados — el 2º recibe `E11000` no manejado → 500 (problema de *fiabilidad*, no de integridad). Ver M-USER-RACE.
> - **Calendar IDOR → MEDIUM** (no HIGH). `POST/PATCH /calendar` acepta `accountId` ajeno en el body, pero **todas las lecturas están scopeadas por `userId`** (`calendar.ts:29,54,69,83`) → no hay fuga cross-tenant, solo integridad referencial. Ver M-CAL-OWN.
> - **CSRF (a confirmar antes de F3.6):** con `credentials:true` + cookie de refresh (`app.ts:37,41`) revisar `SameSite`/anti-CSRF; si el refresh viaja en cookie sin protección, sería un HIGH ausente.

### MEDIUM

| ID | Hallazgo | Evidencia |
|----|----------|-----------|
| M-REDIS-KEYS | `revokeTokenFamily` usa `redis.keys()` O(N) bloqueante; debe usar set por `familyId` o SCAN | `auth.ts:185` |
| M-RATE | Rate limit global 100/min `skipOnError`, sin límites estrictos en `/auth/login`,`/auth/refresh`,`/setup/*`, no distribuido | `app.ts:43` |
| M-ZOD | `ZodError` → 500 en vez de 400 (sin mapeo en error handler) | `app.ts:60` |
| M-POOL | Sin pool IMAP ni timeouts; transporter SMTP sin cerrar ni pool/timeout | `imap.ts:32`, `smtp.ts:8` |
| M-STUCK | Draft puede quedar `sending` eterno (crash entre saves); sin timeout SMTP ni barrido de recuperación | `drafts.ts:147`, `smtp.ts` |
| M-STATE | `PATCH /drafts/:id` no resetea `sent`/`failed`→`editing`; `GET /drafts` lista enviados como borradores | `drafts.ts:102,56` |
| M-FOLDER-OWN | `syncFolderHeaders` no asserta `folder.accountId===account._id` | `imap.ts:115` |
| M-SECRETS | Secretos en `.env` plano, sin secrets manager/rotación/versión de clave | `env-writer.ts`, `crypto.ts` |
| M-USER-RACE | `loginOrRegister` hace `findOne→create` (User y Account) sin manejar `E11000`; logins concurrentes del mismo email nuevo → 2º request 500 + estado parcial. Fix: `findOneAndUpdate(upsert)` atómico. | `auth.ts:62-75` |
| M-CAL-OWN | `POST/PATCH /calendar` acepta `accountId` del body sin assertar que la cuenta sea del user (integridad referencial; sin fuga, reads scopeados). | `calendar.ts:40,64` |
| M-TOKEN-STORE | `accessToken` en `localStorage` (`stores/auth.ts:12,19,44`), contra diseño BFF. Con render de HTML hostil de emails (F3.3/F3.8) → riesgo de exfiltración por XSS. Debe resolverse en **F3.6, antes de F3.8** (token en memoria + refresh por cookie). | `stores/auth.ts:12` |

### LOW
attachmentCount/preview/references inertes (`imap.ts:190,199`); no purga folders eliminados; doble `logout()` en verify; `from` SMTP sin quotar; `replyToEmailId` sin validar ownership; body sin tope de tamaño; `cid:` fuera de allowedSchemes; tipado frágil de `request.user`.

## 3. Decisiones de arquitectura (PRODUCT/TECH DECISIONS)

- **TD-1 Authz centralizada**: introducir helpers de ownership (`requireOwnedAccount(userId, accountId)`,
  `requireOwnedEmail`, `requireOwnedFolder`) en una capa única, en vez de repetir checks. Toda query de
  recurso pasa por ahí. Trade-off: refactor de varias rutas; ganancia: imposible olvidar un check.
- **TD-2 Cifrado (reformulada — C señaló que la v1 NO arreglaba el bug).** Causa raíz: `crypto.ts:9`
  liga `KEY` como `const` **al importar el módulo**; escribir el `.env` en el mismo proceso no cambia el
  KEY en memoria (sigue en ceros). Fix correcto = **eliminar la clave de ceros y cargar la clave de forma
  perezosa/dinámica**: `crypto` no debe poder cifrar credenciales reales sin una `ENCRYPTION_KEY` válida.
  Concretamente: (a) que `encrypt`/`decrypt` resuelvan la clave en cada llamada (no `const` de módulo) y
  **lancen** si no hay clave válida; (b) en el flujo de setup, **generar y persistir
  `ENCRYPTION_KEY`/`JWT_SECRET` ANTES** de instanciar `crypto`/crear el Account — o partir el setup en
  `write-env → restart → create-account` para que el proceso que cifra ya tenga la clave definitiva.
  Nunca cifrar credenciales con `Buffer.alloc(32)`. Añadir `keyId` al payload para rotación futura.
  **Importante (B):** `randomToken`/`hashToken` viven hoy en `crypto.ts`, que valida la key al importar;
  separar las utilidades que NO necesitan `ENCRYPTION_KEY` (random/hash) de `encrypt`/`decrypt`, para que
  el setup pueda generar secretos sin instanciar el cifrado simétrico. Además **H-SETUP-CREDS**: el wizard
  debe capturar y enviar la password del buzón (separada de la del admin) y `performSetup` usarla como
  credencial IMAP/SMTP.
- **TD-3 TTL**: **eliminar** los índices TTL de `User` y `Draft` (retención no debe ser por TTL ciego).
  Si se quiere expiración de drafts, será una política explícita opt-in, documentada. Decisión: quitar.
- **TD-4 Sync IMAP**: modelo incremental basado en `UIDVALIDITY` + `uidNext`/`lastUid` por folder, con
  `CONDSTORE`/`HIGHESTMODSEQ` cuando el server lo soporte; fallback a UID range. Índice único
  `{accountId, folderId, uid}`.
- **TD-5 Envío**: cola **BullMQ** con worker, reintentos con backoff, transición de estado atómica
  (`findOneAndUpdate({status:'editing'}→'sending')`), persistencia de `sentMessageId`/`sentAt`,
  `APPEND` a Sent vía imapflow. **Semántica realista (B): SMTP no es exactly-once.** Generar y persistir
  el `Message-ID` **antes** de enviar; el job es idempotente y se acepta **at-least-once minimizado**
  (dedupe por `Message-ID`/estado), no exactly-once. El `APPEND` a Sent también debe ser idempotente.
- **TD-6 Auth**: rotación atómica con `GETDEL`/Lua; hash de refresh tokens en reposo; set `family:*`
  para revocación O(1); upsert + índice único de usuario; rate limits por endpoint con store Redis.
- **TD-7 Operación — contrato `/api` completo (B: hoy subespecificado).** Definir como un solo contrato
  coherente dev+prod: (1) Fastify registra **ambas apps** bajo `/api` → `buildApp` en `/api/auth`,
  `/api/accounts`, …; `buildSetupApp` en `/api/setup`. (2) Frontend: `main.ts` y `SetupWizard.vue` llaman
  `/api/setup/*` (usar la instancia axios con `baseURL:'/api'`). (3) Vite proxy: **quitar el `rewrite`**
  que elimina `/api` → forward `/api`→backend `/api`. (4) nginx ya pasa `/api` sin strip → queda alineado.
  (5) Revisar healthcheck de Docker (`/api/health`). Además: mapear `ZodError`→400; logging pino +
  request-id; `/api/metrics` y `/api/health`.

## 4. Plan de implementación por fases (orden por riesgo/dependencia)

Cada fase: implementar → typecheck/lint/test → review B(autoridad)+C+D → score ≥9 y sin HIGH → siguiente.
Los tests viven **inline en cada fase** (no al final). La infraestructura de test es precondición → F3.0.

0. **F3.0 — Harness de test + CI (precondición).** Configurar `mongodb-memory-server` + `ioredis-mock` +
   mocks de `imapflow`/`nodemailer`; helper `buildApp` para tests de integración; `ci.yml`
   (typecheck/lint/test/coverage/build) en PR y `main`. Sin esto, las fases siguientes no pueden correr
   sus tests por-fase. (C objetó con razón que tests/CI al final repite el pecado original.)
1. **F3.1 — Authz multi-tenant (H-SEC-IDOR) + contrato `/api` completo (H-OPS-PREFIX, TD-7 puntos 1-5)**
   + tests "A no ve B" y smoke de rutas `/api/*`. *Seguridad primero; el `/api` desbloquea validación
   tipo-prod temprana (C).*
2. **F3.2 — Setup/crypto correcto (H-CRYPTO-SETUP, H-SETUP-CREDS) + quitar TTL (H-DATA-TTL)**.
   *Pérdida de datos / 1ª cuenta inservible.* Aplica TD-2 reformulada + captura de password de buzón.
3. **F3.3 — Pipeline de cuerpo de email (H-BODY)**: mailbox open por folder, postal-mime, sanitización, cache Redis, endpoint attachments.
4. **F3.4 — Sync IMAP incremental (H-SYNC)**: UIDVALIDITY/uidNext/CONDSTORE, índice único `{accountId,folderId,uid}`.
5. **F3.5 — Envío confiable (H-SEND, M-STUCK, M-STATE)**: BullMQ, transición atómica, idempotencia, APPEND a Sent, pool/timeout.
6. **F3.6 — Auth hardening (H-AUTH-ROT, M-USER-RACE, M-REDIS-KEYS, M-RATE, M-TOKEN-STORE, CSRF)**:
   rotación atómica, upsert, set de familia, rate limits por endpoint, **token en memoria (no localStorage)
   ANTES de F3.8**, confirmar/cerrar CSRF. *Debe ir antes de renderizar HTML hostil (F3.8).*
7. **F3.7 — Operación (M-ZOD, M-SECRETS, M-CAL-OWN, observabilidad pino/metrics/health)**.
8. **F3.8 — Frontend: vista detalle de email** (store + render seguro + adjuntos + acciones).
9. **F3.9 — Cobertura objetivo + E2E Playwright + docker.yml/release** (consolidación final; el harness ya existe desde F3.0).

## 5. Plan de testing
- Integración con `mongodb-memory-server` + `ioredis-mock` + mocks de `imapflow`/`nodemailer`.
- Authz: por cada endpoint, test "usuario B no accede a recurso de A" (403/404).
- Idempotencia de envío: doble `/send` concurrente → un solo mail.
- Crypto/setup: ciclo setup→restart→login admin OK.
- E2E Playwright para flujos de UI; gates en CI.

## 6. Plan de rollback
Cada fase es un commit aislado y revertible. Cambios de índices (TTL drop, unique add) llevan
nota de migración. La autorización es backward-compatible (solo restringe acceso indebido). El
prefijo `/api` requiere desplegar API+nginx+cliente juntos (documentar).

## 7. Observabilidad mínima
Logging estructurado (pino) con request-id; métricas de cola de envío (jobs ok/fail/retry); health
checks IMAP/SMTP/Mongo/Redis; señal de éxito = email legible end-to-end + envío con copia en Sent.

## 8. Regresion Map — F3.1 Authz multi-tenant (validar por B antes de codear)

Cambio: introducir verificación de ownership por `userId` en lectura/escritura de Account/Folder/Email/Calendar.
Helper centralizado en **`packages/api/src/lib/authz.ts`** (`requireOwnedAccount`, `requireOwnedEmail`,
`requireOwnedFolder`), usado tanto en `routes/*` como en `services/imap.ts`.

| Componente | Tipo de dependencia | Riesgo de regresión | Cómo validar |
|------------|---------------------|---------------------|--------------|
| `routes/emails.ts` GET `/:id` | expone metadata de email (sin ownership) | MEDIUM (puede 404ear acceso legítimo si el join account/user falla) | test: dueño 200, user B 404 |
| `routes/emails.ts` GET `/:id/body` | ya valida cuenta parcialmente | LOW (migrar al helper centralizado) | test: dueño 200, user B 404; body sigue funcionando |
| `routes/accounts.ts` GET folders | expone folders sin ownership | MEDIUM | test ownership + Inbox del FE lista para el dueño |
| `routes/accounts.ts` GET folders/:fid/emails | expone emails sin ownership | MEDIUM | test: user B 404; dueño OK |
| `routes/accounts.ts` POST folders/:fid/sync | dispara sync de folder | MEDIUM (assert folder pertenece a la cuenta del user) | test: folder ajeno → 404; propio → sync OK |
| `routes/calendar.ts` POST/PATCH | crea/edita eventos con accountId | LOW (preexistía; se agrega assert accountId del user) | test: accountId ajeno → 404; propio → OK |
| `services/imap.ts` syncFolderHeaders | recibe folderId | MEDIUM (assert `folder.accountId===account._id`) | test: folder ajeno → error; propio → sync OK |
| `routes/drafts.ts` | ya valida userId en todo | LOW (solo en F3.1 se valida `replyToEmailId` ownership si aplica; quitar `accountId` de PATCH se difiere a hardening posterior) | tests drafts existentes siguen verdes |
| Frontend `stores/*`, `InboxView` | consume endpoints | LOW (contrato sin cambios para el dueño) | build web + smoke manual |
| Helper `lib/authz.ts` (nuevo) | nueva capa compartida | LOW | unit tests del helper |

**Componentes del contrato `/api` (parte de F3.1, además de authz):**

| Componente | Cambio | Riesgo | Cómo validar |
|------------|--------|--------|--------------|
| `app.ts` / `setup/index.ts` | registrar rutas bajo `/api` (`/api/auth`,`/api/setup`,…) | MEDIUM (rompe si algún caller no migra) | smoke `/api/auth/login`, `/api/setup/status`, `/api/accounts`, `/api/health` |
| `web/vite.config.ts` | quitar `rewrite` que elimina `/api` | MEDIUM (dev deja de resolver si no se alinea) | `pnpm --filter web dev` + login real contra API |
| `web/src/main.ts`, `SetupWizard.vue` | llamar `/api/setup/*` | MEDIUM | wizard detecta setup y completa en dev |
| `nginx.conf` | ya pasa `/api` sin strip → queda alineado | LOW | build prod + curl `/api/health` |
| docker healthcheck | apuntar a `/api/health` | LOW | `docker compose` healthy |

**Estrategia de tests (obligatoria en F3.1):** por cada endpoint que recibe un ID de recurso, test
"usuario B no accede a recurso de usuario A" → 404 (no se distingue inexistente de ajeno, para no filtrar
existencia). El dueño mantiene 200. **Caso explícito (B):** `accountId` propio + `folderId` de **otra
cuenta del mismo usuario** debe dar 404 (el assert es `folder.accountId===accountId`, no solo ownership de
la cuenta). Smoke de las rutas `/api/*` para validar el contrato de prefijo.

**Confirmación explícita:** F3.1 **NO altera esquemas Mongoose ni índices** — solo agrega lógica de
autorización en rutas/servicios y un módulo helper nuevo. Backward-compatible: solo restringe accesos
indebidos; el dueño no pierde acceso. Rollback = revert del commit.

**Modelo de tenancy (confirmado leyendo todas las rutas):** el sistema es single-tenant por `userId`; no
existen rutas admin ni de buzón compartido que crucen usuarios legítimamente (el "admin" del setup es un
usuario normal). Por tanto apretar ownership por `userId` no rompe ningún flujo legítimo.

## 9. Veredictos de revisión (Fase 2)
- **v1** → enviado a B/C/D.
- **D (Kimi):** 8/10 NOT APPROVE → condiciones documentales (conteo tests, H-USER-RACE, Regresion Map, no-schema). **Aplicadas en v2.**
- **C (z.ai):** 7.5/10 **APPROVE para F3.1** con condiciones bloqueantes para F3.2+ (TD-2 reformulada, F3.0 harness+CI primero, bajar H-USER-RACE y calendar a MEDIUM, CSRF, `/api` temprano). **Aplicadas en v3.**
- **B (Codex):** 8/10 NOT APPROVE sobre v3 → 7 condiciones (HIGH setup-creds, H-OPS completo /api+/setup+vite, localStorage→F3.6, TD-2 import-time, TD-5 at-least-once, TD-7 contrato completo, Regresion Map ampliado). **Aplicadas en v4.**
- A acepta y verifica en código todas las correcciones de B/C/D. **v4** incorpora todo; B aprobó **9/10**.

## 10. Bitácora de implementación

### F3.0 — Harness de test + CI · **APPROVED** (B 9.0 · C 9.0 · D 9.0)
Harness de integración extendido (`test/integration-helper.ts`: seeding users/cuentas/folders/emails, JWT, `resetState`, `buildSetupApp`) + mocks `imapflow`/`nodemailer`. CI (`ci.yml`) ya existía; se le agregó `test:coverage`.

### F3.1 — Authz multi-tenant + contrato `/api` · **APPROVED** (B 9.0 · C 9.0 · D 9.0)
- **H-SEC-IDOR cerrado:** `lib/authz.ts` (`requireOwnedAccount/Email/Folder`, `OwnershipError`→404). Aplicado en emails/accounts/calendar/drafts + defensa en profundidad en `imap.ts`.
- **H-OPS-PREFIX cerrado:** backend (ambas apps) bajo `/api`; Vite sin rewrite; frontend setup `/api/setup/*`; nginx alineado; healthcheck `/api/health`.
- Extras resueltos en QA: `ZodError`→400 (handler movido antes de las rutas), 404-no-403 consistente, paginación validada, mass-assignment endurecido, guard de JWT sin userId.
- **Bug pre-existente arreglado:** `CalendarEvent.organizer` required rompía la creación de eventos (500).
- 24 tests verdes. 3 rondas de QA (la ronda 2 destapó el HIGH del orden del error handler).
- Pendiente (no bloqueante, F3.2+): replyToEmailId solo se persiste con replyToMessageId; coverage API ~63%; calendar PATCH unique-index → 409.

### F3.2 — Setup/crypto + quitar TTL · **APPROVED** (B 9.0 · C 9.0 · D 9.0)
- **H-CRYPTO-SETUP cerrado:** `crypto.getKey()` lazy desde `process.env` (sin `const KEY`/`Buffer.alloc(32)`, valida charset hex). `performSetup` reusa secretos del `.env` (no rota), upsert idempotente que re-cifra, `writeEnvFile` atómico antes de `SystemConfig`, rollback de `process.env` ante fallo (no half-state). La 1ª cuenta ya no se brickea al reiniciar.
- **H-SETUP-CREDS cerrado:** wizard envía `email.password`, schema lo exige, se usa como credencial IMAP/SMTP.
- **H-DATA-TTL cerrado:** índices TTL removidos del schema + `reconcileLegacyIndexes()` los dropea en deploys existentes al arrancar (solo si son TTL).
- 31 tests (idempotencia, rollback window #3, reconcile TTL/no-TTL, crypto lazy). C trazó las 4 ventanas de fallo del setup.
- Pendiente no bloqueante: doble validación db/redis; concurrencia de doble-submit de setup (auto-cura).

### F3.2.1 — Boot real (tarea #11) · BLOQUEADO POR ENTORNO
Toda la verificación es por tests (app.inject + mongo-memory + mocks). Falta boot real del API/web; hoy bloqueado: Mongo no reachable y docker no disponible (redis sí). Reintentar cuando haya Mongo/docker.

### F3.3 — Parseo real de emails (postal-mime) · **APPROVED** (B 9.2 · C 9.0 · D 8.5)
- **H-BODY cerrado:** `fetchAndParseMessage` abre el mailbox del folder + postal-mime → text/html/adjuntos reales; `/body` devuelve sólo `sanitizedHtml` (no html crudo), caché Redis 1h (cap 256KB), metadata real vía `updateOne` (no pisa flags concurrentes). Endpoints `/attachments` (lista) y `/attachments/:id` (descarga forzada `attachment`+`nosniff`, anti-XSS, `filename*` RFC5987).
- Fixes de QA (3 rondas): XSS de adjunto inline, corrupción por fetch-miss (404 sin cachear/pisar), invalidación de caché en re-sync, ownership de folder, cap de memoria 25MB, guard de caché corrupta.
- 35 tests. Follow-ups (tech-debt #12): streaming real de adjuntos; UIDVALIDITY mismatch (→F3.4).

### F3.4 — Sync IMAP incremental · **APPROVED** (B 8.6 · C APPROVE · D 8.5)
- **H-SYNC cerrado:** `syncFolderHeaders` incremental real — UIDVALIDITY (wipe+resync si cambió), fetch liviano `1:*` (uid+flags) para reconciliar nuevos/expunged/flags, fetch completo sólo de nuevos, estado real del folder poblado. `listAndSyncFolders` ya no resetea el estado (`$setOnInsert`). Índice único `{accountId,folderId,uid}` con dedupe migration al arrancar.
- Hardening de QA (2 rondas): mutex en-proceso por folder (anti-interleave), `save()`→`updateOne($set)` (anti stale-write), chunking de fetch/`$in`/bulkWrite, dedupe legacy.
- 39 tests (incremental, mailbox vacío, concurrencia mutex, dedupe). Follow-ups (#14 lock distribuido Redis multi-instancia, #15 CONDSTORE/HIGHESTMODSEQ).

### F3.5 — Envío confiable · **APPROVED** (B 9.0 · C 8.5 · D 9.0)
- **H-SEND cerrado:** `/send` con transición atómica `editing|failed→sending` (idempotente: 'sent'→alreadySent, 'sending'→409), Message-ID determinista persistido antes de enviar, copia a Sent (APPEND del mismo raw, **bcc fuera del raw** → sin fuga), SMTP pool+timeout+close. Recovery de colgados (al boot + periódico). PATCH rechaza 'sending' (409). GET lista solo editing/failed.
- **PRODUCT DECISION:** cola BullMQ diferida (tech-debt #16) — el HIGH de doble-envío se resolvió síncrono; la cola es resiliencia de reintentos, no corrección.
- 47 tests (idempotencia, concurrencia editing/failed, sin-destinatarios, PATCH-sending-409, Bcc-not-in-raw, recovery).

### F3.6 — Auth hardening · **APPROVED** (B 8.8 · C 8.5 · D 8.5)
- **H-AUTH-ROT cerrado:** rotación atómica con GETDEL (sella la race), token = `userId.familyId.rawId.HMAC` (rawId hasheado en reposo, HMAC anti-forja/DoS), reuse → revoca familia. M-REDIS-KEYS: sin `redis.keys()` (family set + token auto-descriptivo). M-USER-RACE: upserts `{primaryEmail}`/`{email}` + retry E11000. M-RATE: login 10/min, refresh 30/min. M-TOKEN-STORE: accessToken en memoria + `restore()` por cookie + refresh single-flight. CSRF: SameSite=Strict (confirmado).
- Hardening de QA (2 rondas): HMAC del envelope (anti-DoS de revocación), filtro de upsert alineado al índice, /logout sin auth, single-flight, verifyHmac hex-safe.
- 53 tests (rotación, reuse, concurrencia GETDEL, token forjado, login concurrente, Unicode-mac). Follow-ups: tech-debt #18.

### F3.7 — Operación/observabilidad · **APPROVED** (B 9.0 · C 9.0 · D 9.0)
- Logging pino estructurado SIEMPRE en dev/prod (antes apagado fuera de dev → prod sin logs), config compartida `config/logger.ts` con redacción de authorization/cookie/api-keys (incl. app de setup), reqId. `/api/metrics` (Prometheus: uptime/memoria/requests/5xx + histograma de latencia), denegado al público en nginx (regex). Health detallado existente.
- **BOOT REAL ejecutado (tarea #11):** server en `NODE_ENV=production` contra mongod (memory-server) + Redis real → `/api/health` 200 `{mongodb,redis: connected}`, `/api/metrics` 200, `/api/setup/status` 200, `/api/accounts` sin token 401, logging de prod activo, reconcile de índices al boot OK. El contrato `/api` funciona en server real.

### F3.8 — Frontend: vista detalle de email · **APPROVED** (B 8.0 · C APPROVE · D 9.0)
- Backend: `PATCH /api/emails/:id/flags` (marcar leído, IMAP+DB), `DELETE /api/emails/:id` (move-to-Trash + borra DB + invalida caché), ambos con ownership (testeados). `imap.ts`: setEmailSeen/moveEmailToTrash.
- Frontend (`InboxView.vue` 3 paneles): leer body (v-html de `sanitizedHtml`, fallback text), descarga AUTENTICADA de adjuntos (blob+Bearer), marcar-leído auto, eliminar, responder/reenviar. Race-guard en openEmail, revoke diferido, CSP en nginx (script-src 'self' anti-XSS).
- 57 tests backend. Follow-ups (#20): imágenes remotas, Trash localizado, tests de componente Vue.

### F3.9 — CI/cobertura/docker · **COMPLETADA (fase)** (B/C APPROVE-fase · D APPROVE)
- **Bugs reales de build arreglados** (los `.md` decían "CI/CD no implementado", pero existía y NO buildeaba): `Dockerfile.api`/`Dockerfile.web` no copiaban `pnpm-lock.yaml` (→ `--frozen-lockfile` fallaba) ni `tsconfig.build.json` (→ `tsc -p` fallaba). `docker.yml` ignoraba los tags de metadata (solo `:sha`) → ahora metadata por imagen con semver/`latest` + `permissions: packages:write`. Nuevo `.dockerignore`.
- **Gate de cobertura API** enforced (`vitest.config.ts`: 75/65/80; real ~87/78/90 con excludes) vía `test:coverage` en CI. `web`/`shared` sin gate aún (deuda TD-COVERAGE-WEB).
- E2E: smoke de UI de login existente (corre en `e2e.yml` con servicios Mongo/Redis).
- **GATES DE PRODUCCIÓN PENDIENTES (no declarados hechos):** ver `docs/deuda-tecnica.md` — **TD-E2E** (E2E real login→leer→enviar, falta wirear API en Playwright) y **TD-DOCKER-VERIFY** (`docker build/run` real — docker no disponible en este entorno; lo corre CI). El producto **funciona** (boot real verificado + 57 tests + todas las features), pero estos 2 gates deben cerrarse antes de declararlo production-ready.
