# Fase 2 — Cierre del Documento Consolidado de Diseño

Estado: **APPROVED** (pendiente confirmación final de C sobre v4; sus 10 MEDIUM ya integrados)
Equipo A: Claude Code · Tipo: FEATURE

## Tabla de scores (evolución por iteración)

| Revisor | v1 | v2 | v3 | v4 | Veredicto final |
| --- | --- | --- | --- | --- | --- |
| **B (Codex)** — autoridad primaria | 6 | 8 | 8.5 | **9** | ✅ APPROVE, 0 HIGH |
| **D (Kimi)** — auditor independiente | 6 | 7 | 8 (cond.) | **9** | ✅ APPROVE (incondicional), 0 HIGH |
| **C (z.ai GLM)** — lógica/datos | — | 7 | hung | (confirmando) | 10 MEDIUM integrados en v4 |

**Cadena de autoridad:** B primaria, activa toda la sesión. C tuvo episodios `TEAM_UNAVAILABLE`
(env var `ANTHROPIC_API_KEY` interfería el wrapper `z`; mitigado con `env -u`). Su review v2 fue
exhaustiva y sus 10 MEDIUM están todos resueltos en v4 (trazabilidad §12 del DESIGN).

## HIGH resueltos en la convergencia (todos cerrados)

1. Seed mandatory rompe logins (B1/D15/A1) → seed `soft`/enforcedVersion=0.
2. Publish no transaccional (B2) → versionCounter + caché rebuildable + reconciler.
3. Allowlist por path frágil (B3/D9) → gate metadata-driven.
4. Markdown XSS (B4/D7) → pipeline dedicado html:false + allowlist.
5. Admin gated edita compliance (D1) → /admin/* no exento.
6. Orden de hooks (D2/A5) → fastify-plugin tras authPlugin.
7. effectiveAt futuro × enforcedVersion (D3) → enforcedFrom + promoción lazy.
8. Publish standalone (B-v2#1/C-H2) → caché rebuildable + reconcileComplianceDenorm.
9. Lazy effectiveAt vs gate 1-colección (B-v2#2/D-016/C-H1) → slot next* + recomputeDenorm CAS.
10. effectiveAt no monótono rompe next* (B-v3) → invariante monótono + next* por tiempo.

## MEDIUM de endurecimiento (C, todos integrados en v4)

HMAC canónico length-prefixed + secreto dedicado + hmacKeyId; trustProxy/IP real; contentHash única;
PATCH→block_* setea enforcedVersion; versiones indelebles; ComplianceAdminAction; verify HMAC;
epoch Redis cross-worker; drift self-check runtime; defaultEnforcement eliminado; pipelineVersion.

## Notas para P1 (no bloqueantes, de D y B)

- Tests obligatorios: effectiveAt no-monótono→409, empate effectiveAt gana mayor versión, promoción
  concurrente CAS/retry (B).
- D-023: especificar backoff y comportamiento tras agotar 3 retries CAS.
- §3.6: fallback si Redis no responde (epoch también en Mongo; TTL≤30s acota la ventana).
- El reconciler debe vivir en/ser invocado por `services/compliance.ts` (single write-path).

## Regresion Map

Validado por B como parte de la aprobación del documento completo (DESIGN §11).

## Decisión

**Fase 2 APROBADA.** Se procede a Fase 3 (implementación por fases P0–P6) con QA en loop B/C/D por
fase. P0: 5 modelos + índices + resolveTenantId + registro de claves HMAC + seeds + reconciler.

## Nota de cierre sobre C (z.ai)
C v4 quedó en `TEAM_UNAVAILABLE` (cuelgue intermitente del wrapper `z` con el doc grande, no un
hallazgo). Su review v2 (7/10) fue exhaustiva y sus 10 MEDIUM están todos integrados en v4 (verificado
por A como agente extra del dominio lógica/datos). **Validación obligatoria de C al retomar:** revisará
la implementación P0 (código que ejercita el mismo diseño). Avance autorizado por B (autoridad
primaria, 9/10 APPROVE) + D (9/10 APPROVE), 0 HIGH.

---

# Fase 3 — P0 (capa de datos) CERRADO

Estado: **APPROVED** por B (9/10) + D (9/10), 0 HIGH. C (z.ai) unavailable (529), valida al retomar.

Entregado: 5 modelos (`models/Compliance{Document,Version,Acceptance,Settings,AdminAction}.ts`),
`lib/complianceTenant.ts` (resolveTenantId), `lib/complianceHmac.ts` (HKDF, canónico length-prefix
en bytes UTF-8, rotación por hmacKeyId, timingSafeEqual). 23 tests de compliance (15 inmutabilidad +
8 HMAC), 241/241 del API verdes, typecheck/lint limpios.

QA loop (multi-equipo funcionando como diseñado):
- D inicial 7/10: 2 HIGH (TOCTOU, published→draft bypass) + 9 más → corregidos.
- D 8/10: 2 MEDIUM residuales (pipeline-update, doc.deleteOne in-memory) → corregidos → D 10/10.
- **B 6/10: 2 HIGH MÁS PROFUNDOS** que D no vio (bypasses por operador/dot-path/\$unset/\$inc;
  freeze incompleto de campos en save()). B recomendó INVERTIR la política.
- Política invertida: query-hooks SIEMPRE acotan a draft (inmune a operadores); save() congela TODO
  vía modifiedPaths() salvo published→archived. → B 9/10 APPROVE, D 9/10 APPROVE.

Lección: B (autoridad primaria, paranoico) capturó vectores que D aprobó. El enfoque de "detectar
campos peligrosos" era frágil; "congelar todo y abrir sólo la transición permitida" es robusto.

Siguiente: P1 (servicio compliance: publish atómico + versionCounter, recomputeDenorm + reconciler
con promoción lazy de effectiveAt, gating, accept idempotente+HMAC, pipeline markdown html:false,
seeds loader idempotente). Limitación documentada arrastrada a P1: el servicio debe ser el ÚNICO
write-path (bulkWrite/db.collection prohibidos) y verificar matchedCount tras updates acotados.

---

# TECH DEBT TICKETS (compliance)

## TD-WATERMARK-CRASH (LOW) — detectado en P1 por B
Watermark monótono (`latestPublishedEffectiveAt`) y status-flip de publish no están en una transacción
(Mongo puede ser standalone). Un crash en la ventana de microsegundos entre el CAS del watermark y el
flip draft→published deja el watermark adelantado sin versión publicada correspondiente → falsos 409
`EFFECTIVE_AT_NOT_MONOTONIC` en publicaciones futuras de ESE documento. Conservador (no rompe
monotonicidad ni datos). Mitigación propuesta (hardening pass): que `reconcileComplianceDenorm` en boot
resetee AUTORITATIVAMENTE el watermark a `max(effectiveAt de versiones publicadas)` (no raise-only),
auto-sanando un watermark trabado. Severidad LOW: ventana de microsegundos, recuperable.
Aprobado para avanzar por B (9/10) y D (9/10) como no-bloqueante.

## TD-IP-CAPTURE (P2) — D-035/B-LOW
`recordAcceptance` recibe ip/userAgent como parámetros; la captura server-side real (request.ip vía
`fastify({trustProxy})` + X-Forwarded-For validado) es responsabilidad de la ruta (P3 gate / P2 accept).

---

# Fase 3 — P1 (servicio) CERRADO
APPROVED por B 9/10 + D 9/10, 0 HIGH. Loop de QA: D 7→8→10→9; B 6.5→8→9 (HIGH-1 publish race cerrado
con watermark monótono atómico). Entregado: services/compliance.ts, lib/complianceMarkdown.ts,
compliance/seedDocuments.ts, boot wiring en index.ts, métricas Prometheus. 269/269 tests.
Siguiente: P2 (rutas) EN CURSO → P3 gate hook → P4 frontend → P5 editor → P6 E2E.

## PRODUCT DECISION — `code` en errores 4xx (D-008)
El error handler incluye `code` (VERSION_STALE, NO_PUBLISHED_VERSION, COMPLIANCE_REQUIRED, etc.) en
respuestas 4xx. Razón: el frontend lo necesita para discriminar estados sin parsear mensajes. Trade-off:
expone los nombres de estados de error (contrato de API documentado, NO datos ni estructura interna
sensible). Aceptado por A. No se expone en 5xx de producción.

---
# Fase 3 — P2 (rutas) CERRADO
APPROVED B 9/10 + D 9/10, 0 HIGH. Loop: B 7→9 (HIGH tenant scoping + 3 MED); D 7→9 (2 MED + 6 LOW:
audience leak, N+1, mass-assignment, evidenceHmac, etc.). routes/compliance.ts + app.ts (code field,
registro). 14 route tests + 283/283 api. Siguiente: P3 gate hook (EN CURSO).

---
# Fase 3 — P3 (gate hook) EN QA
plugins/compliance-gate.ts: onRequest tras authPlugin (request.user poblado); metadata-driven
(requiresAuth:false/skipCompliance/complianceEffect, NO por path); fast-path por epoch snapshot (0
queries sin docs enforced); block_full→403 COMPLIANCE_REQUIRED; block_partial bloquea complianceEffect
'write'; FAIL-OPEN ante error + kill-switch COMPLIANCE_ENFORCEMENT_DISABLED; métricas gate. 8 tests de
integración (enforcement real, fast-path, accept libera, partial GET/POST, kill-switch, públicas exentas,
admin bloqueado). 291/291 api verdes.

## DECISIÓN — login response (B-M3)
El SPA hidrata el estado de compliance llamando `GET /api/compliance/pending` en login y restore (no
embebido en la login response, que requeriría refactor async de toLoginResponse). Equivalente y más
simple; el gate ya devuelve 403 COMPLIANCE_REQUIRED en rutas de negocio. El interceptor 403 + el fetch
de /pending son responsabilidad de P4 (frontend).

## TECH DEBT — manifest coverage test (B-v2/D-018)
El default semántico del gate (GET/HEAD→read, resto→write) clasifica toda ruta de forma segura; el
test del gate cubre que block_partial bloquea POST. Pendiente (LOW): test de CI que enumere TODAS las
rutas vía onRoute y falle si una ruta mutante declara complianceEffect:'read' (red de seguridad para
rutas futuras). No bloqueante: el default ya impide el mislabel peligroso por método.

## P3 — Resoluciones de QA (B + D)
- B-MEDIUM: `GET /auth/me` ahora `skipCompliance` (anti-deadlock del restore del SPA).
- D-001 (HIGH fail-open): fail-mode CONFIGURABLE `COMPLIANCE_FAIL_MODE=open|closed` (default open por
  disponibilidad; closed deniega 503 ante error). Métrica `compliance_gate_errors_total` = alarma.
- D-003 (MEDIUM amplificación de queries): caché por-usuario `userCompliantAtEpoch` (Map keyed por epoch,
  cap 50k) → un usuario plenamente conforme salta los lookups hasta el próximo bump de epoch. NO se
  cachea si quedan pendientes (block_partial depende de la ruta). Estado estacionario barato.
- D-006 (LOW Map sin límite): cap MAX_USER_CACHE.

### PRODUCT DECISIONS P3
- **D-002 — `GET /emails/:id/body` clasificado 'read' pese a escribir caché.** Razón: leer el propio
  correo es una LECTURA de negocio; `block_partial` bloquea acciones de ESCRITURA de negocio (componer/
  enviar), no leer. El side-effect (bodyCached/preview/redis) es optimización interna benigna, no una
  acción del usuario sujeta a compliance. Trade-off: un user con partial pendiente puede poblar caché al
  leer. Aceptado por A (B coincidió).
- **D-004 — rutas admin de compliance NO exentas (sin skipCompliance).** Razón: preserva "un admin con
  políticas pendientes debe aceptar antes de administrar" (DESIGN §3.3 / P0 D-001). El admin NUNCA queda
  en lockout: `POST /accept` está exento → el admin acepta sus propios pendientes y se desbloquea; si la
  aceptación fallara por bug, el kill-switch `COMPLIANCE_ENFORCEMENT_DISABLED=1` es la salida operativa.
- **Fail-open default** (reafirma DESIGN §9): un bug de compliance jamás debe dejar a una org sin correo.

### LOW aceptados/documentados
- D-005 ventana de staleness ≤~60s (epoch TTL): acotada, documentada en diseño §3.6.
- D-007 race getEpoch/exists: auto-corrige al siguiente request (epoch mismatch → re-query).
- D-008 patrón `void reply.send()`: consistente con `plugins/auth.ts` del repo.

---
# Fase 3 — P3 (gate hook) CERRADO
APPROVED B 9/10 + D 10/10, 0 HIGH. Loop: B 8→9 (MEDIUM /auth/me deadlock); D 7→10 (HIGH fail-open→
configurable, MEDIUM query-amplification→caché por-usuario, Map cap, + 2 product decisions). Caveat de B
(role-change) cerrado con TTL 60s en la caché por-usuario. 10 gate tests + 293/293 api.

## BACKEND DEL FRAMEWORK COMPLETO Y APROBADO (P0+P1+P2+P3)
Modelos, servicio (versionado/publish atómico/gating/accept/seeds/recompute/reconciler), rutas (user+
admin/Zod/CSV/verify), gate hook (enforcement real, fail-open configurable, caché epoch+por-usuario,
kill-switch). Todo B≥9/D≥9. 293/293 tests api. Falta: P4 frontend, P5 editor admin, P6 E2E+docs.

---
# Fase 3 — P4 (frontend usuario) EN QA — resoluciones
- B-MEDIUM: router mantiene al user en el gate con block_partial (no solo block_full).
- D-001 (HIGH loop por pending vacío): markRequired marca block_full siempre (un 403 es autoritativo);
  gate view no rebota si bloqueado sin docs (muestra mensaje).
- D-002 (HIGH fetchPending error limpia bloqueo): el catch ya NO resetea a 'none'.
- D-003: accept no relanza si el refresh posterior falla (POST ya registró; idempotente).
- D-004: LoginView llama fetchPending tras login (gate proactivo, no solo reactivo al 403).
- D-005: interceptor 403 registrado DESPUÉS de app.use(router).
- D-007: router.push con .catch.

## PRODUCT DECISION — v-html sin saneo frontend (D-006)
El `bodyHtml` se renderiza con v-html confiando en el saneo del BACKEND (pipeline markdown html:false +
sanitize-html allowlist estricta, DESIGN §6, XSS-tested). Es MÁS estricto que el saneador de email que la
app ya confía (EmailBodyFrame). El scroll-to-accept requiere render inline (un iframe sandbox rompería la
detección de scroll). El web no tiene saneador propio; el patrón del repo es confiar en el backend +
aislamiento (iframe) para email. Para compliance, dado el pipeline más estricto, v-html inline es aceptable.
Aprobado por A.

---
# Fase 3 — P4 (frontend usuario) CERRADO
APPROVED B 10/10 + D 10/10. Loop: B 8→10 (block_partial gate); D 6→10 (2 HIGH loop/reset-bloqueo +
4 MEDIUM). stores/compliance.ts, main.ts (interceptor 403), router gate, views/ComplianceGateView.vue
(scroll-to-accept, i18n es/en), LoginView fetchPending. 34 web tests. Siguiente: P5 editor admin.

---
# Fase 3 — P5 (gestión admin) CERRADO
APPROVED B 9/10 + D 9/10. Loop: B 7→9 (HIGH CSV window.open auth + LOW state-sync); D 6→9 (2 MED ya =
B-HIGH + lint, 5 LOW). components/admin/ComplianceAdmin.vue + tab en AdminView. CSV via api.get blob.

# ✅ TODAS LAS FASES DE IMPLEMENTACIÓN APROBADAS (P0–P5), B≥9/D≥9, 0 HIGH abiertos.
Backend (modelos/servicio/rutas/gate) + frontend (gate usuario + panel admin). 293 api tests + 34 web
tests. Falta P6: E2E browser (Playwright) + documentación funcional. i18n panel admin = follow-up LOW.

---
# Fase 3 — P6 (E2E + doc funcional) CERRADO
APPROVED B 9/10 + D 9/10. E2E full-stack (packages/web/e2e/compliance.spec.ts) PASA: admin publica
block_full → user 403 COMPLIANCE_REQUIRED en ruta de negocio → forzado al gate → POST /accept 200 →
ruta de negocio 200 (desbloqueado). Self-cleaning, find-or-create retry-safe. docs/compliance/FUNCTIONAL.md.

═══════════════════════════════════════════════════════════════════════════════
# 🎯 MISIÓN COMPLETA — Compliance Framework BifrostMail

## Tabla de scores finales (todas las fases B≥9/D≥9, 0 HIGH)
| Fase | B (Codex, autoridad primaria) | D (Kimi, auditor) |
| --- | --- | --- |
| Diseño v4 | 9 ✅ | 9 ✅ |
| P0 modelos+libs | 9 ✅ | 9 ✅ |
| P1 servicio | 9 ✅ | 9 ✅ |
| P2 rutas | 9 ✅ | 9 ✅ |
| P3 gate hook | 9 ✅ | 10 ✅ |
| P4 frontend usuario | 10 ✅ | 10 ✅ |
| P5 gestión admin | 9 ✅ | 9 ✅ |
| P6 E2E + docs | 9 ✅ | 9 ✅ |

C (z.ai GLM): revisó el diseño (v2, 10 MEDIUM integrados); episodios TEAM_UNAVAILABLE (env var + 529).
A cubrió su dominio (lógica/datos) como agente extra; B+D fueron autoridad+auditor en todas las fases.

## Entregables (todos cumplidos)
Framework funcional ✅ · Editor admin ✅ · Versionado inmutable ✅ · Aceptación con evidencia HMAC ✅ ·
Registro de auditoría ✅ · Reaceptación automática ✅ · Modal/gate de primer acceso ✅ · API ✅ ·
BD normalizada (5 colecciones) ✅ · Doc técnica (DESIGN) ✅ · Diagramas (ARCHITECTURE) ✅ · Doc funcional
(FUNCTIONAL) ✅ · Casos de uso/borde (DESIGN §8) ✅ · Tests unitarios+integración+E2E ✅.

## Pruebas: 293 API + 34 web + 1 E2E full-stack — todo verde.

# POST-MORTEM TÉCNICO

## Qué se construyó
Un framework de compliance completo y desacoplado: capa de datos inmutable, servicio único-write-path
con publish atómico standalone-safe, rutas user+admin con tenant-scoping, gate de enforcement metadata-
driven con fail-open configurable y caché de dos niveles, frontend de aceptación con scroll-to-accept y
panel admin, todo con evidencia legal HMAC tamper-evident.

## Qué capturó el proceso multi-equipo (que un solo revisor no vio)
- **B (paranoico, autoridad primaria)** detectó capas profundas que D había aprobado: bypasses de
  inmutabilidad por operador/dot-path (P0), publish race + reconciler sin cablear en boot (P1), tenant-
  scoping faltante en rutas admin (P2), CSV export sin auth header (P5), deadlock de block_partial (P4).
- **D (auditor independiente)** encontró lo que B no priorizó: enumeración por audiencia, N+1 DoS,
  mass-assignment, exposición de HMAC (P2), loop por pending vacío + reset de bloqueo (P4).
- **A (auto-auditoría CRON)** encontró independientemente la amplificación de queries (caché por-usuario)
  y el gap de i18n del gate.
La convergencia (mismo HIGH hallado por B y D por separado) validó los puntos críticos.

## Señales tempranas / qué evitaría repetirlo
- Patrón "detectar campos peligrosos" es frágil → invertir a "congelar todo, abrir lo permitido".
- Denormalización = caché rebuildable con reconciler de boot (patrón reconcile-indexes) evita estados
  partidos en Mongo standalone sin transacciones multi-doc.
- Campos monotónicos (watermark, enforcedVersion, latestPublished) se elevan con guard atómico $lt.
- Tenant-scoping debe estar en CADA query desde el día 1 (forward-compatible), no como afterthought.

## Tech debt (LOW, registrado)
TD-WATERMARK-CRASH; manifest coverage test de rutas; i18n del panel admin; per-tenant Map LRU para
multi-tenant real; métrica dedicada del kill-switch.

## Decisión final: APROBADO. Listo para merge/deploy (con la salvedad de que las plantillas legales son
plantillas iniciales que cada organización debe adaptar/revisar legalmente antes de producción).

═══════════════════════════════════════════════════════════════════════════════
# 🔴 RE-AUDITORÍA HOSTIL POST-CIERRE (CRON auto-auditoría) — 3 HIGH + 2 MED reencontrados y CERRADOS

La auto-auditoría obligatoria (no rubber-stamp) reabrió el código con B(Codex)+D(Kimi) en modo hostil.
Honestidad brutal: el "cierre" anterior NO estaba completo — había defectos profundos de concurrencia y
de modelo de versionado que los 8 reviews previos no ejercitaron. Se RETOMÓ trabajo activo.

## Hallazgos (convergencia B+D independiente)
- **HIGH-1 — versionado legal no monotónico por `effectiveAt`.** `version` se asigna al crear el draft
  (orden de creación), pero `current` se elige por mayor `effectiveAt` y `enforcedVersion` por mayor
  número de versión. Publicar un draft de número MENOR con `effectiveAt` POSTERIOR (permitido por el viejo
  watermark, que sólo miraba effectiveAt) dejaba `currentVersionNumber=1 / enforcedVersion=2` →
  **threshold insatisfacible**: un usuario nuevo sólo puede aceptar la current (v1), pero el gate exige
  ≥2 → bloqueo permanente; usuarios que aceptaron v2 quedan falsamente conformes. (D lo confirmó
  independientemente como "edge case real".)
- **HIGH-2 — `recomputeDenorm` revertía `current*` con lectura stale.** El `$set` de current era
  INCONDICIONAL: un recompute que leyó menos versiones publicadas (carrera con un publish) sobrescribía
  `current=2` con `current=1`, mientras `enforcedVersion` (guard `$lt`) quedaba en 2 → mismo estado
  insatisfacible current<enforced.
- **HIGH-3 — publish no atómico entre watermark y status (fantasma tras crash).** Un crash entre el
  watermark CAS y el status-flip dejaba el watermark adelantado con la versión aún en draft → bloqueaba
  re-publicar. (Estaba catalogado LOW como TD-WATERMARK-CRASH; D lo reevaluó MED/HIGH = "DoS
  administrativo hasta reboot". Aceptado: estaba mal catalogado.)
- **MED-4 — caché del gate ignora tenant.** `userCompliantAtEpoch` keyed sólo por `userId` → forward-
  compat multi-tenant: un user conforme en tenant A saltaría la verificación en B con el mismo epoch.
- **MED-5 — versión futura se activa con el usuario cacheado.** Un `block_full` programado (effectiveAt
  futuro) no bumpea epoch al entrar en vigencia → el user cacheado conforme escribía hasta 60s pese al
  bloqueo recién vigente.

## Fixes (todos con test de regresión; 79/79 compliance verde, tsc+eslint limpios)
- HIGH-1 → `publishVersion` exige y avanza `latestPublishedVersion < v.version` en el MISMO CAS que el
  watermark de `effectiveAt` (atómico, cierra dos publishes concurrentes desordenados) → la versión
  publicada más reciente es a la vez la de mayor número y mayor effectiveAt → **se garantiza
  enforcedVersion ≤ currentVersionNumber**. Cinturón: `threshold = min(enforcedVersion,
  currentVersionNumber)` en `getPendingForUser` (sanea además datos legados). [compliance.ts:~517,~722]
- HIGH-2 → `recomputeDenorm` eleva los watermarks PRIMERO y luego hace el `$set` de current*
  CONDICIONADO a `latestPublishedVersion <= maxVersionSeen` → un recompute stale no pisa current.
  Preserva limpieza de current expirado y promoción next→current. [compliance.ts:~153-200]
- HIGH-3 → `recomputeDenorm(opts.authoritative)`; `reconcileComplianceDenorm` (boot, single-thread) lo
  pasa `true` y resetea los watermarks al máximo REAL entre versiones PUBLICADAS → sana el fantasma y
  permite re-publicar el draft huérfano. [compliance.ts:~153-165,~200]
- MED-4 → key de caché `${tenantId}:${userId}`. [compliance-gate.ts:~33]
- MED-5 → `getPendingForUser` devuelve `recheckAt` (evento temporal futuro más próximo); el gate acota el
  TTL de su caché de usuario a `min(60s, recheckAt-now)`. [compliance.ts:~692, compliance-gate.ts:~118]

## Tests añadidos (services/__tests__/compliance.test.ts)
- HIGH-1: publicar número de versión menor tras mayor → 409 + invariante enforced ≤ current.
- HIGH-2: recompute stale no revierte current (guard por watermark de versión).
- HIGH-3: reconciler autoritativo sana watermark fantasma y recupera el publish.
- MED-5: getPendingForUser devuelve recheckAt con versión programada futura.

## Estado: PENDIENTE de verificación B/D de los fixes (en curso). Score previo 9/9 INVALIDADO hasta
## re-aprobación ≥9 y 0 HIGH. (Protocolo: score<9 o HIGH abierto = no se avanza/cierra.)

## Ronda de verificación de fixes (B/D) — un HIGH residual MÁS, también cerrado
- **D verify: 9/10** (cerró los 5; encontró y ayudó a cubrir el HIGH-3 residual con un lazy-heal).
- **B verify: 7/10 — HIGH ABIERTO.** El lazy-heal tenía un guard `currentVersionNumber > 0` que dejaba un
  bypass: una PRIMERA publicación `block_full` que crashea entre el status-flip y `recomputeDenorm`
  (currentVersionNumber=0 / latestPublishedVersion=1) NO se recomputaba → sin bloqueo hasta el próximo boot.
  Por la cadena de autoridad B→D, B manda: NO se cierra.
- **Fix**: campo nuevo `denormReflectedVersion` (mayor versión publicada que la denorm ya procesó). La
  condición de stale pasa a `latestPublishedVersion > denormReflectedVersion` → detecta el crash de primera
  publicación (reflected=0) SIN recomputar en bucle un doc cuya versión vigente expiró (reflected==latest).
  Tests añadidos: primera-publicación-stale bloquea; doc expirado no recomputa en bucle. 82/82 verde.

## Verificación final (snapshot estable) — CERRADO
Para verificar sin interferencia de un agente paralelo co-editando el worktree, se revisó un SNAPSHOT
inmutable de los 3 archivos clave.
- **B v4: 9.5/10 — HIGH del downgrade CERRADO.** Ningún write-path (recordAcceptance, publishVersion,
  recomputeDenorm, deleteDocument) degrada enforcedVersion; todos monotónicos. Invariante (c) cubre legados.
- **D v4: 9/10 — CERRADO.** Único −1: nit cosmético (reflejo en memoria del umbral en la RESPUESTA de la
  API para un doc legacy; DB siempre correcta). Es MOOT: `doc` es Mongoose HIDRATADO (findOne, no lean) →
  Mongoose aplica el default 0 en hidratación → `doc.enforcedVersion` nunca es undefined ahí. No-cambio
  justificado (añadir `?? 0` sería código muerto + ruido eslint). B no lo marcó.

### RESULTADO: B 9.5 + D 9, 0 HIGH abierto → ronda de remediación de la auto-auditoría CERRADA.
Estado: 85 tests compliance verde, tsc + eslint limpios. Total de la auto-auditoría: 5 HIGH + 3 MED reales
hallados y corregidos (versionado no-monótono por effectiveAt; recompute stale por publicación y temporal;
watermark fantasma; block_full/enforcedVersion=0 no bloqueaba; bypass de primera publicación; downgrade de
umbral en updateDocumentMetadata; cache del gate sin tenant; versión futura con user cacheado).

NOTA DE PROCESO: durante la remediación se detectó OTRA sesión (cron en paralelo) co-editando el mismo
worktree untracked. El estado combinado quedó coherente (verde), pero la verificación estable requirió
snapshots. Recomendación: para el commit/merge final, que UNA sola sesión sea la dueña, para no clobberear.

## Ronda extra (cron) — REGRESIÓN del agente paralelo detectada y re-cerrada
Brutal-honesto: tras el cierre B9.5/D9, una verificación de divergencia (diff vivo vs snapshot aprobado)
reveló que la OTRA sesión del cron había REVERTIDO mi fix del downgrade → `doc.save()` volvía a ir DESPUÉS
del reflejo local de `doc.enforcedVersion` → **HIGH de downgrade REINTRODUCIDO** en el árbol vivo (un publish
concurrente que ya subió el umbral quedaba rebajado por el save). El `$or:[{$lt},{$in:[0,null]}]` que añadió
NO lo cubre (el downgrade es vía save, no vía el updateOne).
- **Re-fix ORDER-INDEPENDENT**: `updateDocumentMetadata` ya NO asigna `enforcedVersion` en el objeto Mongoose
  (eliminada la reflexión) → `doc.save()` no puede re-persistir un umbral rebajado bajo NINGÚN orden. El raise
  es un updateOne separado monótono; se RELEE el doc para el retorno fresco.
- **Test anti-regresión determinista** añadido (services tests): spy de `findOne` simula un publish concurrente
  que sube enforcedVersion a 9 en DB entre la carga y el save; asserta que NO baja a 1. Si alguien revierte el
  fix (reflejar+re-save), la suite FALLA en vez de regresar en silencio. 86 tests compliance verde.
- Decisión de usuario: "sigo re-fijando autónomo" → mantengo el golden y re-aplico ante reversiones; el test es
  la red anti-regresión. Golden de referencia en scratchpad/snap/*.GOLDEN.

### Verificación del re-fix (snapshot corregido): B 9/10 + D 10/10 — downgrade CERRADO, 0 HIGH.
B: "save() antes del raise, sin reflexión, raise monótono $lt/$in[0,null], retorno relee; el caso publish
concurrente DB→9 ya no rebaja a 1. Sin regresión." D 10/10: "order-independent, crash-safe vía invariante (c),
retorno fresco; downgrade y retorno stale CERRADOS." (B v5 fue falso negativo: revisó un snapshot
desactualizado por un error de copia; corregido y re-verificado.) Red anti-regresión: test determinista que
FALLA si alguien revierte el fix. Estado: 86 tests compliance verde, tsc+eslint limpios.
