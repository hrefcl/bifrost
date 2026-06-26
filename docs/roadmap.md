# Webmail 6.0 — Roadmap

> Objetivo: MVP funcional de Fase 1 según documento funcional.  
> Fecha inicio: 2026-06-24  
> Duración estimada: 6-7 sprints de trabajo concentrado.

## Fase 1 — MVP (Objetivo actual)

### Sprint 0: Fundamentos (Semana 1)
- Monorepo pnpm workspaces (`packages/web`, `packages/api`, `packages/shared`).
- TypeScript strict base, ESLint flat config, Prettier, git hooks.
- Docker Compose dev: MongoDB 7, Redis 7, SeaweedFS, Nginx, api, web.
- Variables de entorno validadas en startup.
- Utilidad AES-256-GCM + verificación de claves.
- Modelos Mongoose base: `users`, `accounts`, `folders`, `emails`, `drafts`.
- Health checks `/health/live` y `/health/ready`.

**Criterio de terminado:** `docker compose up` levanta todos los servicios healthy; `pnpm lint` y `pnpm typecheck` pasan en todos los packages.

### Sprint 1: Autenticación e IMAP Bridge (Semana 2)
- Registro/login validando credenciales contra IMAP transitorio.
- JWT access 15min + refresh token opaco en Redis + cookie HttpOnly.
- Middleware de autenticación; rotación y detección de reúso.
- Pool de conexiones imapflow por cuenta.
- Sincronización inicial de headers con `BODY.PEEK[HEADER.FIELDS]`.
- Índices ESR en MongoDB.

**Criterio de terminado:** Login real contra servidor IMAP de prueba funciona; sync descarga headers y los guarda en MongoDB; tests de integración de auth pasan.

### Sprint 2: API Email y Frontend Core (Semana 3)
- API: listar emails, ver detalle, obtener body sanitizado, actualizar flags.
- API carpetas: listar, crear, eliminar.
- Frontend Vue 3: login, layout tres paneles, sidebar, lista de emails.
- Tailwind + tokens de color + dark mode.
- Integración con API (Pinia stores: auth, folders, emails).

**Criterio de terminado:** Usuario autenticado ve lista de emails real desde MongoDB; puede seleccionar y leer body sanitizado; dark mode funciona.

### Sprint 3: Compose, Drafts y Adjuntos (Semana 4)
- Tiptap 2 integrado en Vue.
- Auto-save drafts cada 10s en MongoDB.
- Adjuntos: upload a SeaweedFS, preview, límite 25MB.
- Envío SMTP con Nodemailer; copia en Sent vía IMAP APPEND.
- Reply/Reply-all/Forward con cita.

**Criterio de terminado:** Se puede redactar, auto-guardar, adjuntar y enviar un email real (validado con Ethereal.email); draft se elimina tras envío.

### Sprint 4: Calendario y Contactos (Semana 5)
- Servicio CalDAV con tsdav: listar calendarios, CRUD eventos.
- FullCalendar Vue 3 con vistas día/semana/mes.
- Parseo de adjuntos `.ics` en emails con preview aceptar/declinar.
- Modelo y API básica de contactos + autocomplete.

**Criterio de terminado:** Eventos se sincronizan con servidor CalDAV de prueba; invitaciones .ics muestran preview; autocomplete de contactos funciona en composer.

### Sprint 5: Polish y QA (Semana 6)
- Threading JWZ en lista y reading pane.
- Búsqueda local MongoDB (texto + remitente) + fallback IMAP SEARCH.
- Keyboard shortcuts Gmail-style.
- Tests unitarios e integración con cobertura ≥ 85%.
- E2E Playwright para flujos críticos.

**Criterio de terminado:** Build, lint, type-check y tests pasan; Lighthouse performance > 90; 0 bugs críticos.

### Sprint 6: Infraestructura y Release (Semana 7)
- Dockerfiles multi-stage prod para api y web.
- Docker Compose producción con Nginx, SSL, resource limits.
- GitHub Actions CI/CD (lint, test, build, E2E).
- Documentación de despliegue y operación.

**Criterio de terminado:** `docker compose -f docker-compose.yml -f docker-compose.prod.yml up` despliega stack completo; CI verde en `main`.

## Fase 2 — Polish (Post-MVP)

- Búsqueda avanzada con faceting (fecha, remitente, adjuntos).
- CardDAV sync completo e importación/exportación vCard.
- Notificaciones push WebSocket + Service Worker.
- Drag-and-drop de emails entre carpetas.
- Firmas configurables por cuenta.
- Importación/exportación .mbox/.eml.

## Fase 3 — Enterprise (Futuro)

- OAuth2 nativo Gmail/Microsoft.
- Cliente JMAP (RFC 8620/8621).
- S/MIME básico y verificación DKIM.
- Panel de administración.
- Sharding MongoDB por `userId` y clustering API.
- Métricas y alertas Prometheus/Grafana completas.
