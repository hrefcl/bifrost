# Webmail 6.0 — Backlog Técnico Modular

> Estado: Fase 1 — MVP  
> Última actualización: 2026-06-24

## Leyenda

- **Prioridad:** P0 = bloqueante, P1 = necesario para MVP, P2 = deseable, P3 = futuro.
- **Complejidad:** L (baja), M (media), H (alta), VH (muy alta).
- **Estado actual:** `no-iniciado` | `en-progreso` | `terminado` | `verificado`.

---

## Módulo 1 — Core (Autenticación, Sesiones, Seguridad)

| ID | Tarea | Descripción | Dependencias | Riesgos | Prioridad | Complejidad | Estado |
|----|-------|-------------|--------------|---------|-----------|-------------|--------|
| C-01 | Monorepo pnpm workspaces | Estructura `packages/web`, `packages/api`, `packages/shared`; scripts globales; TypeScript base strict. | — | Configuración inicial de paths | P0 | M | no-iniciado |
| C-02 | Docker Compose dev | MongoDB 7, Redis 7, SeaweedFS, Nginx, servicios `api`/`web` con hot reload. | C-01 | Versiones de imágenes, secretos | P0 | M | no-iniciado |
| C-03 | ESLint + Prettier + git hooks | Flat config ESLint, reglas Vue/TS, formateo automático. | C-01 | Conflictos entre plugins | P0 | L | no-iniciado |
| C-04 | Variables de entorno y validación | `MONGODB_URI`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `SEAWEEDFS_ENDPOINT`; validación en startup. | C-02 | Secretos hardcodeados | P0 | L | no-iniciado |
| C-05 | Utilidad de encriptación AES-256-GCM | Cifrar/descifrar credenciales IMAP/SMTP; verificación de clave 32 bytes. | C-04 | Errores de IV reutilizado | P0 | M | no-iniciado |
| C-06 | Auth BFF: registro/login | Validar credenciales IMAP transitorio; crear usuario/cuenta; emitir JWT 15min. | C-05, I-01 | Conectividad IMAP real | P0 | H | no-iniciado |
| C-07 | Refresh token en Redis + cookie HttpOnly | Token opaco, TTL 7 días, rotación, detección de reúso, revocación en logout. | C-06 | Seguridad de cookies | P0 | H | no-iniciado |
| C-08 | Middleware de autenticación JWT | Proteger rutas API; extraer `userId`/`accountId`. | C-06 | — | P0 | M | no-iniciado |
| C-09 | Rate limiting Redis sliding window | Límites por endpoint (login, refresh, sync, send, upload, list). | C-02 | Falsos positivos | P1 | M | no-iniciado |
| C-10 | Helmet + CSP headers | `X-Frame-Options`, `X-Content-Type-Options`, HSTS, CSP estricto. | — | Bloqueo de recursos legítimos | P1 | M | no-iniciado |
| C-11 | CORS configurado | Origen frontend, credenciales, headers permitidos. | — | — | P0 | L | no-iniciado |

## Módulo 2 — Email (IMAP, SMTP, Sincronización, Threading)

| ID | Tarea | Descripción | Dependencias | Riesgos | Prioridad | Complejidad | Estado |
|----|-------|-------------|--------------|---------|-----------|-------------|--------|
| I-01 | Conexión IMAP con imapflow | Pool singleton por cuenta, reconexión, backoff, mailbox locking. | C-04 | Límites de conexiones por provider | P0 | H | no-iniciado |
| I-02 | Modelo `accounts` + encriptación | Schema Mongoose con IMAP/SMTP config, credenciales cifradas, estado sync. | C-05 | — | P0 | M | no-iniciado |
| I-03 | Modelo `folders` | Cache local de jerarquía IMAP, `uidValidity`, contadores. | I-02 | — | P0 | M | no-iniciado |
| I-04 | Modelo `emails` | Headers, preview, flags, índice ESR `{accountId, folderId, date, uid}`. | I-03 | Diseño de índices | P0 | H | no-iniciado |
| I-05 | Sincronización inicial de headers | `BODY.PEEK[HEADER.FIELDS]` por lotes, parseo PostalMime, batch insert MongoDB. | I-01, I-04 | Rendimiento en buzones grandes | P0 | H | no-iniciado |
| I-06 | Sincronización incremental | IMAP IDLE, polling fallback, CONDSTORE/QRESYNC si disponible. | I-05 | Compatibilidad servidor | P1 | H | no-iniciado |
| I-07 | Progreso de sync vía WebSocket | Publicar eventos Redis → Socket.IO → frontend. | I-05 | — | P2 | M | no-iniciado |
| I-08 | API listado de emails | `GET /api/accounts/:id/emails` con paginación, folder, sort, query. | I-04 | — | P0 | M | no-iniciado |
| I-09 | API detalle/body de email | `GET .../body` con cache Redis; fetch IMAP on-demand; sanitizar HTML. | I-01, I-04 | XSS si sanitización falla | P0 | H | no-iniciado |
| I-10 | API flags y mover/eliminar | `PATCH flags`, `POST move/copy`, `DELETE` con trash/expunge. | I-01, I-04 | — | P1 | M | no-iniciado |
| I-11 | API carpetas | CRUD carpetas IMAP + listado local. | I-03 | — | P1 | M | no-iniciado |
| I-12 | Envío SMTP + copia Sent | Nodemailer pool, STARTTLS, IMAP APPEND, eliminar draft. | I-01, D-03 | Reputación/entregabilidad | P0 | H | no-iniciado |
| I-13 | Threading JWZ | Agrupar por `Message-ID`/`In-Reply-To`/`References`; fallback por asunto. | I-04 | Casos borde | P2 | H | no-iniciado |
| I-14 | Búsqueda local MongoDB | Índices de texto en `subject`, `from`, `textPreview`; fallback IMAP SEARCH. | I-04 | Rendimiento | P1 | H | no-iniciado |

## Módulo 3 — Compose y Drafts

| ID | Tarea | Descripción | Dependencias | Riesgos | Prioridad | Complejidad | Estado |
|----|-------|-------------|--------------|---------|-----------|-------------|--------|
| D-01 | Modelo `drafts` | Schema con to/cc/bcc, asunto, HTML/texto, adjuntos, TTL 30 días. | C-04 | — | P0 | M | no-iniciado |
| D-02 | Editor Tiptap 2 en Vue | Toolbar básica, links, listas, citas, placeholder. | C-01 | Sanitización output | P0 | H | no-iniciado |
| D-03 | API drafts CRUD + auto-save | `POST/PATCH /api/drafts` cada 10s; debounce. | D-01 | Concurrencia | P0 | M | no-iniciado |
| D-04 | Adjuntos en composer | Drag-drop, upload SeaweedFS, preview thumbnails, límite 25MB. | C-02, D-03 | Validación MIME/magic | P1 | H | no-iniciado |
| D-05 | Reply/Reply-all/Forward | Poblar destinatarios/asunto, cita del original, adjuntos opcionales. | D-02, I-09 | Headers thread | P1 | H | no-iniciado |
| D-06 | Firmas por cuenta | Tiptap inline, inserción automática, desactivable. | D-02 | — | P2 | M | no-iniciado |

## Módulo 4 — Calendario

| ID | Tarea | Descripción | Dependencias | Riesgos | Prioridad | Complejidad | Estado |
|----|-------|-------------|--------------|---------|-----------|-------------|--------|
| CA-01 | Modelo `events` | Schema CalDAV, UID, RRULE, excepciones, attendees, timezone. | C-04 | Timezones | P1 | H | no-iniciado |
| CA-02 | Servicio CalDAV con tsdav | Auto-discovery, listar calendarios, CRUD eventos, sync ETags. | C-04, I-02 | Compatibilidad servidores | P1 | H | no-iniciado |
| CA-03 | UI FullCalendar en Vue | Vistas día/semana/mes, navegación, crear/editar eventos. | C-01 | — | P1 | H | no-iniciado |
| CA-04 | Parseo de .ics en emails | Detectar adjuntos ICS, preview invitación, aceptar/declinar/tentativo. | I-09, CA-02 | iTip replies | P1 | H | no-iniciado |
| CA-05 | Expansión RRULE | Generar instancias 90 días con `ical.js`/node-ical. | CA-01 | Rendimiento | P2 | VH | no-iniciado |

## Módulo 5 — Contactos

| ID | Tarea | Descripción | Dependencias | Riesgos | Prioridad | Complejidad | Estado |
|----|-------|-------------|--------------|---------|-----------|-------------|--------|
| CO-01 | Modelo `contacts` | Nombre, emails, teléfonos, organización, `usageCount`, `isFrequent`. | C-04 | — | P2 | M | no-iniciado |
| CO-02 | API contactos CRUD + autocomplete | `GET /api/contacts/autocomplete` sub-50ms con cache Redis. | CO-01 | — | P2 | M | no-iniciado |
| CO-03 | Integración composer | Sugerencias al escribir destinatarios. | D-02, CO-02 | — | P2 | M | no-iniciado |

## Módulo 6 — UI/UX

| ID | Tarea | Descripción | Dependencias | Riesgos | Prioridad | Complejidad | Estado |
|----|-------|-------------|--------------|---------|-----------|-------------|--------|
| U-01 | Configuración Tailwind + tokens | Colores `accent`, `surface`, `text-*`, modo oscuro. | C-01 | Consistencia visual | P0 | M | no-iniciado |
| U-02 | Pantalla login Vue | Multi-cuenta, credenciales, error/loading. | C-06 | — | P0 | M | no-iniciado |
| U-03 | Layout tres paneles | Sidebar, lista, reading pane; responsive; colapsable. | U-01 | — | P0 | H | no-iniciado |
| U-04 | Lista de emails virtual scroll | `@vueuse/core` useVirtualList, selección múltiple, estrellas. | U-03 | Accesibilidad | P0 | H | no-iniciado |
| U-05 | Reading pane | HTML sanitizado en iframe sandbox, toggle texto plano, headers, adjuntos. | I-09, U-03 | XSS | P0 | H | no-iniciado |
| U-06 | Composer UI flotante | Ventana estilo Gmail, minimizar, múltiples composers. | D-02, U-03 | — | P0 | H | no-iniciado |
| U-07 | Settings view | General, cuentas, apariencia, seguridad, filtros. | U-01 | — | P1 | M | no-iniciado |
| U-08 | Keyboard shortcuts | `g+i`, `c`, `r`, `e`, `#`, `/`, etc. | U-03 | Conflictos con inputs | P2 | H | no-iniciado |
| U-09 | Notificaciones/toasts | `vue-sonner`, confirmaciones, errores de sync. | — | — | P2 | L | no-iniciado |

## Módulo 7 — Infraestructura y DevOps

| ID | Tarea | Descripción | Dependencias | Riesgos | Prioridad | Complejidad | Estado |
|----|-------|-------------|--------------|---------|-----------|-------------|--------|
| INF-01 | Dockerfile API multi-stage | Build + producción con usuario no-root. | C-01 | Tamaño imagen | P0 | M | no-iniciado |
| INF-02 | Dockerfile web multi-stage | Build Vite + Nginx Alpine. | C-01 | — | P0 | M | no-iniciado |
| INF-03 | Nginx reverse proxy | `/api`, `/ws`, SPA fallback, rate limiting, headers seguridad. | C-02 | — | P0 | M | no-iniciado |
| INF-04 | Docker Compose prod | Resource limits, restart, health checks, Prometheus/Grafana opcional. | INF-01, INF-02 | — | P2 | M | no-iniciado |
| INF-05 | GitHub Actions CI | Lint, typecheck, tests unit/integration, build. | C-03 | Tiempos de ejecución | P1 | H | no-iniciado |
| INF-06 | GitHub Actions E2E | Build compose, Playwright tests, artifacts. | INF-05 | Flakiness | P2 | H | no-iniciado |
| INF-07 | Métricas Prometheus | `prom-client`, latencia HTTP, conexiones IMAP, emails synced. | INF-01 | — | P3 | M | no-iniciado |

## Módulo 8 — QA y Testing

| ID | Tarea | Descripción | Dependencias | Riesgos | Prioridad | Complejidad | Estado |
|----|-------|-------------|--------------|---------|-----------|-------------|--------|
| Q-01 | Tests unitarios API | Auth, encriptación, sanitización, servicios con mocks. | C-05 | — | P0 | M | no-iniciado |
| Q-02 | Tests unitarios web | Componentes Vue, composables, stores. | U-01 | happy-dom/jsdom | P0 | M | no-iniciado |
| Q-03 | Tests integración API | `fastify.inject` + Testcontainers MongoDB/Redis. | C-02 | Tiempo de ejecución | P0 | H | no-iniciado |
| Q-04 | Tests IMAP/SMTP reales | Ethereal.email: enviar y recuperar email. | I-01, I-12 | Conectividad externa | P1 | M | no-iniciado |
| Q-05 | Suite regresión XSS | Payloads conocidos contra sanitizador. | I-09 | — | P0 | M | no-iniciado |
| Q-06 | E2E Playwright críticos | Login, compose, enviar, recibir, adjuntos, calendario. | U-02, U-06 | Flakiness | P1 | H | no-iniciado |
| Q-07 | Cobertura ≥ 85% | Thresholds Vitest v8. | Q-01, Q-02 | — | P1 | M | no-iniciado |
