# Resoluciones para DESIGN v2 — respuesta a revisión Fase 2

Estado: `IN_REVIEW_DOC` (v1 → v2). B (Codex) = NOT APPROVE 6/10. C/D pendientes de integrar.
Este archivo consolida las resoluciones; al cerrar se fusionan en `DESIGN.md` como v2.

## Resoluciones a HIGH de B (autoridad primaria — confirmados)

### R-HIGH-1 — Seed conservador no contradictorio (B#1 = A1)
Decisión vinculante (ya en Addendum §13 HIGH-A1):
- 7 docs `system` se siembran `published`, `mandatory=false`, `enforcement='soft'`, `enforcedVersion=0`.
- El admin opta conscientemente por `mandatory=true` (acto auditado).
- §5 y §10 del DESIGN se reescriben para eliminar la contradicción.
- Test: tras seed en deployment con usuarios → `GET /pending` retorna `[]`; ningún login bloqueado.

### R-HIGH-2 — Publish transaccional/atómico (B#2)
El modelo §2.1 NO definía el contador del `$inc`. Decisión:
- `ComplianceDocument.versionCounter: number` (default 0) — secuencia monotónica real.
- **Publish dentro de una transacción MongoDB** (Mongoose `session`, replica-set; en standalone:
  protocolo atómico con guardas + índice único como red de seguridad). Pasos atómicos:
  1. `findOneAndUpdate(doc, {$inc:{versionCounter:1}})` → obtiene `nextVersion` atómico.
  2. Set version: `version=nextVersion`, `status='published'`, `publishedAt=now`, `contentHash`.
  3. Set en doc: `currentVersionId=version._id`; si `requiresReacceptance` → `enforcedVersion=nextVersion`.
  4. Bump `complianceEpoch` (invalida caché).
  - Todo en la misma transacción → o todo o nada. Sin transacción (standalone): orden
    versión→puntero→epoch con el índice único `(documentId,version)` evitando duplicados + retry.
- Índice único `(tenantId, documentId, version)` = red de seguridad ante carrera.
- Test de concurrencia: 2 publish simultáneos → versiones 1 y 2 distintas, puntero consistente.

### R-HIGH-3 — Gate metadata-driven, no allowlist por path (B#3)
B detectó que `setup` y `signature-images` ya son públicas y quedaban fuera de mi allowlist.
Decisión: el gate **no usa lista de paths**. Usa **metadata de ruta** (Fastify `config`):
- Reusar el flag existente `requiresAuth:false` → esas rutas saltan el gate (no hay user).
- Nuevo flag `config.skipCompliance:true` → exime explícitamente una ruta autenticada del gate
  (p.ej. `/api/compliance/*`, `/api/auth/logout`, `/api/auth/me`).
- Nuevo flag `config.complianceEffect: 'read' | 'write' | 'none'` → clasificación **semántica**
  por ruta para `block_partial` (resuelve también B-MEDIUM#2: GET con efectos = `'write'`).
  Default si ausente: métodos GET/HEAD = `read`, demás = `write`.
- El gate: si `requiresAuth===false || skipCompliance` → pasa. Si no, evalúa pending; `block_full`
  bloquea todo; `block_partial` bloquea sólo `complianceEffect==='write'`.
- Cada ruta de negocio existente se audita y etiqueta (P3). Test exhaustivo de cobertura.

### R-HIGH-4 — Pipeline Markdown→HTML saneado dedicado (B#4)
El `lib/sanitizeHtml.ts` actual es para email (permite estilos/imágenes) → NO reusar tal cual.
Decisión: pipeline dedicado `lib/complianceMarkdown.ts`:
- Parser markdown determinista (sin HTML crudo embebido: `html:false` en el parser). Lib liviana
  (markdown-it con `html:false`, o `marked` con sanitize). Evaluar dependencia mínima.
- Tras render → **sanitizar con allowlist estricta** (DOMPurify/sanitize-html) limitada a tags de
  documento legal: h1-h4, p, ul/ol/li, strong/em, blockquote, a (href http/https + `rel=noopener`),
  table básica, hr, code. **Sin** `style`, `script`, `iframe`, `on*`, data URIs ejecutables.
- El **backend** devuelve HTML ya saneado (`bodyHtml`) además del markdown fuente → el frontend
  no confía en render propio. Defensa en profundidad (saneo en escritura y en lectura).
- `contentHash` se computa sobre el markdown fuente canónico.
- Test XSS: payloads `<script>`, `<img onerror>`, `javascript:` href, `<iframe>` → neutralizados.

## Resoluciones a MEDIUM/LOW de B

- B-M1 (caché gate) → cubierto por `complianceEpoch` + snapshot TTL (Addendum A4). Invalidar en
  publish/accept/cambio rol/metadata.
- B-M2 (block_partial semántico) → cubierto por R-HIGH-3 (`complianceEffect`).
- B-M3 (restore/403 frontend) → el store hidrata compliance también tras `/auth/refresh`+`/auth/me`
  (no sólo login); interceptor axios global maneja `403 COMPLIANCE_REQUIRED` → redirige al gate y
  refresca pending. Verificado contra `stores/auth.ts` (restore real).
- B-M4 (no hard-delete con evidencia) → `DELETE` documento sólo permitido si NO existe ninguna
  versión publicada NI aceptación; en cualquier otro caso → soft-delete (`active=false`). System
  nunca se borra.
- B-M5 (hash no prueba contenido) → añadir `versionId` + `contentHash` al `evidenceHash`
  (cubre A2). HMAC con secreto server para tamper-evidence real (no sólo hash).
- B-L1 (currentVersionId vs vigente) → separar `latestPublishedVersion` (lo último publicado) de la
  resolución "vigente ahora" (filtra `effectiveAt<=now<expiresAt`). El gate y el render usan la
  vigente; el editor ve la última publicada.
- B-L2 (inmutabilidad sólo pre('save')) → prohibir `updateOne/findOneAndUpdate/bulkWrite` sobre
  versiones publicadas vía un **servicio único** (`compliance.service`) que es el único path de
  escritura; middleware `pre(['updateOne','findOneAndUpdate'])` que rechaza si target no-draft.
- B-L3 (CSV formula injection) → prefijar con `'` los campos que empiezan con `= + - @` en el export.

---

# Resoluciones para v3 (respuesta a B v2 = 8/10 NOT APPROVE)

## R3-HIGH-1 — Publish standalone-safe sin transacción multi-doc (B-v2 HIGH1)
Decisión: **NO** exigir replica-set (Bifrost corre en EC2 modesto, Mongo puede ser standalone).
La denormalización en `ComplianceDocument` pasa a ser **caché derivada rebuildable**; la **fuente de
verdad** es `ComplianceVersion`. Patrón = `reconcile-indexes` ya existente.
Secuencia de publish (cada paso = escritura de UN documento, idempotente):
1. `$inc versionCounter` (atómico, 1 doc) → `nextVersion`.
2. Upsert versión `published` (unique `(documentId,version)` ⇒ idempotente ante retry).
3. Recompute denormalización desde versiones autoritativas (1 doc update, CAS).
4. Bump `complianceEpoch`.
Recovery: `reconcileComplianceDenormalization()` corre en boot (patrón reconcile-indexes) **y** lo
invoca el epoch/snapshot builder al detectar drift. Crash entre 1–4 autosana:
- tras 1 (counter sin versión) → gap de secuencia inocuo.
- tras 2 (versión publicada, denorm vieja) → reconciler detecta `published.version > latestPublished` → recomputa.
- tras 3 (denorm ok, epoch sin bump) → snapshot stale ≤ TTL; próximo refresh/boot sana.
Tests: crash simulado en cada punto → estado converge; publish concurrente → versiones distintas.

## R3-HIGH-2 — Denormalizar "próxima versión vigente" (B-v2 HIGH2 / cierra D3)
Añadir a `ComplianceDocument` el slot de la próxima versión programada:
`nextVersionId, nextVersionNumber, nextEffectiveAt, nextContentHash, nextRequiresReacceptance`.
- Publish con `effectiveAt` futuro ⇒ llena el slot `next*` (no toca `current*`).
- El epoch/snapshot builder (fuera del hot path), al construir el snapshot, si
  `nextEffectiveAt!=null && nextEffectiveAt<=now` ⇒ dispara `reconciler` que **promueve** next→current
  vía `findOneAndUpdate` con guarda CAS (`nextVersionNumber==X && currentVersionNumber<X`) y bump epoch.
- El **gate (hot path) lee SÓLO campos denormalizados** (current + next) de `ComplianceDocument`; el
  reconciler (idempotente, CAS, raro) es quien consulta versiones autoritativas. Resuelve la
  contradicción "1 colección en el hot path".
Tests: múltiples versiones futuras, promoción en el borde de `effectiveAt`, promoción concurrente (CAS).

## R3-MEDIUM — Manifest obligatorio de rutas + skips finos (B-v2 MEDIUM)
- `complianceEffect`/`skipCompliance` = **manifest explícito por ruta**, con **test de cobertura** que
  FALLA si alguna ruta registrada no declara clasificación (sin defaults ambiguos).
- `/api/auth/*` deja de ser skip-en-bloque: skip SÓLO `/login`, `/logout`, `/refresh`, `GET /me`.
  `PATCH /api/auth/me/preferences` ⇒ `complianceEffect:'write'` (gated en block_partial/full).
- GETs con efectos (p.ej. `emails.ts:171` marca leído) ⇒ `complianceEffect:'write'`.
- Test enumera todas las rutas y asserta clasificación explícita.

---

# Resoluciones para v4 (C v2 = 7/10 — 8 MEDIUM nuevos de valor; H1/H2 ya cerrados en v3)

C confirmó H1 (lazy effectiveAt) y H2 (publish standalone) → YA resueltos en v3 (§4.4 next*/recomputeDenorm + §4.3 reconciler). Nuevos a integrar en v4:

- **R4-M1 (HMAC canónico):** definir forma canónica NO ambigua = JSON con orden de claves fijo y
  campos length-prefixed (o TLV). Evita colisiones por `|` en userAgent. Especificar exacto en §2.3.
- **R4-M2 (rotación/key-id HMAC):** secreto **dedicado** `COMPLIANCE_HMAC_SECRET` (NO derivado de
  JWT_SECRET). Cada aceptación guarda `hmacKeyId`. Registro de claves versionadas (HKDF), claves
  retiradas se archivan (no se borran) → la evidencia histórica siempre verificable. Documentar.
- **R4-M3 (contentHash consistente):** UNA definición: `contentHash = sha256(JSON canónico de
  contents[] con campos {locale,title,bodyMarkdown})` — markdown fuente, TODAS las locales, **sin**
  bodyHtml (derivado del pipeline). La aceptación guarda `locale` (lo que el user vio) + contentHash.
  Corregir §2.2 y §6 para que coincidan.
- **R4-M4 (dead config block_* con enforcedVersion=0):** validación en publish/PATCH — fijar
  `enforcement` a `block_*` exige una versión publicada vigente; si `enforcedVersion==0` se setea a
  `currentVersionNumber` (o se rechaza con mensaje claro). UI/endpoint avisa que el nivel solo no basta.
- **R4-M5 (role freshness):** el GATE hace su propio `User.select('role')` (ya en v3 §3.1). Ajustar
  §8.12 para decir "evaluado vía el lookup de rol del gate" (no claim, no asume authPlugin refresca).
- **R4-M6 (trustProxy → IP real):** configurar `fastify({trustProxy})` + tomar IP de `X-Forwarded-For`
  validado (deployment tras CloudFront/ALB). La evidencia debe llevar la IP del usuario, no del proxy.
- **R4-M7 (versiones indelebles):** extender middleware de inmutabilidad a
  `deleteOne/deleteMany/replaceOne/findOneAndDelete/findOneAndReplace`: rechazar sobre versiones
  `published`. Nunca hard-delete de versión con aceptaciones (dangling de evidencia).
- **R4-M8 (auditoría de acciones admin):** NUEVA colección append-only `ComplianceAdminAction`
  (actor, action, targetType/Id, before/after, at, ip). Registra create/edit/delete doc, cambio de
  enforcement, publish, export. Gobierno del propio framework (distinto del documento audit-policy).
- **R4-M9 (verificación HMAC):** `POST /api/compliance/admin/acceptances/:id/verify` (recomputa HMAC
  con su `hmacKeyId`) + metadata de verificación en el export. "Tamper-evident" demostrable, no teórico.
- **R4-M10 (epoch cross-worker):** persistir `complianceEpoch` en **Redis** (ya hay ioredis) o
  chequeo barato del epoch en DB; invalidación cross-worker vía Redis pub/sub. TTL del snapshot
  acotado y explícito (p.ej. 30s) como cota superior de la ventana de staleness multi-worker.
- **R4-LOW:** L1 eliminar `defaultEnforcement` (enforcement es requerido, sin fallback); L4 guard
  `expiresAt>effectiveAt`; L6 accept NO bumpea epoch tenant-wide (solo recomputo del propio user);
  L7 guardar `pipelineVersion` con bodyHtml (prueba del render exacto); cerrar decisiones §6.

---

# Resolución HIGH B v3 (8.5/10 → camino a 9 APPROVE) + cierra C-L4/L5

**R4-HIGH-B3 — `effectiveAt` no monótono rompe el slot `next*`:**
Adoptar AMBAS (defensa en profundidad):
1. **Invariante:** publish RECHAZA si `effectiveAt < latestPublishedEffectiveAt` del documento
   (effectiveAt monótono no decreciente por versión). Mensaje claro al admin.
2. **Redefinir `next*`** = la versión publicada con **menor `effectiveAt > now`** (no "menor version"),
   tie-break por **mayor `version`** ante igual effectiveAt; ignora versiones futuras ya superseded por
   una versión mayor ya vigente. `recomputeDenorm` calcula así current*/next*.
Con la invariante (1), "menor effectiveAt>now" == "menor version con effectiveAt>now", pero (2) lo deja
robusto aun si la invariante se relajara. Cierra también C-L4 (ventana vacía: guard `expiresAt>effectiveAt`)
y C-L5 (effectiveAt regresivo). Tests: publish no monótono → 409; v2 futura + v3 más-futura → next* correcto.
