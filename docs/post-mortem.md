# Post-Mortem técnico — Webmail 6.0 (F3.0–F3.9)

Sistema multi-equipo A/B/C/D. Equipo A = Claude Code; B = Codex; C = z.ai GLM; D = Kimi.
Cada fase pasó por 1–3 rondas de QA real de B/C/D (procesos externos), cerrando sólo con
score ≥9 del equipo con autoridad primaria y sin HIGH abierto.

## Qué causó realmente el problema

La consigna del PM fue exacta: **"una cosa es lo que dicen los `.md` y otra la realidad
operativa"**. La causa raíz transversal fue un **gap sistemático entre documentación y código**:
los `.md` declaraban features "✅ listas" que en el código eran stubs, configuraciones rotas o
bugs que sólo se disparaban en runtime/produción. Ejemplos confirmados:

- **Cifrado de setup brickeaba la 1ª cuenta:** `crypto.ts` ligaba la clave como `const` al
  importar; en modo setup era `Buffer.alloc(32)` (ceros) → las credenciales se cifraban con ceros
  y al reiniciar (clave real) quedaban irrecuperables. El wizard "funcionaba" en los `.md`.
- **Índices TTL borraban datos solos** (usuarios a los 2 años, drafts a los 30 días).
- **Parseo de email = stub** que devolvía RFC822 crudo; `postal-mime` estaba en deps pero sin usar.
- **Sync IMAP = re-fetch ingenuo** `seq 1:limit` (los más viejos), sin UIDVALIDITY/incremental.
- **Envío podía duplicar** (sin transición atómica) y nunca dejaba copia en Sent.
- **IDOR multi-tenant:** lectura de emails/folders de cualquier cuenta sin verificar dueño.
- **Contrato `/api` roto** (404 en prod por mismatch nginx/Fastify), **logger apagado en prod**,
  **Dockerfiles que no buildeaban** (faltaba lockfile/tsconfig.build), rotación de refresh con race.

## Por qué no se detectó antes

- Los tests existentes (9 triviales: crypto/health/setup) **pasaban en verde** sin cubrir ningún
  flujo crítico → "suite verde" daba falsa confianza.
- Ningún **boot real** ni E2E ejercía el server contra Mongo/Redis → bugs de runtime/config
  (logger prod, `/api` prefix, cifrado de setup) invisibles a `app.inject`/unit.
- La documentación se escribió como *aspiracional* (lo planeado) y se leyó como *estado real*.

## Qué señal temprana existía / qué test faltaba

- **Señal:** deps declaradas sin un solo import (`postal-mime`, `bullmq`) — síntoma de
  "prometido, no implementado". Un `knip`/lint de deps no usadas lo habría marcado.
- **Tests faltantes:** integración de authz (A no ve B), idempotencia de envío, rotación atómica
  de token, ciclo setup→restart→login, sync incremental (expunge/flags/UIDVALIDITY). Todos
  agregados en F3.0–F3.6 (57 tests, 87% cobertura API).
- **Monitoreo faltante:** logging de producción estaba apagado; sin `/metrics` ni histograma de
  latencia. Agregados en F3.7.

## Qué evitaría repetirlo

- **Boot real + E2E como gate de CI** (no sólo unit/inject). El boot smoke ejecutado en esta
  sesión cazó lo que 11 archivos de tests no podían. Falta el E2E full-stack (TD-E2E).
- **`docker build`/`run` en CI** como gate de release (TD-DOCKER-VERIFY) — los Dockerfiles
  estaban rotos y nadie lo había corrido.
- **Tratar los `.md` como hipótesis, no como verdad**; etiquetar afirmaciones CONFIRMADO/
  PROBABLE/HIPÓTESIS (se aplicó en Fase 1).
- **Gate de cobertura** (enforced en API) + **deps sin uso** como linters de PR.

## Qué aprendió cada equipo

- **A:** la verificación por mocks/inject no sustituye el boot real; documentar deuda *en el repo*
  (no sólo en la sesión) es parte del cierre.
- **B (autoridad técnica):** atrapó los bugs más sutiles de runtime/orden (error handler tras
  rutas, bypass de `/api/metrics` por trailing slash, E11000 por filtro de upsert desalineado,
  DoS de revocación por `familyId` no firmado, Docker sin lockfile).
- **C (lógica/datos):** corrupción por fetch-miss que pisaba metadata, TOCTOU de envío, el hueco
  de TD-2 (la clave `const` no se arreglaba escribiendo `.env`).
- **D (auditoría independiente):** el bug de cifrado de setup y los TTL asesinos (ambos
  single-source, luego confirmados por A) — el mayor valor de la auditoría sin sesgo.

## Estado de cierre

Fases F3.0–F3.9 **APPROVED** por B/C/D. El producto **funciona** (boot real verificado, 57 tests,
todas las features de lectura/envío/sync/auth/observabilidad). **Production-ready: NO** hasta cerrar
los 2 gates de `deuda-tecnica.md`: **TD-E2E** (E2E full-stack) y **TD-DOCKER-VERIFY** (build/run real).
