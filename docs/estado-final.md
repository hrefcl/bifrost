# Webmail 6.0 (Bifrost) — Estado del proyecto

> **Fuente de verdad del estado actual.** Última actualización: jun 2026.
> Generado y verificado contra el código (no contra otros .md): `main` limpio, CI verde,
> `pnpm audit --prod` sin vulnerabilidades, 146 tests API + 9 E2E pasando.

Webmail 6.0 es un **frame de webmail (reemplazo de Roundcube)** que corre sobre cualquier
servidor de correo IMAP/SMTP. No implementa el servidor de correo: provee la UI + API que se
conecta al backend de mail del cliente, con un subsistema de **administración configurable**
(storage de adjuntos local/S3, cuenta admin, wizard) al estilo WordPress/Roundcube.

---

## 1. Nivel de avance — resumen ejecutivo

| Área | Estado |
|------|--------|
| **Core webmail** (auth, IMAP sync, leer, componer, enviar, drafts, reply/forward, firmas) | ✅ Funcionando, verificado E2E en navegador real |
| **Adjuntos end-to-end** (subir → adjuntar → enviar; descargar inbound) | ✅ Funcionando |
| **Admin + storage configurable** (wizard local/S3, credenciales cifradas, GC, cuota, test de conexión) | ✅ Funcionando |
| **Contactos / Calendario (CalDAV)** | ✅ CRUD + sync |
| **Seguridad** (authz multi-tenant, JWT hardening, XSS, CSP, rate limit, cifrado, sin CVEs) | ✅ Auditado (5 rondas B/D) |
| **CI/CD** (typecheck, lint, tests, coverage, E2E, docker-smoke, **audit gate**) | ✅ Verde |
| **Provisioning de buzones** (crear cuentas email desde admin) | ⏳ Pendiente (PR-E, feature-gated) |

**Madurez:** producto **funcional y hardened**; los 3 gates de producción originales cerrados
(sync-OOM, E2E, docker). Falta sólo la feature opcional de provisioning para el caso self-hosted
completo. Validación contra un servidor de correo / bucket S3 **real** es responsabilidad del
operador (no testeable en CI).

---

## 2. Arquitectura

Monorepo **pnpm workspaces**:

- **`packages/shared`** — tipos TypeScript compartidos (fuente de verdad del dominio).
- **`packages/api`** — backend **Fastify 5.2** + **Mongoose 8.9** (MongoDB) + **Redis** (ioredis,
  mock en tests). JWT, multipart, helmet, CORS, rate-limit.
- **`packages/web`** — frontend **Vue 3.5** + Vite + Pinia + **TipTap** (editor rico) +
  Playwright (E2E).

Patrones clave:
- **Providers pluggables + feature-gating** (storage local/S3; provisioning a futuro) — el mismo
  seam que `services/mail-transport.ts` usa para IMAP/SMTP (permite fakes en E2E).
- **Provider-bound blobs**: cada `AttachmentBlob` guarda su `providerType` → las lecturas van
  SIEMPRE al provider de origen aunque el activo cambie.
- **Cifrado AES-256-GCM** para credenciales (IMAP/SMTP, secret S3) con `ENCRYPTION_KEY`.
- **SystemConfig** (key/value en Mongo) para config global (storage activo).

### Modelos (MongoDB)
`User` (role user/admin) · `Account` (IMAP/SMTP cifrado) · `Folder` · `Email` · `Draft` ·
`AttachmentBlob` (status active/deleting, lastReferencedAt — lifecycle del GC) · `Contact` ·
`CalendarEvent` · `SystemConfig`.

### API (rutas)
`auth` · `setup` · `accounts` · `emails` · `drafts` · `attachments` · `admin` · `contacts` ·
`calendar` · `health` · `metrics`.

### Web (vistas)
`Login` · `SetupWizard` · `Inbox` (3 paneles) · `Composer` · `Admin` (wizard de storage) ·
`Contacts` · `Calendar` · `Settings`.

---

## 3. Funcionalidades entregadas (detalle)

### 3.1 Autenticación y sesión
- Login que provisiona usuario+cuenta contra IMAP real (verifica credenciales).
- JWT con **rotación atómica** de refresh (GETDEL Redis), **HMAC anti-DoS**, **rate-limit**
  (10/min login, 30/min refresh), token de acceso **sólo en memoria** (no localStorage → no
  exfiltrable por XSS), refresh por cookie httpOnly. Interceptor de refresh-on-401 en el front.
- Wizard de setup inicial (BD/Redis/admin/email).

### 3.2 Correo (lectura)
- Sync IMAP incremental (UIDVALIDITY / expunge / flags, sin cargar todo en RAM — TD-SYNC-OOM cerrado).
- Parseo real con **postal-mime** + **HTML saneado** (sanitize-html) servido como `sanitizedHtml`
  (nunca el HTML crudo). Render con `v-html` respaldado por CSP `script-src 'self'`.
- Descarga de **adjuntos entrantes** (`GET /emails/:id/attachments/:idx`): owner-bound (sin IDOR),
  `nosniff` + `Content-Disposition: attachment` (nunca inline), filename ASCII-saneado.
- Marcar leído (persiste flag IMAP), mover a papelera.

### 3.3 Correo (composición y envío)
- Composer con editor rico (TipTap), firmas HTML auto-incluidas (estilo Gmail).
- Reply / Reply-all / Forward con threading correcto (In-Reply-To/References) y Reply-To.
- Envío SMTP **idempotente** (Message-ID determinista, transición atómica anti doble-envío) +
  copia a la carpeta Sent (APPEND).
- Drafts con estados (editing/failed/sending/sent); `sent` es **terminal**.

### 3.4 Adjuntos (salida) — subsistema completo
- `POST /api/attachments` (multipart acotado a 1 archivo, 25MB, owner-bound).
- Adjuntar al draft por `attachmentIds` (valida ownership → 404), envío SMTP real con los blobs.
- **GC mark-and-sweep con lease atómico** (`cleanupOrphanAttachments`): recolecta blobs huérfanos
  (subidas descartadas, drafts borrados/enviados) sin race (lease active/deleting + CAS +
  doc-first delete + recovery). Cableado al scheduler del boot.
- **Cuota por usuario** (optimista con rollback, anti disk-fill DoS; converge a max).

### 3.5 Administración / storage configurable
- Cuenta admin (setup-created; `requireAdmin` verificado en DB, no por el claim JWT; CLI
  `admin:grant` de recuperación).
- Panel `/admin` gateado por `role==='admin'` (UI + backend 403 por endpoint).
- **Wizard de storage** (Paso 1): elegir **Local** o **S3/compatible** (MinIO, R2). Para S3:
  endpoint/bucket/region/credenciales; el **secret se cifra** (AES-GCM) y nunca vuelve por la API
  (sólo `secretConfigured`). Botón **"Probar conexión"** (round-trip real put→get→delete).
- **S3 provider** con `aws4fetch` (SigV4): timeout, lectura por streaming con tope (anti-OOM),
  endpoint saneado anti-SSRF (bloquea metadata cloud; permite hosts internos para MinIO).

### 3.6 Contactos y Calendario
- Contactos: CRUD + frecuentes. Calendario: eventos vía **CalDAV** (sync).

---

## 4. Seguridad — postura actual (auditada)

5 rondas de auto-auditoría con revisores externos reales (B=Codex, D=Kimi) cerraron **6 issues
reales de producción**:

| # PR | Issue | Severidad |
|------|-------|-----------|
| #16 | Fuga de blobs huérfanos (refCount muerto) → GC mark-and-sweep con lease | MEDIUM |
| #17 | Footgun S3: activar config mala rompía uploads → "Probar conexión" | MEDIUM |
| #18 | Disk-fill DoS (subir-sin-adjuntar) → cuota optimista por usuario | MEDIUM |
| #19 | Gap de QA: la defensa anti-XSS no tenía tests → 17 tests de regresión | (QA) |
| #20 | **CVEs CRÍTICOS en deps**: fast-jwt auth-bypass + cache-confusion (mixup de identidad multi-tenant), nodemailer SMTP-injection → upgrade | **CRÍTICO** |
| #21 | CI no chequeaba CVEs → **audit gate** preventivo en CI | (preventivo) |

Controles activos:
- **Authz multi-tenant**: todo recurso owner-bound (404 al ajeno, no 403 → no filtra existencia).
- **Inputs hostiles**: multipart acotado, path-traversal en LocalStorage, SSRF en endpoint S3,
  mass-assignment bloqueado (DTOs públicos sin localizadores internos).
- **Secretos**: cifrados AES-GCM en DB, nunca en logs/API/respuestas; `.env.example` sólo placeholders.
- **XSS**: sanitize-html 2.17.5 (regression-tested, B+D atacaron sin bypass) + CSP `script-src 'self'`.
- **Rate limit** global (100/min) + por-ruta en auth. **Helmet** + CSP + nosniff + frame-deny.
- **Deps sin CVEs** (`pnpm audit --prod` limpio, gate en CI).

---

## 5. Observabilidad y operación
- `GET /api/health` (chequea Mongo + Redis → 200/503). `GET /api/metrics`.
- Logger estructurado (pino), errores 5xx logueados; secretos nunca logueados.
- Boot **fail-fast** si Mongo/Redis no responden. Shutdown ordenado (SIGTERM).
- Barridos periódicos al boot + cada 5min: `recoverStuckDrafts` + `cleanupOrphanAttachments`.

---

## 6. Calidad / QA
- **146 tests API** (unit + integración: auth, JWT, authz multi-tenant, sync, drafts/send,
  adjuntos, GC, cuota, admin/storage, crypto, XSS, índices).
- **9 tests E2E** (Playwright, navegador real contra API real): login→sync→leer→adjuntar→enviar,
  reply/reply-all, firma, interceptor de refresh, admin (gate + guardar storage).
- **CI**: typecheck + lint + tests/coverage (umbrales API 75/65/80/75) + E2E + docker-smoke +
  **audit gate**. Builds de producción (vite + tsc) verificados. **Boot real del API + sweeps**
  verificado fuera del E2E.

---

## 7. Lo que falta / deuda registrada

### Feature pendiente (la única real)
- **PR-E — Provisioning de buzones**: crear cuentas de email desde el admin
  ("sólo disponible cuando existen las opciones activas" = feature-gated). Diseño en
  `admin-config-y-providers.md §5/E` (con hardening anti-inyección SSH). Es la pieza más
  compleja: ejecución remota (SSH/API a docker-mailserver), **RCE-sensible** y **no
  integration-testeable** sin un servidor de correo real. La *primera slice* segura/testeable es
  la interfaz `ProvisioningProvider` + feature-gate + default "none" (sin el provisionador real).

### Deuda menor / no bloqueante
- **Privacy (MEDIUM)**: las prefs `autoLoadImages`/`blockRemoteContentUnknown` existen pero **no
  se enforcan** → las imágenes remotas siempre cargan (tracking pixels). Enforcement = feature
  (sanear img src según preferencia + toggle "cargar imágenes" en UI).
- **Perf (pre-existente)**: la descarga de adjuntos **entrantes** re-fetchea+parsea el MIME
  completo por adjunto (tradeoff consciente de no guardar inbound localmente).
- **CI hardening**: pin de GitHub Actions por SHA (necesita Dependabot); alinear `docker.yml`
  (`ubuntu-latest`→pin, `timeout-minutes`).

### Validación que SÓLO el operador puede hacer (no testeable en CI)
- S3 contra un bucket real; envío SMTP contra un servidor real; `docker build/run` local.
  Cubierto parcialmente por unit tests (fetch mockeado) + docker-smoke en CI.

---

## 8. Cómo correr / verificar
```bash
pnpm install
pnpm --filter @webmail6/shared build   # los demás resuelven tipos desde su dist
pnpm typecheck && pnpm lint
pnpm --filter @webmail6/api test        # 146 tests
pnpm --filter @webmail6/web exec playwright test   # 9 E2E
pnpm audit --prod --audit-level high    # 0 vulnerabilidades
pnpm build                              # builds de producción
```
Self-hosted: plantilla sanitizada en `deploy/example-mailserver/` (Traefik + docker-mailserver +
mongo + redis + api + web; `setup.sh` interactivo; manual paso a paso).

---

## 9. Documentos relacionados
- `plan-tecnico-consolidado.md` — plan técnico (fases F3.0–F3.9).
- `admin-config-y-providers.md` — diseño del subsistema admin/providers (incl. provisioning §5/E).
- `deuda-tecnica.md` — registro vivo de deuda.
- `post-mortem.md` — lecciones del proceso multi-equipo.
- `deploy/example-mailserver/README.md` — guía self-hosted paso a paso.
