# BifrostMail — Compliance Framework — DESIGN v4

**Documento Consolidado de Diseño (Fase 2)**
Estado: `IN_REVIEW_DOC` (v4) · Tipo: **FEATURE** · Equipo A: Claude Code
Revisores: B (Codex) · C (GLM z.ai) · D (Kimi)
Historial: v1 (B6/D6) → v2 (B8/D7) → v3 (B **8.5** NOT APPROVE 1 HIGH `effectiveAt` monótono; D **8 APPROVE**
condicional 0 HIGH; C 7 con 8 MEDIUM de endurecimiento). **v4** cierra: invariante `effectiveAt` monótono
+ `next*` por tiempo (§4.4, HIGH de B); HMAC canónico+rotación+keyId (§2.3); IP real tras proxy (§2.3);
`contentHash` única (§2.2/§6); PATCH→`block_*` setea `enforcedVersion` (§4.2); versiones indelebles (§2.2);
auditoría admin `ComplianceAdminAction` (§2.5); verificación HMAC (§4.2); epoch cross-worker Redis (§3.6);
drift self-check runtime (§3.6); retry CAS (§4.4).
Artefactos: `RESEARCH.md`, `RESOLUTIONS-v2.md` (trazabilidad v1→v4).

---

## 0. Resumen ejecutivo

Framework de Compliance **configurable, desacoplado, multi-tenant-ready** para BifrostMail: la base
sobre la que cualquier organización administra sus políticas legales (Términos, Privacidad, Uso
Aceptable, Cookies, Retención, Auditoría, Seguridad y documentos futuros) **sin tocar código**, con
versionado inmutable, evidencia legal de aceptación con HMAC, reaceptación automática, y un gate de
primer acceso **seguro por defecto** (nunca bloquea sin decisión explícita del admin).

Anclado a la arquitectura real del repo (verificada en código).

---

## 1. Arquitectura actual verificada (CONFIRMADO)

| Aspecto | Evidencia en código | Implicación |
| --- | --- | --- |
| Backend | Fastify 5 + Mongoose 8 (MongoDB) + Zod | Modelos + rutas con Zod |
| Auth | `@fastify/jwt`: access JWT (`payload.userId`) + cookie httpOnly `refresh_token`. `plugins/auth.ts` hook `onRequest`, flag `requiresAuth` | Gate posterior, metadata-driven |
| Authz | `lib/authz.ts::requireAdmin(userId)` consulta DB, lanza `ForbiddenError`(403) | Reusar en rutas admin |
| Roles | `User.role: 'user'\|'admin'` | Audiencia por rol |
| Tenancy | **Single-tenant por deployment**; no hay `tenantId` | Multi-tenant forward-compatible (§9) |
| Restore SPA | `stores/auth.ts` restaura con `/auth/refresh`+`/auth/me`, **no** con login response | Hidratar compliance también ahí (B-M3) |
| Rutas públicas existentes | `setup`, `signature-images`, `branding`, `config`, `health`, `metrics` usan `requiresAuth:false` | Gate **no** debe asumir lista de paths (B#3/D9) |
| Sanitización | `lib/sanitizeHtml.ts::sanitizeEmailHtml` orientada a **email** (permite estilos/imágenes) | **No** reusar; pipeline markdown dedicado (B#4/D7) |
| Boot idempotente | `db/reconcile-indexes.ts` en `index.ts` | Seed idempotente conservador |
| Frontend | Vue 3 + Pinia + vue-router + vue-i18n + Tiptap + Tailwind + `@tailwindcss/typography` | Editor + render `prose` |

---

## 2. Modelo de datos (v2)

Cuatro colecciones. **Todas** con `tenantId` (default `'default'`, index) — forward-compatible.

### 2.1 `ComplianceDocument` — slot lógico + **estado denormalizado para gating de 1 sola colección**

```
tenantId          string  default 'default', index
key               string  slug único por tenant ('terms-of-service'|...|custom)
category          enum    'legal'|'privacy'|'security'|'operational'|'cookies'|'custom'
title             string  nombre administrativo
audience          enum    'all'|'role:user'|'role:admin'
enforcement       enum    'none'|'soft'|'block_partial'|'block_full'   ← UNIFICADO (elimina `mandatory`)
active            boolean
order             number
defaultLocale     string
system            boolean  sembrado por defecto (no se borra; sólo deactivate)
deletedAt         Date|null soft-delete (B-M4)
versionCounter    number   secuencia monotónica REAL para publish atómico (default 0)   ← B#2
// ---- denormalizado desde la versión vigente (gating sin populate) — D4 ----
currentVersionId        ref|null  versión PUBLICADA y EN VIGENCIA que se muestra/cumple
currentVersionNumber    number    (default 0)
currentContentHash      string|'' hash del contenido vigente
currentEffectiveAt      Date|null
currentExpiresAt        Date|null
latestPublishedVersion  number    última publicada (puede no estar aún vigente) — B-L1
latestPublishedEffectiveAt Date|null  effectiveAt de la última publicada
enforcedVersion         number    versión MÍNIMA exigida (default 0)
enforcedFrom            Date|null  desde cuándo aplica `enforcedVersion` (= effectiveAt) — D3
// ---- próxima versión PROGRAMADA (effectiveAt futuro) — promoción lazy sin leer versiones (D-016) ----
nextVersionId           ref|null
nextVersionNumber       number    (default 0)
nextEffectiveAt         Date|null  cuando el gate ve nextEffectiveAt<=now → dispara recomputeDenorm (§4.4)
nextContentHash         string|''
nextRequiresReacceptance boolean
createdAt/updatedAt
```

Reglas: `enforcement==='none'` ⇒ documento NO se rastrea ni aparece en `/pending`. `'soft'` ⇒
aparece (banner informativo) pero **no** bloquea. `'block_partial'|'block_full'` ⇒ bloquea.
Índice único `(tenantId, key)`. `currentVersionId` **siempre** apunta a `published`+vigente (D8,
enforced por servicio).

### 2.2 `ComplianceVersion` — snapshot **inmutable** + `contentHash`

```
tenantId, documentId(ref), documentKey(denorm)
version            number   monotónico (asignado en publish desde versionCounter)
status             enum     'draft'|'published'|'archived'
contents           [{ locale, title, bodyMarkdown, bodyHtml }]   bodyHtml = markdown saneado (§6)
pipelineVersion    string   versión del pipeline markdown→HTML (prueba del render exacto — C-L7)
contentHash        string   sha256(JSON canónico de contents[] con SÓLO {locale,title,bodyMarkdown},
                            ORDENADO por locale) — markdown FUENTE, todas las locales, SIN bodyHtml.
                            Definición ÚNICA (C-M3/D-026): el hash liga el texto legal, no el HTML
                            derivado del pipeline (que puede cambiar sin cambiar el texto).
changeSummary      string
requiresReacceptance boolean
effectiveAt        Date     (puede ser futuro → D3)
expiresAt          Date|null
attachments        [{ name, blobRef, sizeBytes, contentType }]   (subida DEFERIDA, ver §13)
authorId(ref) authorEmail(denorm) publishedAt(Date|null) createdAt
```

Índice único `(tenantId, documentId, version)`.
**Inmutabilidad E INDELEBILIDAD (B-L2 / C-M7):** el ÚNICO path de escritura es `services/compliance.ts`.
Un `draft` se edita; al pasar a `published` queda congelado. Middleware Mongoose
`pre(['save','updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace',
'deleteOne','deleteMany','findOneAndDelete'])` rechaza **mutación o borrado** si `status!=='draft'`
(las publicadas son inmutables **e indelebles** — borrarlas dejaría `currentVersionId`/`versionId` de
aceptaciones colgando). Nuevas ediciones ⇒ nueva versión `draft`. (`db.collection()` nativo bypassa
Mongoose: se documenta como operación prohibida fuera del servicio.)

### 2.3 `ComplianceAcceptance` — evidencia legal **append-only** + **HMAC**

```
tenantId, userId(ref), userEmail(denorm)
documentId(ref) documentKey(denorm) versionId(ref) version
contentHash   string   copiado de la versión aceptada (qué texto exacto)
acceptedAt(Date) ip(string) userAgent(string) locale(string)
method        enum     'explicit_click'|'scroll_confirmed'
hmacKeyId     string   id de la clave con que se firmó (C-M2: permite rotar sin perder verificación histórica)
evidenceHmac  string   HMAC-SHA256(key[hmacKeyId], canonicalJSON) — ver canónico abajo
createdAt
```

Índice único `(tenantId, userId, documentId, version)` → idempotencia (E11000 = éxito, A6).
Índices: `(tenantId, userId)`, `(tenantId, documentKey, version)`.
**Sin rutas UPDATE/DELETE.**

**Canónico no ambiguo (C-M1/D-029):** `canonicalJSON` = JSON con **orden de claves fijo** y todos los
campos como string con **length-prefix** (`<len>:<valor>`) — evita colisiones cuando `userAgent`
contiene delimitadores (`|`, `;`). Esquema fijo: `{tenantId,userId,documentKey,versionId,version,
contentHash,acceptedAt(ISO-UTC),ip,userAgent,method,locale}`. Nulos prohibidos (todos requeridos).

**Secreto y rotación (C-M2):** clave **dedicada** `COMPLIANCE_HMAC_SECRET` (NO derivada de `JWT_SECRET`,
que rota por seguridad). Claves **versionadas** vía HKDF con `hmacKeyId`; las retiradas se **archivan**
(nunca se borran) ⇒ la evidencia histórica siempre verificable. `hmacKeyId` persiste en cada registro.

**IP real tras proxy (C-M6):** el deployment va tras CloudFront/ALB. Se configura
`fastify({ trustProxy })` y se captura la IP de cliente de `X-Forwarded-For` validado — NO la IP del
proxy (una IP de CloudFront en la evidencia es inútil). Sin esto el campo `ip` del HMAC es basura.

No recalculable sin el secreto ⇒ tamper-evident **demostrable** (ver verificación en §4.2).

### 2.4 `ComplianceSettings` — colección dedicada con `tenantId` (D12)

```
tenantId            string   unique
complianceEpoch     number   contador bumpeado en publish/cambio metadata; invalida caché (A4).
                             Espejo en **Redis** (`compliance:epoch:<tenantId>`) para invalidación
                             cross-worker (C-M10). `defaultEnforcement` ELIMINADO: `enforcement` es
                             enum requerido sin estado "sin definir" → no había fallback que aplicar (C-L1).
createdAt/updatedAt
```

`gracePeriodHours` **eliminado** (YAGNI; la reaceptación es inmediata por diseño en vivo — D6).
Retención de evidencia: ver §10 (no se borra; en borrado de cuenta se **anonimiza** `userEmail`
conservando el registro HMAC — D13/GDPR).

### 2.5 `ComplianceAdminAction` — auditoría **durable** de acciones admin (C-M8 / D-028)

Append-only. El framework auditaba la aceptación del usuario pero NO quién gobierna el framework.
```
tenantId, actorId(ref) actorEmail(denorm)
action     enum   'create_document'|'update_document'|'delete_document'|'create_version'|
                  'update_version'|'publish'|'export_acceptances'|'toggle_kill_switch'
targetType string targetId(ref) documentKey(denorm)
before     mixed  estado relevante previo
after      mixed  estado relevante posterior
ip(string) at(Date) createdAt
```
Consultable vía `GET /admin/actions`. Registra "quién cambió `privacy-policy` de `soft` a
`block_full` y cuándo", publish, export, y la activación del kill-switch (cierra D-028). Distinto del
documento `audit-policy` (que se MUESTRA a usuarios) — esto es el **log operativo** del framework.

---

## 3. Lógica de gating (v2 — segura, de 1 sola colección)

### 3.1 Cómputo de "pendientes" (lee SÓLO `ComplianceDocument` + 1 lookup de aceptación)

`U` tiene `D` **pendiente/bloqueante** si TODAS:
1. `D.active && D.deletedAt==null && D.enforcement !== 'none'`
2. `D.audience` aplica a `U` (`'all'` o `'role:'+U.role`, evaluado contra **rol en DB**, no claim)
3. **Vigencia:** `D.currentVersionId != null` y `D.currentEffectiveAt <= now` y (`D.currentExpiresAt==null || D.currentExpiresAt > now`)
4. **Exigencia activa:** `D.enforcedVersion > 0` y `D.enforcedFrom <= now` (D3: si `enforcedFrom` futuro aún no exige)
5. `U` NO tiene `ComplianceAcceptance` con `version >= D.enforcedVersion`

Todos los campos de 1–4 están **denormalizados en `ComplianceDocument`** ⇒ el gate lee el snapshot de
documentos enforced **cacheado por epoch** (0 queries si el epoch no cambió). Presupuesto de queries
honesto (D-020):
- **Fast-path (caso común, sin docs enforced):** 0 queries.
- Si hay docs enforced cuya `audience` es `role:*` ⇒ se necesita el rol del user. `request.user` sólo
  trae `userId` (ver `plugins/auth.ts`), así que el gate hace `User.findById(userId).select('role')`
  (indexado, ~0ms; mismo costo que `requireAdmin` ya existente). Si todos los docs enforced son
  `audience:'all'`, se omite el lookup de rol.
- Más **un** lookup indexado de aceptaciones del user (`version >= enforcedVersion`). Sin populate (D4).

`soft` aparece en `/pending` (para banner) pero su `enforcement` no bloquea (3.2). Esto elimina la
ambigüedad mandatory/soft (D10): **el rastreo lo decide `enforcement!=='none'`; el bloqueo lo decide
el nivel.**

### 3.2 Modos de enforcement

| `enforcement` | Backend | Frontend |
| --- | --- | --- |
| `none` | no rastrea | invisible |
| `soft` | nunca bloquea | banner informativo descartable |
| `block_partial` | bloquea rutas con `config.complianceEffect==='write'` | banner persistente + acciones de escritura deshabilitadas |
| `block_full` | bloquea toda ruta de negocio (salvo exentas) con `403 COMPLIANCE_REQUIRED` | redirige a `/compliance/accept` full-screen |

Modo efectivo de sesión = el más estricto entre los pendientes bloqueantes.

### 3.3 Gate **metadata-driven** (NO allowlist por path) — B#3 / D1 / D9

El hook decide por **metadata de ruta Fastify `config`**, no por lista de paths:
- `requiresAuth===false` ⇒ **skip** (ruta pública; no hay `request.user`). Cubre `setup`,
  `signature-images`, `branding`, `config`, `health`, `metrics` y futuras (D9 — sin asumir paths).
- `config.skipCompliance===true` ⇒ **skip** explícito. Se marca SÓLO en (skip **granular**, no por
  prefijo — B-v2 MEDIUM):
  - `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/refresh`, `GET /api/auth/me`.
    **`PATCH /api/auth/me/preferences` NO** lleva skip ⇒ es `complianceEffect:'write'` (gated).
  - rutas de compliance **de usuario**: `GET /pending`, `GET /documents*`, `POST /accept`, `GET /me/acceptances`.
- **`/api/compliance/admin/*` NO lleva `skipCompliance`** ⇒ un admin con políticas pendientes que le
  apliquen (`audience role:admin`) DEBE aceptar antes de administrar (D1). Chicken-egg evitado: el
  seed es no-bloqueante (§5), así que en el primer arranque ningún admin queda atrapado.
- `config.complianceEffect: 'read'|'write'|'none'` ⇒ clasificación **semántica** para `block_partial`
  (B-M2: un GET con efectos —p.ej. `emails.ts:171` marca leído— se etiqueta `'write'`).

**Manifest OBLIGATORIO + test de cobertura (B-v2 MEDIUM / D-018) — no "auditoría manual en P3":**
cada ruta registrada DEBE declarar explícitamente `requiresAuth:false` **o** `skipCompliance:true`
**o** `complianceEffect:'read'|'write'|'none'`. Un **test de cobertura** enumera todas las rutas del
`printRoutes`/registry de Fastify y **falla (CI)** si alguna queda sin clasificación explícita — así una
ruta nueva sin etiqueta no puede mergearse (evita bypass de escritura bajo `block_partial` o lockout por
`skip` faltante en una ruta de auth/recuperación). **No hay default silencioso** para rutas mutantes.
Mitigación de mal-etiquetado semántico (D-025): el test **prohíbe** que un método mutante
(`POST/PUT/PATCH/DELETE`) se clasifique como `complianceEffect:'read'` (sólo `'write'`/`'none'` con
justificación); un `GET` con efectos debe declararse `'write'` explícito. No elimina el juicio humano,
pero cierra la clase de error más común (escritura etiquetada como lectura).

### 3.4 Orden de hooks **garantizado** (D2 / A5)

El gate es `plugins/compliance-gate.ts` con `fastify-plugin`, registrado en `app.ts`
**inmediatamente después de `authPlugin`** (línea 119). Es un hook `onRequest` que corre **después**
del `onRequest` de auth (orden de registro Fastify). Guardas tempranas: `return` si
`requiresAuth===false`, si `skipCompliance`, o si `!request.user?.userId`. Test de orden obligatorio.

### 3.5 Seguridad operacional: **fail-open + kill-switch** (A3 — crítico producción)

- Si el cómputo del gate **lanza** (DB caída, bug) ⇒ **fail-open** (permite) + `log.error` + métrica
  `compliance_gate_errors_total`. Bloquear el correo de una org por un bug de compliance es peor.
- `env.COMPLIANCE_ENFORCEMENT_DISABLED==='1'` ⇒ gate desactivado sin redeploy (kill-switch). Control de
  acceso (D-021): es **env var de despliegue**, mismo nivel de confianza que `JWT_SECRET`/`COMPLIANCE_HMAC_SECRET`
  (sólo operadores con acceso al entorno). Su activación se **loguea** (`warn` estructurado) + métrica
  `compliance_enforcement_disabled` para que un bypass no pase silencioso.

### 3.6 Performance: **compliance epoch** (A4 / B-M1)

Snapshot en memoria por tenant `{ epoch, enforcedDocs[] }` con TTL **explícito ≤ 30s** (cota superior
de staleness). `complianceEpoch` se bumpea en publish/cambio de metadata/active y se **espeja en
Redis** (`compliance:epoch:<tenantId>`). Cada worker compara su `epoch` cacheado contra el de Redis
(lectura O(1), o pub/sub) antes de servir desde caché ⇒ **invalidación cross-worker** (multi-worker
EC2 — C-M10), sin la ventana de staleness no acotada que tendría una caché puramente por-proceso.
Fast-path: sin docs enforced aplicables al rol ⇒ **0** queries de aceptación.
**`accept` NO bumpea el epoch tenant-wide** (no cambia el set de docs enforced — C-L6): sólo invalida
el recomputo del propio usuario (refetch del cliente). Evita cache-thrash a escala.
**Drift self-check runtime (D-024):** además del reconciler de boot, el snapshot builder valida que
`latestPublishedVersion` denormalizado coincida con `max(version)` real de versiones publicadas (1
query agregada barata, cacheada por epoch); si difiere ⇒ dispara `recomputeDenorm` + log
`compliance_denorm_drift_total`. Así un drift por edición manual/bug se detecta en caliente, no sólo en boot.

### 3.7 Frontend: restore + 403 global (B-M3)

Store `compliance` hidrata pending en login **y** en restore (`/auth/refresh`+`/auth/me`).
Interceptor axios global: `403 {code:'COMPLIANCE_REQUIRED'}` ⇒ refresca pending + redirige al gate.

---

## 4. API

### 4.1 Usuario (`skipCompliance:true`, auth requerido)

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/compliance/pending` | Docs pendientes (bloqueantes + soft) + `enforcement` efectivo |
| GET | `/api/compliance/documents` | Docs activos visibles (footer legal) + metadata vigente |
| GET | `/api/compliance/documents/:key?locale=` | `bodyHtml` saneado de la versión vigente (fallback locale) |
| POST | `/api/compliance/accept` | `{documentKey, version}` → registra (ip/ua/locale server-side). **Valida** que `version` == versión vigente exigible; rechaza futura/no-publicada/obsoleta → `409 VERSION_STALE` (D11, §8.14). Idempotente (E11000=ok) |
| GET | `/api/compliance/me/acceptances` | Historial propio |

### 4.2 Admin (`requireAdmin` preHandler, **sin** `skipCompliance` — D1)

| Método | Ruta | Notas |
| --- | --- | --- |
| GET | `/api/compliance/admin/documents` | todos (incl. inactivos/drafts) |
| POST | `/api/compliance/admin/documents` | crear (key, category, enforcement, audience, order) |
| PATCH | `/api/compliance/admin/documents/:id` | metadata (enforcement, active, order, audience). **Al fijar `enforcement` a `block_*`**: invoca `recomputeDenorm` y, si `enforcedVersion==0`, lo setea a `currentVersionNumber` (exige versión vigente publicada; si no hay → 409). Sin esto, cambiar a `block_*` NO bloquearía (C-M4/D-027). Bump epoch + `ComplianceAdminAction` |
| DELETE | `/api/compliance/admin/documents/:id` | **soft-delete** si existe ALGUNA versión publicada o aceptación; hard-delete sólo si vacío y no-system (B-M4) |
| GET | `/api/compliance/admin/documents/:id/versions` | historial |
| POST | `/api/compliance/admin/documents/:id/versions` | crear **draft** (contents+locales; calcula `bodyHtml`+`contentHash`) |
| PATCH | `/api/compliance/admin/versions/:id` | editar **draft** (published→409) |
| POST | `/api/compliance/admin/versions/:id/publish` | **publish transaccional** (§4.3) |
| GET | `/api/compliance/admin/acceptances?...&format=json\|csv` | export con guard CSV-injection (prefijo `'` ante `= + - @`, escape comillas/comas/saltos — B-L3/D14). Paginado. Incluye `hmacKeyId` para verificación |
| POST | `/api/compliance/admin/acceptances/:id/verify` | recomputa el HMAC con su `hmacKeyId` y reporta válido/alterado — tamper-evidence **demostrable** (C-M9) |
| GET | `/api/compliance/admin/stats` | cobertura por documento |
| GET | `/api/compliance/admin/actions` | log de acciones admin (ver §2.5) — gobierno del framework |

### 4.3 Publish **standalone-safe** (sin transacción multi-doc) — B-v2#1 / D-016 / D-017

**Principio (resuelve crash en Mongo standalone):** `ComplianceVersion` es la **fuente de verdad**;
los campos denormalizados de `ComplianceDocument` (§2.1, current\*/next\*/enforced\*) son **caché
derivada rebuildable** desde las versiones. No se requiere replica-set ni transacción multi-documento.
Patrón idéntico a `db/reconcile-indexes.ts` (ya en el repo).

Secuencia de publish — cada paso es la escritura de **un** documento, idempotente:
1. `findOneAndUpdate(document, {$inc:{versionCounter:1}}, {new:true})` ⇒ `nextVersion` (atómico, 1 doc).
2. Upsert de la versión `published` (`version=nextVersion`, `publishedAt=now`, `bodyHtml`+`contentHash`).
   Índice único `(documentId,version)` ⇒ idempotente ante retry.
3. `recomputeDenorm(documentId)` (§4.4) — recalcula current\*/next\*/enforced\* desde las versiones
   autoritativas, con **compare-and-set** (CAS) por número de versión. 1 doc update.
4. Bump `complianceEpoch` (invalida la caché del gate).

**Recovery (auto-sana cualquier crash entre 1–4):** `reconcileComplianceDenorm()` corre en boot
(patrón reconcile-indexes) y lo invoca el snapshot builder al detectar drift:
- crash tras 1 (counter sin versión) ⇒ gap de secuencia inocuo (el counter es sólo secuencia).
- crash tras 2 (versión publicada, denorm vieja) ⇒ reconciler ve `published.version > latestPublishedVersion` ⇒ recomputa.
- crash tras 3 (denorm ok, epoch sin bump) ⇒ snapshot stale ≤ TTL; siguiente refresh/boot lo sana.

Log estructurado: `{actor, documentKey, version, requiresReacceptance, effectiveAt}`.

### 4.4 `recomputeDenorm` y promoción de `effectiveAt` futuro — B-v2#2 / D-016 / D-019

Función idempotente (en `services/compliance.ts`, **único** writer legítimo de denormalización junto
al reconciler). Desde las versiones `published` del documento calcula y fija vía **CAS**:
- `current*` = la versión `published` de mayor `version` con `effectiveAt <= now` (y `expiresAt` no
  vencido). `latestPublishedVersion` = máxima `published`. `latestPublishedEffectiveAt` = su `effectiveAt`.
- `enforcedVersion`/`enforcedFrom` = la mayor versión en vigencia (`effectiveAt<=now`) con
  `requiresReacceptance=true` (si ninguna, se mantiene la previa).
- **`next*`** = la versión `published` con **menor `effectiveAt > now`** (el próximo evento temporal
  real, **no** el menor número de versión — B-v3 HIGH), tie-break por **mayor `version`** ante igual
  `effectiveAt`; se ignoran versiones futuras ya superseded por una versión mayor ya vigente. Campos:
  `nextVersionId/Number/EffectiveAt/ContentHash/RequiresReacceptance`. Si no hay → `next*`=null.

**Invariante de `effectiveAt` monótono (B-v3 HIGH, cierra C-L4/L5):** `publish` **RECHAZA** (`409`) si
`effectiveAt < latestPublishedEffectiveAt` del documento, y exige `expiresAt > effectiveAt`. Con la
invariante, "menor `effectiveAt > now`" coincide con "menor `version` futura", pero la definición de
`next*` por tiempo deja el modelo robusto aun si se relajara. Tests: publish no monótono → 409;
v2(`effectiveAt` futuro) + v3(`effectiveAt` más futuro) → `next*` correcto; v2 y v3 con igual
`effectiveAt` → gana mayor versión.

**CAS fallido en promoción/accept (D-023):** si el `findOneAndUpdate` con guarda CAS de `recomputeDenorm`
no matchea (otro proceso promovió primero), se **relee** el `ComplianceDocument` actualizado y se
**recomputa** la decisión de gate/accept (retry acotado, máx. 3) sobre el estado fresco — nunca se
evalúa contra `current*` obsoleto ni se emite `409 VERSION_STALE` injustificado.

**Promoción lazy SIN consultar versiones en el hot path (resuelve D-016):** el gate/snapshot builder
lee **sólo** campos denormalizados de `ComplianceDocument`. Si detecta `nextEffectiveAt != null &&
nextEffectiveAt <= now`, invoca `recomputeDenorm(documentId)` (off hot-path, raro: sólo en el borde de
una fecha programada) con CAS `findOneAndUpdate({_id, currentVersionNumber:{$lt:nextVersionNumber}}, …)`
para promover next→current sin doble promoción concurrente, y bumpea epoch. El **único** que consulta
`ComplianceVersion` es `recomputeDenorm`/reconciler — nunca el gate por request. Así §3.1 (1 colección
en el hot path) y §4.4 (fuente de verdad = versiones) dejan de contradecirse.

**`/accept` (D-019):** antes de validar, `accept` llama a `recomputeDenorm(documentId)` si
`nextEffectiveAt<=now` (mismo CAS), de modo que valida contra la versión **realmente vigente** y nunca
rechaza con `409 VERSION_STALE` una aceptación proactiva legítima ni acepta una versión equivocada.

---

## 5. Documentos por defecto (seed) — **conservador, nunca bloquea** (B#1 / D15 / A1)

7 docs `system` sembrados **idempotentemente** en boot (sólo si faltan; nunca sobrescriben ediciones):
`terms-of-service`, `privacy-policy`, `acceptable-use`, `cookie-policy`, `data-retention`,
`audit-policy`, `security-policy`.

- Contenido en archivos markdown del repo: `packages/api/src/compliance/seeds/<key>/<locale>.md`. NO en frontend.
- Se siembran `published` (versión 1) pero **`enforcement` por defecto `'soft'`** y **`enforcedVersion=0`**
  ⇒ **ningún usuario queda bloqueado** tras un upgrade. El admin opta conscientemente por
  `block_partial/block_full` (acto auditado). Resuelve la contradicción v1 §5↔§10.
- Textos neutrales, genéricos, internacionales. Sin Cleverty/Href/país. Contemplan la suite futura
  (mail, calendario, reuniones, contactos, tareas, CRM, ERP, IA, automatización, almacenamiento,
  archivos, reportes, métricas, auditoría, seguridad, monitoreo, trazabilidad, continuidad).
- Disclaimer prominente: documento inicial / la organización adapta a su jurisdicción / requiere
  revisión legal antes de producción.

---

## 6. Pipeline Markdown → HTML saneado **dedicado** (B#4 / D7)

`lib/complianceMarkdown.ts` (NO reusa `sanitizeEmailHtml`):
1. Parser markdown con **`html:false`** (sin HTML crudo embebido). Lib mínima (markdown-it `html:false`).
2. Sanitizar el HTML resultante con **allowlist estricta** de documento legal: `h1-h4,p,ul,ol,li,
   strong,em,blockquote,a[href^=http|https][rel=noopener noreferrer],table,thead,tbody,tr,th,td,hr,
   code,pre`. **Prohibido:** `style,script,iframe,on*`, `javascript:`/`data:` ejecutables, y
   **`img` (decisión D-022: NO se permiten imágenes en documentos legales** — innecesarias y vector
   XSS; los anexos van por el campo `attachments`, no inline). Sin atributos `on*` ni `style`.
3. El **backend** persiste y devuelve `bodyHtml` ya saneado (+ `pipelineVersion`); el frontend renderiza
   ese HTML confiable (defensa en profundidad: saneo en escritura). `contentHash` se define en §2.2
   (markdown fuente, todas las locales, sin bodyHtml) — definición única consistente con §2.2.
4. Tests XSS: `<script>`, `<img onerror>`, `javascript:` href, `<iframe>`, `<style>` ⇒ neutralizados.

Frontend: editor Tiptap → serializa a **markdown** (no HTML); vista previa pide `bodyHtml` al backend
o usa el mismo render saneado. Tiptap configurado sin nodos peligrosos.

---

## 7. Plan de implementación por fases (Fase 3)

| Fase | Objetivo | Validación |
| --- | --- | --- |
| **P0** | Modelos (5: Document/Version/Acceptance/Settings/AdminAction) + índices + `resolveTenantId` + registro de claves HMAC (`hmacKeyId`/HKDF) + seeds md + seed reconciler idempotente | typecheck + unit modelos/inmutabilidad+indelebilidad |
| **P1** | `services/compliance.ts` (único write-path): versionado, publish atómico, accept idempotente, gating, epoch, markdown pipeline | unit exhaustivo (concurrencia publish, E11000, effectiveAt futuro, enforcedVersion, XSS) |
| **P2** | Rutas usuario + admin + Zod + CSV guard | integration (supertest + mongodb-memory-server) |
| **P3** | `plugins/compliance-gate.ts` (metadata-driven, fail-open, kill-switch) + `trustProxy`/IP real + etiquetado `complianceEffect`/`skipCompliance` en rutas existentes + epoch Redis cross-worker + login/restore response + `shared/types` | integration gate (403, orden hooks, allowlist, admin no-exento, manifest coverage) |
| **P4** | Frontend: store + gate view (scroll-to-accept) + banner + router + interceptor 403 | unit store + E2E primer acceso/reaceptación |
| **P5** | Editor admin (Tiptap markdown + preview + historial + publish) + visor auditoría + export | E2E admin completo |
| **P6** | Docs técnicas + diagramas + casos uso/borde + cierre QA B/C/D | revisión final |

Cada fase: implementar → B/C/D revisan → score ≥9 sin HIGH → siguiente.

---

## 8. Casos borde (v2)

1. Publish concurrente → `versionCounter` `$inc` atómico + índice único + retry.
2. Admin desactiva doc bloqueante con pendientes → epoch bump → gate deja de bloquear.
3. Typo fix sin reaceptación → `requiresReacceptance=false` no sube `enforcedVersion`.
4. Doble accept → E11000 = éxito idempotente.
5. Manipulación de evidencia → append-only + **HMAC con secreto** (no recalculable desde DB).
6. Sin docs enforced → `/pending=[]`, fast-path 0 queries.
7. Locale faltante → fallback `defaultLocale` → primer disponible.
8. `effectiveAt` futuro → no vigente ni enforced hasta la fecha (promoción lazy en gate, D3).
9. `expiresAt` pasado → no vigente → no bloquea (se muestra histórico).
10. Markdown malicioso → pipeline §6 (html:false + allowlist).
11. User borrado/erasure → evidencia perdura; `userEmail` anonimizado (GDPR, D13).
12. Token viejo con rol cambiado → audiencia evaluada contra rol en DB.
13. `block_partial` + GET con efectos → etiquetado `complianceEffect:'write'` (D-004/B-M2).
14. Accept de versión obsoleta/futura/no-publicada → backend valida vs versión vigente exigible → `409 VERSION_STALE` (D11).
15. **Admin gated intenta editar compliance** → `/admin/*` NO exento → 403 hasta aceptar (D1).
16. Gate con DB caída → fail-open + log + métrica (no lockout).
17. `currentVersionId` apuntando a draft/archived → imposible: servicio garantiza published+vigente (D8).
18. Ruta pública futura sin `skipCompliance` → gate skip por `requiresAuth:false` (D9).

---

## 9. PRODUCT DECISIONS

```
PRODUCT DECISION: Multi-tenant forward-compatible (sin resolver de tenant hoy)
Razón: single-tenant por deployment (cada org = su EC2). `tenantId` (default 'default') + índices
       scopeados + `resolveTenantId(request)` único. Migrar = poblar tenantId real, sin cambio estructural.
Aprobado por: Equipo A (PM delega — memoria bifrost-full-autonomy)
```
```
PRODUCT DECISION: Markdown (html:false) como formato de autoría; backend devuelve bodyHtml saneado
Razón: requisito (Markdown + preview). Evita XSS de HTML crudo; contenido portable/diff-able/hasheable.
Aprobado por: Equipo A
```
```
PRODUCT DECISION: Fail-open en errores del gate
Razón: un bug de compliance NUNCA debe dejar a una org sin correo. Compliance es aditivo.
Trade-off: ventana de error no enforcea (aceptable vs lockout masivo). Mitigado con métrica+log+kill-switch.
Aprobado por: Equipo A
```

---

## 10. Rollback / observabilidad / testing / retención

- **Rollback**: feature aditiva, backward-compatible (seed no bloquea). Revert commits + drop colecciones `compliance*`. Kill-switch para desactivar en caliente.
- **Observabilidad**: logs en publish/accept/gate-block/gate-error; métricas `compliance_pending_users`, `compliance_acceptances_total`, `compliance_gate_errors_total`, `compliance_gate_blocks_total` (patrón `lib/metrics.ts`).
- **Retención/GDPR (D13)**: evidencia no se borra (valor legal). En borrado/erasure de cuenta se **anonimiza** `userEmail` (p.ej. `deleted-<hash>`) conservando el registro HMAC. Política de retención configurable documentada.
- **Testing**: unit (servicio: gating, versionado, publish concurrente, E11000, `recomputeDenorm`
  idempotente, promoción lazy de `effectiveAt` en el borde + concurrente CAS, reconciler de recovery
  con crash simulado en cada paso de §4.3, XSS) + integration (rutas + gate + orden hooks +
  admin-no-exento + **test de cobertura de manifest de rutas** §3.3) + E2E (primer acceso,
  reaceptación, admin editor) + casos §8.

---

## 11. Regresion Map (validar por B/heredero antes de P1)

| Componente | Dependencia | Riesgo | Validación |
| --- | --- | --- | --- |
| `app.ts` orden de plugins | gate tras authPlugin | HIGH (orden/lockout) | Test orden hooks + allowlist exhaustivo + fail-open |
| Rutas de negocio existentes | etiquetar `complianceEffect`/`skipCompliance` | MEDIUM (omitir una rompe partial) | Auditoría de cobertura de rutas en P3 |
| `plugins/auth.ts` | gate depende de `request.user` | MEDIUM | Guarda `!request.user` → skip |
| `services/auth.ts::toLoginResponse` + `stores/auth.ts` restore | bloque `compliance` aditivo | MEDIUM | Aditivo/opcional; typecheck web; hidratar en restore |
| `shared/types.ts` `LoginResponse` | consumido por web | MEDIUM | Aditivo |
| boot seed reconciler | corre en `index.ts` | MEDIUM | Idempotente + try/catch (patrón reconcile-indexes) |
| `router/index.ts` beforeEach | redirect a gate | MEDIUM | `/compliance/accept` exenta del propio gate (no loop) |

---

## 12. Trazabilidad de hallazgos v1 → resueltos en v2

| Hallazgo | Origen | Resolución |
| --- | --- | --- |
| Seed mandatory rompe logins | B#1/D15/A1 | §5 seed `soft`/`enforcedVersion=0` |
| Publish no transaccional | B#2 | §4.3 `versionCounter` $inc + txn |
| Allowlist por path frágil | B#3/D9 | §3.3 metadata-driven |
| Markdown XSS infraespecificado | B#4/D7 | §6 pipeline dedicado html:false+allowlist |
| Admin gated edita compliance | D1 | §3.3 `/admin/*` no exento |
| Orden de hooks | D2/A5 | §3.4 fastify-plugin tras authPlugin |
| effectiveAt × enforcedVersion | D3 | §2.1 `enforcedFrom` + §4.3 promoción lazy |
| Gate necesita vigencia sin populate | D4 | §2.1 denormalización completa |
| evidenceHash débil | B5/D5/A2 | §2.3 HMAC + contentHash + campos completos |
| settings no conectados | D6 | §2.4 dedicada; grace eliminado; defaultEnforcement wired |
| currentVersionId draft/archived | D8/B-L1 | §2.1 garantizado published+vigente; `latestPublishedVersion` separado |
| mandatory vs soft ambiguo | D10 | §2.1 enum `enforcement` unificado |
| accept versión futura | D11 | §4.1 valida → 409 |
| settings sin tenantId | D12 | §2.4 colección dedicada con tenantId |
| retención/GDPR | D13 | §10 anonimización |
| CSV injection | B-L3/D14 | §4.2 guard |
| no hard-delete con evidencia | B-M4 | §4.2 soft-delete |
| inmutabilidad parcial | B-L2 | §2.2 single write-path + middleware |
| restore/403 frontend | B-M3 | §3.7 |
| block_partial semántico | B-M2 | §3.3 complianceEffect |
| caché gate / perf | B-M1/A4 | §3.6 epoch |
| fail-open/kill-switch | A3 | §3.5 |
| E11000 | A6 | §2.3/§8.4 |
| decline flow | A7 | gate view: única salida logout (P4) |
| resolveTenantId | A8 | §7 P0 |
| publish standalone-safe | B-v2#1 | §4.3 caché rebuildable + reconciler (sin txn multi-doc) |
| lazy effectiveAt vs gate 1-colección | B-v2#2/D-016 | §2.1 slot `next*` + §4.4 recomputeDenorm CAS (gate no lee versiones) |
| denorm drift sin CAS/reconciler | D-017 | §4.3/§4.4 CAS + `reconcileComplianceDenorm` en boot |
| manifest de rutas (no auditoría manual) | B-v2 MED/D-018 | §3.3 manifest obligatorio + test cobertura CI |
| accept con denorm obsoleta | D-019 | §4.4 accept dispara recomputeDenorm antes de validar |
| lookup de rol en gate (perf honesta) | D-020 | §3.1 fast-path 0q; role lookup sólo si hay docs `role:*` |
| kill-switch sin control de acceso | D-021/D-028 | §3.5 env de despliegue + log + métrica + `ComplianceAdminAction` |
| `<img>` en markdown "a decidir" | D-022 | §6 imágenes PROHIBIDAS inline |
| `effectiveAt` no monótono rompe next* | B-v3 HIGH | §4.4 invariante monótono + next* por tiempo + tie-break |
| retry/relectura si CAS falla | D-023 | §4.4 reload+recompute, retry acotado |
| drift de denorm sin self-check runtime | D-024 | §3.6 self-check en snapshot builder + métrica |
| test no detecta mal-etiquetado semántico | D-025 | §3.3 método mutante no puede ser 'read' |
| contentHash inconsistente §2.2 vs §6 | C-M3/D-026 | §2.2 definición única (markdown fuente, sin bodyHtml) |
| PATCH a block_* no bloquea (enforcedVersion=0) | C-M4/D-027 | §4.2 PATCH setea enforcedVersion + recomputeDenorm |
| HMAC canónico ambiguo | C-M1/D-029 | §2.3 JSON orden fijo + length-prefix |
| rotación/key-id HMAC | C-M2 | §2.3 COMPLIANCE_HMAC_SECRET dedicado + hmacKeyId + HKDF |
| IP de proxy en evidencia | C-M6 | §2.3 trustProxy + X-Forwarded-For validado |
| versiones no indelebles | C-M7 | §2.2 middleware cubre delete/replace |
| sin auditoría de acciones admin | C-M8/D-028 | §2.5 ComplianceAdminAction append-only |
| sin verificación de HMAC | C-M9 | §4.2 POST /acceptances/:id/verify |
| epoch sin invalidación cross-worker | C-M10 | §3.6 epoch en Redis + TTL ≤30s |
| defaultEnforcement muerto | C-L1 | §2.4 eliminado |
| accept bumpea epoch tenant-wide | C-L6 | §3.6 sólo recomputo del propio user |
| pipeline vs hash del render | C-L7 | §2.2 `pipelineVersion` persistido |

## 13. Deferidos (TECH DEBT, no bloquean)
- Anexos (upload AttachmentBlob/S3) — campo reservado; LOW; no preexiste regresión.
- Hash encadenado grado-forense — habilitado por contentHash+HMAC; opcional PYME.
- Expiración periódica programada de consentimientos — futuro (la reaceptación por versión cubre el caso base).
