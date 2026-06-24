# Webmail 6.0 — Documento Funcional y Arquitectura Técnica

## 1. Resumen Ejecutivo (~800 palabras)
### 1.1 Propósito del Documento
#### 1.1.1 Documento como especificación completa para reemplazo transparente de Roundcube con webmail moderno tipo Gmail
#### 1.1.2 Audiencia: agentes swarm de desarrollo, arquitectos técnicos, y equipos de implementación
### 1.2 Visión de Webmail 6.0
#### 1.2.1 Webmail moderno, rápido y seguro — filosofía "headers primero, body bajo demanda"
#### 1.2.2 Diferenciadores clave: UI tipo Gmail, calendario integrado, multi-cuenta IMAP/SMTP, auto-save, seguridad de capas
### 1.3 Alcance y Fases
#### 1.3.1 MVP Fase 1: email core + contactos + adjuntos + búsqueda
#### 1.3.2 Fase 2: threading + búsqueda avanzada + keyboard shortcuts + notificaciones push
#### 1.3.3 Fase 3: calendario CalDAV completo + filtros + PGP + panel admin

## 2. Investigación Comparativa y Justificación (~2500 palabras, 2 tablas)
### 2.1 Estado del Arte: Webmail Open Source 2026
#### 2.1.1 Roundcube: dominante pero con problemas estructurales de seguridad (15+ CVEs en H1 2026, XSS persistente)
#### 2.1.2 SnappyMail: alternativa rápida pero con riesgo de mantenimiento (gap de commits, bus factor)
#### 2.1.3 Cypht: innovador con JMAP nativo pero UI limitada
#### 2.1.4 Bulwark: next-gen TypeScript/JMAP pero acoplado a Stalwart
### 2.2 Análisis de Brechas
#### 2.2.1 Ninguna solución existente combina: UI moderna tipo Gmail + stack TypeScript + IMAP/JMAP dual + calendario integrado + despliegue Docker simple (tabla comparativa)
#### 2.2.2 Oportunidad de mercado: reemplazo directo de Roundcube para hosting providers y self-hosters
### 2.3 Lecciones Aprendidas de los Competidores
#### 2.3.1 De Roundcube: sanitización HTML debe ser prioridad arquitectónica, no afterthought
#### 2.3.2 De SnappyMail: rendimiento importa — Lighthouse 99% es posible y diferenciador
#### 2.3.3 De Bulwark: JMAP es el futuro, pero IMAP sigue siendo necesario para compatibilidad universal

## 3. Stack Tecnológico Completo (~3000 palabras, 3 tablas)
### 3.1 Frontend
#### 3.1.1 Framework: Vue 3.4 + Composition API + `<script setup>` — reactivad fina, rendimiento superior
#### 3.1.2 Lenguaje: TypeScript 5 strict — consistencia frontend/backend, mantenibilidad
#### 3.1.3 Bundler: Vite 5 — HMR rápido, build optimizada, ecosistema maduro
#### 3.1.4 Estado: Pinia 2 — stores modulares por dominio (auth, emails, folders, drafts, settings), 35-45% menos boilerplate que Vuex
#### 3.1.5 Routing: Vue Router 4 con lazy loading de módulos
#### 3.1.6 Estilos: Tailwind CSS 3 + Headless UI — diseño rápido, accesible, responsive
#### 3.1.7 Editor: Tiptap 2 (ProseMirror) — HTML WYSIWYG extensible, sanitizable con DOMPurify
#### 3.1.8 Componentes UI: three-pane layout Gmail-style, virtual scrolling (VueUse useVirtualList), drag-and-drop (vue-draggable-plus)
### 3.2 Backend
#### 3.2.1 Runtime: Node.js 20 LTS — async/await nativo, librerías IMAP maduras
#### 3.2.2 Framework: Fastify 4 — 2-3x más rápido que Express (~14,460 vs ~6,150 req/s), schema validation integrado, plugin architecture con encapsulación nativa
#### 3.2.3 IMAP: imapflow — única librería moderna activamente mantenida para Node.js, promise-based, TypeScript, soporte CONDSTORE/QRESYNC/IDLE/OAuth2
#### 3.2.4 SMTP: Nodemailer — estándar de facto, soporte pooling, STARTTLS, OAuth2
#### 3.2.5 MIME: PostalMime — reemplazo moderno de mailparser, cero dependencias, TypeScript, browser+Node.js
#### 3.2.6 HTML Sanitize: DOMPurify server-side (isomorphic-dompurify) + sanitize-html para bulk processing
#### 3.2.7 CSS Inline: Juice — compatibilidad con clientes de email antiguos
### 3.3 Base de Datos y Caché
#### 3.3.1 Metadatos + índice búsqueda: MongoDB 7 — denormalización, compound indexes ESR, Atlas Search para full-text
#### 3.3.2 Caché sesiones/estado/notificaciones: Redis 7 — TTL automático, pub/sub para WebSocket notifications, BullMQ 5 para background jobs
#### 3.3.3 Object Storage: SeaweedFS (alternativa a MinIO, Apache 2.0) para adjuntos — alto I/O, compatible S3
### 3.4 Infraestructura
#### 3.4.1 Proxy/SSL: Nginx reverse proxy — WebSocket proxying, rate limiting por capas, SSL termination
#### 3.4.2 Contenedores: Docker + Docker Compose (dev y producción)
#### 3.4.3 Monitoreo: Prometheus + Grafana (fase 2) — métricas Node.js con prom-client

## 4. Arquitectura de Sistema (~3000 palabras, 1 diagrama Mermaid, 2 tablas)
### 4.1 Diagrama de Arquitectura
#### 4.1.1 Vue 3 SPA → Nginx (RP) → Fastify API → MongoDB/Redis/SeaweedFS/IMAP Externo (diagrama de componentes)
### 4.2 Flujos de Datos Principales
#### 4.2.1 Login: validación IMAP → JWT + credenciales encriptadas AES-256-GCM en MongoDB → conexión IMAP en pool
#### 4.2.2 Sincronización inicial: FETCH headers (BODY.PEEK) de INBOX → indexado en MongoDB con compound indexes
#### 4.2.3 Navegación: frontend pide lista → backend sirve desde MongoDB (rápido) → fallback a IMAP si no cacheado
#### 4.2.4 Lectura email: backend trae body de IMAP → sanitiza HTML con DOMPurify → marca \Seen en IMAP → envía al cliente
#### 4.2.5 Envío: toma draft → inyecta firma → envía vía SMTP (Nodemailer) → guarda copia en Sent (IMAP) → borra draft local
#### 4.2.6 Auto-save draft: guarda en MongoDB cada 10 segundos con debounce → al enviar, mueve de MongoDB a SMTP + IMAP
### 4.3 Notificaciones en Tiempo Real
#### 4.3.1 IMAP IDLE por cuenta activa → Redis pub/sub → WebSocket (Socket.IO) → frontend → badge de unread actualizado
#### 4.3.2 Fallback a polling cada 30-60 segundos para servidores sin IDLE
### 4.4 Abstracción de Protocolo: IMAP + JMAP
#### 4.4.1 Capa de abstracción que unifica IMAP (legacy) y JMAP (moderno) bajo API interna común
#### 4.4.2 JMAP para servidores compatibles (Stalwart, Cyrus, Fastmail) — 3-5x sync más rápido, 80-90% menos bandwidth
#### 4.4.3 IMAP como fallback universal con todas las extensiones (CONDSTORE, QRESYNC, IDLE, COMPRESS)

## 5. Modelo de Datos MongoDB (~2500 palabras, 7+ schemas TypeScript)
### 5.1 users — configuración global
#### 5.1.1 Schema: email principal, displayName, timezone, theme (light/dark), signature, createdAt/updatedAt
### 5.2 accounts — multi-cuenta IMAP/SMTP
#### 5.2.1 Schema: userId, email, name, provider (custom/gmail/outlook), IMAP config (host, port, secure, username, password AES-256-GCM), SMTP config, isDefault, syncEnabled, lastSyncAt
### 5.3 folders — cache local de estructura IMAP
#### 5.3.1 Schema: accountId, imapName, displayName, parentId, delimiter, totalMessages, unseenMessages, uidValidity, uidNext, flags
### 5.4 emails — cache de headers + preview
#### 5.4.1 Schema: accountId, folderId, uid, messageId, headers (subject, from, to, cc, bcc, date), flags IMAP (\Seen, \Answered), textPreview (500 chars), hasAttachments, threadId, htmlBody sanitizado, textBody, size
#### 5.4.2 Compound indexes: {folderId: 1, date: -1, uid: 1} para queries de inbox
### 5.5 attachments — metadata
#### 5.5.1 Schema: emailId, filename, contentType, size, storageKey (SeaweedFS path), checksum SHA-256, isInline, contentId
### 5.6 contacts — agenda básica
#### 5.6.1 Schema: userId, name, email, company, phone, tags[]
### 5.7 drafts — auto-save local
#### 5.7.1 Schema: userId, accountId, to/cc/bcc[], subject, htmlBody, textBody, attachments[], inReplyTo, references, lastSavedAt
### 5.8 events — calendario
#### 5.8.1 Schema: userId, accountId, uid (CalDAV), calendarId, summary, description, location, startDate, endDate, timezone, rrule, attendees[], status, etag, href (CalDAV URL)

## 6. API REST Fastify (~2500 palabras, tablas de endpoints)
### 6.1 Auth
#### 6.1.1 POST /api/auth/login — valida credenciales IMAP, genera JWT (access 15min + refresh 7 días en Redis/HttpOnly cookie)
#### 6.1.2 POST /api/auth/logout — invalida sesión en Redis
#### 6.1.3 GET /api/auth/me — datos usuario actual
#### 6.1.4 POST /api/auth/refresh — rotación de refresh tokens con token families
### 6.2 Accounts
#### 6.2.1 CRUD cuentas IMAP/SMTP + POST /api/accounts/:id/sync para sincronización manual forzada
### 6.3 Emails
#### 6.3.1 GET /api/emails — lista con query params (folder, account, search, page, limit)
#### 6.3.2 GET /api/emails/:id — detalle headers + preview
#### 6.3.3 GET /api/emails/:id/body — body completo HTML sanitizado + texto plano
#### 6.3.4 GET /api/emails/:id/raw — raw MIME (.eml download)
#### 6.3.5 POST /api/emails/:id/flags — actualizar flags (leído, destacado, spam)
#### 6.3.6 DELETE /api/emails/:id — mover a Trash / eliminar permanente
### 6.4 Folders
#### 6.4.1 CRUD carpetas IMAP — listar, crear, eliminar
### 6.5 Compose / Send
#### 6.5.1 POST /api/drafts — guardar borrador (auto-save)
#### 6.5.2 GET /api/drafts — listar borradores
#### 6.5.3 POST /api/send — enviar email (toma draft o body directo)
### 6.6 Attachments
#### 6.6.1 POST /api/attachments/upload → SeaweedFS → retorna storageKey
#### 6.6.2 GET /api/attachments/:id — descargar
#### 6.6.3 GET /api/attachments/:id/preview — preview inline imagen/PDF
### 6.7 Contacts
#### 6.7.1 CRUD contactos
### 6.8 Calendar (CalDAV)
#### 6.8.1 GET /api/calendars — listar calendarios de cuenta CalDAV
#### 6.8.2 GET /api/calendars/:id/events — eventos con rango de fechas
#### 6.8.3 POST /api/calendars/:id/events — crear evento (sync a CalDAV)
#### 6.8.4 PUT /api/calendars/:id/events/:eventId — editar evento
#### 6.8.5 DELETE /api/calendars/:id/events/:eventId — eliminar evento
#### 6.8.6 GET /api/calendars/:id/events/:eventId/ics — descargar .ics

## 7. Diseño UI/UX: Gmail-Style (~2500 palabras, 1 tabla)
### 7.1 Layout de Tres Paneles
#### 7.1.1 Sidebar izquierda: cuentas, carpetas (INBOX, Sent, Drafts, Trash, Junk, custom), calendario, contactos
#### 7.1.2 Panel central: lista de emails con virtual scrolling, selección múltiple, badges (unread, starred, attachments)
#### 7.1.3 Panel derecha: reading pane con HTML sanitizado, modo texto plano toggle, headers expandibles
### 7.2 Vista de Conversaciones (Threading)
#### 7.2.1 Algoritmo JWZ para agrupar emails por hilo: Message-ID + In-Reply-To + References
#### 7.2.2 Gmail threadId nativo para cuentas Gmail, JWZ para IMAP genérico
#### 7.2.3 Vista apilada: mensajes colapsados con el más reciente expandido, peeks para cada mensaje
### 7.3 Composer
#### 7.3.1 Tiptap 2 editor WYSIWYG con toolbar de formato
#### 7.3.2 Auto-save cada 10 segundos con indicador visual
#### 7.3.3 Adjuntos: drag-and-drop + click-to-browse, preview thumbnails, límite 25MB
#### 7.3.4 Reply/Reply-all/Forward con quote del email original
#### 7.3.5 Firmas configurables por cuenta
### 7.4 Responsive Design
#### 7.4.1 Desktop (769px+): tres paneles completos
#### 7.4.2 Tablet (481-768px): sidebar colapsable, lista + reading pane
#### 7.4.3 Mobile (<480px): vista apilada (lista → lectura → compose), navegación por stack
### 7.5 Keyboard Shortcuts (Gmail-style)
#### 7.5.1 Navegación: g+i (inbox), g+s (sent), g+d (drafts), g+c (calendar)
#### 7.5.2 Acciones: c (compose), r (reply), f (forward), / (search), e (archive), # (delete)

## 8. Módulo de Calendario (~2000 palabras, 1 tabla)
### 8.1 Integración CalDAV
#### 8.1.1 Librería tsdav (TypeScript) para comunicación CalDAV/CardDAV — ~113K descargas/semana, OAuth2 integrado
#### 8.1.2 ical.js (Mozilla) para parsing/generación iCalendar RFC 5545
#### 8.1.3 Auto-discovery: DNS SRV + well-known URLs + PROPFIND
### 8.2 UI de Calendario
#### 8.2.1 FullCalendar (@fullcalendar/vue3) — estándar de facto con vistas día/semana/mes/agenda
#### 8.2.2 Integración con email: detectar adjuntos .ics, parsear evento, mostrar preview con botones Aceptar/Declinar/Tal vez
#### 8.2.3 Envío de invitaciones: composer con opción "Agregar a calendario", generar .ics, enviar como multipart/alternative
### 8.3 Sincronización
#### 8.3.1 Sync bidireccional: ETags + sync-tokens + manejo de conflictos (resolución a nivel de campo)
#### 8.3.2 Manejo de RRULE (eventos recurrentes) con ical.js
#### 8.3.3 Timezones: IANA timezones, conversión a UTC para almacenamiento

## 9. Seguridad: Defensa en Capas (~2500 palabras, 2 tablas)
### 9.1 Matriz de Amenazas y Mitigaciones
#### 9.1.1 XSS vía email HTML: DOMPurify server-side + CSP estricto + sandboxed iframe para preview
#### 9.1.2 CSS malicioso: Juice para inline + whitelist de propiedades CSS permitidas
#### 9.1.3 Adjuntos maliciosos: restricción MIME types, verificación magic numbers, ClamAV opcional
#### 9.1.4 Credenciales IMAP: AES-256-GCM en reposo con mongoose-aes-encryption, nunca loguear
#### 9.1.5 Sesiones: JWT corto (15min) + refresh token en Redis con HttpOnly/Secure/SameSite cookies
#### 9.1.6 Rate limiting: Redis sliding window (ZSET) — 99.997% precisión, <2ms latency
#### 9.1.7 IMAP injection: validación estricta de inputs, stripping CRLF, uso de imapflow (no concatenación manual)
#### 9.1.8 Subida de archivos: límite 25MB, verificación magic numbers, no confiar en extensiones
### 9.2 Arquitectura de Autenticación BFF
#### 9.2.1 Access token: 15-30 min, almacenado en memoria (Pinia state), enviado en header Authorization
#### 9.2.2 Refresh token: 7-14 días, almacenado server-side en Redis, entregado vía HTTP-only cookie
#### 9.2.3 Rotación de tokens: cada refresh emite nuevo token, invalida anterior, detección de reúso con token families
### 9.3 HTML Sanitization Pipeline
#### 9.3.1 Servidor: DOMPurify con jsdom (no happy-dom) para renderizado seguro
#### 9.3.2 Configuración: allowedTags (p, br, strong, em, a, ul, ol, li, img, blockquote), allowedAttributes (href, src, alt, title), forbidden (script, style, iframe, event handlers)
#### 9.3.3 Cliente: CSP estricto con nonces, Trusted Types en Chromium
### 9.4 Encriptación de Datos Sensibles
#### 9.4.1 Campos encriptados: IMAP/SMTP passwords, tokens OAuth2, email bodies opcional
#### 9.4.2 Plugin mongoose-aes-encryption con AES-256-GCM: key de 32 bytes, IV único de 12-16 bytes por operación
#### 9.4.3 Key management: variables de entorno en desarrollo, KMS/secrets manager en producción

## 10. Sincronización IMAP ↔ MongoDB (~2000 palabras, 1 tabla, 1 diagrama Mermaid)
### 10.1 Estrategia: Headers Primero, Body Bajo Demanda
#### 10.1.1 FETCH BODY.PEEK[HEADER.FIELDS] para lista de emails — rápido, no marca \Seen
#### 10.1.2 Body completo solo cuando usuario abre el email → cache en Redis 1 hora
#### 10.1.3 Preview texto: primeros 500 chars de texto plano para búsqueda y listado
### 10.2 Sincronización Inicial
#### 10.2.1 Al agregar cuenta: FETCH headers de todas las carpetas → indexado en MongoDB con batching
#### 10.2.2 Progreso reportado al frontend vía WebSocket
### 10.3 Sincronización Incremental
#### 10.3.1 IMAP IDLE (push) para servidores que lo soportan — notificaciones <1s
#### 10.3.2 Polling cada 30-60s como fallback
#### 10.3.3 CONDSTORE/QRESYNC para sync eficiente: solo UIDs nuevos y flags cambiados
### 10.4 Connection Pooling
#### 10.4.1 Singleton pattern con timeout 5 minutos, reconexión automática con backoff exponencial
#### 10.4.2 Límites por provider: Gmail 250 conexiones, Outlook 20 conexiones
#### 10.4.3 Mailbox locking de imapflow para acceso concurrente seguro
### 10.5 Búsqueda
#### 10.5.1 Búsqueda local sobre MongoDB: índices compound en subject, from, to, textPreview
#### 10.5.2 Atlas Search para full-text avanzado (fuzzy, autocomplete)
#### 10.5.3 Fallback a IMAP SEARCH si no encuentra resultados locales

## 11. Guía de Implementación Paso a Paso (~3000 palabras, tablas de comandos)
### 11.1 Fase 1: Setup Inicial (Semana 1)
#### 11.1.1 Estructura de monorepo: pnpm workspaces — packages/web (Vue), packages/api (Fastify), packages/shared (tipos comunes)
#### 11.1.2 Docker Compose base: MongoDB 7, Redis 7, SeaweedFS, Nginx
#### 11.1.3 TypeScript strict en ambos proyectos, path aliases, ESLint + Prettier
### 11.2 Fase 2: Backend Core (Semanas 2-3)
#### 11.2.1 Fastify setup: plugins, schema validation, manejo de errores, health checks (/health/live, /health/ready)
#### 11.2.2 Mongoose schemas: users, accounts, folders, emails, attachments, contacts, drafts
#### 11.2.3 Auth: JWT + refresh tokens en Redis, encriptación AES-256-GCM de credenciales IMAP
#### 11.2.4 IMAP Bridge Service: imapflow connection pool, sincronización headers, fetching de bodies
#### 11.2.5 SMTP Service: Nodemailer con pooling, envío de emails, guardado copia en Sent
### 11.3 Fase 3: Frontend Core (Semanas 3-4)
#### 11.3.1 Vue 3 + Vite + Tailwind + Pinia setup
#### 11.3.2 Layout tres paneles: sidebar, email list con virtual scroll, reading pane
#### 11.3.3 Pantalla login multi-cuenta
#### 11.3.4 Lista de emails con paginación virtual, selección múltiple, drag-and-drop
#### 11.3.5 Vista lectura email: HTML sanitizado, modo texto plano, headers
### 11.4 Fase 4: Compose y Drafts (Semana 4)
#### 11.4.1 Editor Tiptap 2 con toolbar, sanitización output
#### 11.4.2 Auto-save cada 10 segundos (debounce) → POST /api/drafts
#### 11.4.3 Adjuntos: drag-drop upload a SeaweedFS, preview thumbnails
#### 11.4.4 Reply/Forward con quote del original
### 11.5 Fase 5: Calendario (Semana 5)
#### 11.5.1 Integración tsdav: auto-discovery, listar calendarios, CRUD eventos
#### 11.5.2 UI FullCalendar: vistas día/semana/mes, navegación
#### 11.5.3 Integración email ↔ calendario: detección .ics, preview invitación, aceptar/declinar
### 11.6 Fase 6: Polish y Testing (Semanas 6-7)
#### 11.6.1 Dark mode completo (Tailwind dark:)
#### 11.6.2 Keyboard shortcuts Gmail-style
#### 11.6.3 Threading de conversaciones (algoritmo JWZ)
#### 11.6.4 Búsqueda avanzada (Atlas Search)
#### 11.6.5 Docker Compose producción listo

## 12. Testing Estratégico (~2500 palabras, 2 tablas)
### 12.1 Testing Unitario (Vitest)
#### 12.1.1 Frontend: componentes Vue 3 con mount(), composables con withSetup helper
#### 12.1.2 Backend: servicios con inyección de dependencias, mocks de imapflow y Nodemailer
#### 12.1.3 Sanitización: suite de regresión XSS con payloads conocidos (OWASP, CVE-2025-15599, CVE-2026-35539)
### 12.2 Testing de Integración (Fastify.inject + Testcontainers)
#### 12.2.1 API endpoints: fastify.inject (2-5x más rápido que supertest)
#### 12.2.2 MongoDB: Testcontainers (@testcontainers/mongodb) para transactions y change streams
#### 12.2.3 Redis: @testcontainers/redis con flushDb() entre tests
#### 12.2.4 IMAP: Mokapi o Ethereal.email para testing de fetch/parse real
### 12.3 Testing E2E (Playwright)
#### 12.3.1 Flujos críticos: login, compose, enviar, recibir, adjuntos, búsqueda
#### 12.3.2 Email real: MailSlurp o Ethereal.email para verificar envío real
#### 12.3.3 Calendario: crear evento, sync CalDAV, verificar en servidor
### 12.4 Cobertura y CI
#### 12.4.1 Vitest coverage con @vitest/coverage-v8 — thresholds 85% líneas, 80% funciones
#### 12.4.2 GitHub Action: vitest-coverage-report-action para PR comments con comparación vs main
#### 12.4.3 Testing pyramid: 70% unit / 20% integration / 10% E2E

## 13. CI/CD y DevOps (~2000 palabras, 2 archivos YAML, 1 tabla)
### 13.1 GitHub Actions Pipeline
#### 13.1.1 Workflow CI: install → lint → unit tests → integration tests → build → coverage report → PR comment
#### 13.1.2 Workflow E2E: build → start Docker Compose → Playwright tests → artifacts (screenshots, videos)
#### 13.1.3 Workflow CD: build Docker images → push a registry → deploy (Docker Compose pull & up)
### 13.2 Docker Configuration
#### 13.2.1 Multi-stage Dockerfile frontend: Node build → Nginx Alpine serve
#### 13.2.2 Multi-stage Dockerfile backend: Node build → Node slim production
#### 13.2.3 Docker Compose desarrollo: hot reload, volúmenes montados
#### 13.2.4 Docker Compose producción: health checks, restart policies, resource limits, named volumes
### 13.3 Nginx Configuration
#### 13.3.1 Reverse proxy: API /api → Fastify, WebSocket /ws → Socket.IO, SPA fallback → index.html
#### 13.3.2 Rate limiting: login 1r/s, API 30r/s, general 10r/s
#### 13.3.3 SSL con Let's Encrypt (ACME nativo desde Nginx Aug 2025)
### 13.4 Monitoreo (Fase 2)
#### 13.4.1 Prometheus: prom-client con métricas HTTP latency, IMAP connections, email throughput
#### 13.4.2 Grafana: dashboard ID 11159 (Node.js) + paneles custom para webmail
#### 13.4.3 Health checks: /health/live (liveness), /health/ready (readiness — checkea MongoDB, Redis, IMAP)

## 14. Roadmap y Notas para el Agent Swarm (~1500 palabras, 1 tabla)
### 14.1 Roadmap Detallado
#### 14.1.1 Fase 1 MVP (Semanas 1-7): auth + multi-cuenta + sync IMAP + inbox + compose + adjuntos + calendario + Docker
#### 14.1.2 Fase 2 Polish (Semanas 8-11): threading + búsqueda avanzada + keyboard shortcuts + dark mode + drag-drop + notificaciones push
#### 14.1.3 Fase 3 Enterprise (Semanas 12-16): CalDAV completo + filtros/rules + PGP + admin panel + métricas
### 14.2 División de Agentes
#### 14.2.1 Agente Frontend: Vue 3 + componentes UI (Inbox, Composer, Calendar, Settings)
#### 14.2.2 Agente Backend API: Fastify + endpoints REST + validación
#### 14.2.3 Agente IMAP Bridge: imapflow + sincronización + pooling + IDLE
#### 14.2.4 Agente CalDAV: tsdav + ical.js + FullCalendar integration
#### 14.2.5 Agente Data: Mongoose schemas + índices + queries + encriptación
#### 14.2.6 Agente DevOps: Docker + Nginx + GitHub Actions + monitoreo
#### 14.2.7 Agente QA: tests unitarios + integración + E2E + cobertura
### 14.3 Reglas de Oro para el Swarm
#### 14.3.1 Composition API obligatorio (no Options API), TypeScript strict: true
#### 14.3.2 Sanitización HTML siempre server-side antes de enviar al cliente
#### 14.3.3 Credenciales IMAP nunca en logs, siempre encriptadas en reposo
#### 14.3.4 Todo código testeado: mínimo 85% cobertura de líneas
#### 14.3.5 Documentar cada endpoint API con schema Fastify

# References
## webmail60.agent.outline.md
- **Type**: Report outline
- **Description**: Outline del documento funcional Webmail 6.0
- **Path**: /mnt/agents/output/webmail60.agent.outline.md

## Research Files
- **Type**: Research artifacts
- **Description**: 8 wide exploration files + cross-verification + insights
- **Path**: /mnt/agents/output/research/webmail_wide01.md through webmail_wide08.md, webmail_cross_verification.md, webmail_insight.md
