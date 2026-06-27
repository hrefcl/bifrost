# Plan de continuación: Webmail 6.0

> ⚠️ **DESACTUALIZADO (jun 2026) — documento histórico.** El estado actual está en
> **[`estado-final.md`](estado-final.md)** (fuente de verdad: verificado contra el código, CI
> verde, 0 CVEs, 146 tests API + 9 E2E). Tras este plan se ejecutaron los PRs #11–#21 (adjuntos
> end-to-end, admin+storage local/S3 configurable, GC, cuota anti-DoS, regresión XSS, upgrade de
> deps con CVEs críticos, audit-gate en CI). **Lo único pendiente** es PR-E (provisioning de
> buzones, feature-gated). La deuda menor está en [`deuda-tecnica.md`](deuda-tecnica.md).

Este documento define el trabajo necesario para pasar del MVP funcional actual a un producto cercano a "terminado" y listo para producción. Las fases están ordenadas por impacto y dependencias.

## Estado resumen

- ✅ Monorepo pnpm con shared, api y web.
- ✅ Backend Fastify 5: auth JWT, IMAP sync, SMTP send, modelos MongoDB, encriptación AES-256-GCM, sanitización HTML, API REST.
- ✅ Frontend Vue 3: login, inbox 3-paneles, composer, contacts, calendar, settings, dark mode.
- ✅ Wizard de instalación inicial (BD, Redis, admin, email).
- ✅ Docker Compose dev/prod + Dockerfiles.
- ✅ Tests unitarios, integración y E2E básicos; cobertura baja.
- ✅ (F3.9) GitHub Actions ci/e2e/docker/release — existían y fueron corregidos (buildeaban roto).
- ✅ (F3.3/F3.8) Parseo real de emails (postal-mime, body sanitizado) + adjuntos (lista/descarga) + vista detalle. Calendario mensual y búsqueda full-text → siguen pendientes (post-MVP).
- ✅ (F3.0–F3.6) Tests de integración de auth/drafts/send/emails/sync/setup (57 tests, 87% cobertura API). Contacts/calendar CRUD → cubiertos por authz, sin tests dedicados (deuda).

---

## Fase 1 — CI/CD y empaquetado (fundamental antes de escalar)

### 1.1 GitHub Actions
- [ ] `ci.yml`: ejecutar `typecheck`, `lint`, `test:unit`, `test:coverage`, `build` en PRs y `main`.
- [ ] `e2e.yml`: ejecutar Playwright en CI con MongoDB y Redis como services.
- [ ] `docker.yml`: build multi-arquitectura (`linux/amd64`, `linux/arm64`) y push a GitHub Container Registry.
- [ ] `release.yml`: versionado con `changesets` o `semantic-release`, generar changelog y artefactos.

### 1.2 Gestión de releases
- [ ] Elegir estrategia de versionado (Changesets recomendado para monorepo).
- [ ] Crear `.changeset/config.json` y scripts `version` / `release`.
- [ ] Etiquetar imágenes Docker con `git describe` o versión de changeset.

### 1.3 Calidad de código
- [ ] Subir cobertura mínima al 70 % (establecer thresholds en Vitest).
- [ ] Añadir `knip` para detectar imports/exports muertos.
- [ ] Añadir `tsc --noEmit` como paso obligatorio en CI.
- [ ] Pre-commit hooks (`simple-git-hooks` + `lint-staged`) ya configurados; verificar que corren.

---

## Fase 2 — Backend robusto y completo

### 2.1 Parseo y renderizado de emails
- [ ] Integrar `postal-mime` para parsear cuerpos `text/plain`, `text/html` y adjuntos.
- [ ] Servir body sanitizado (`sanitize-html`) con caché en Redis (TTL 1h).
- [ ] Endpoint de attachments: `/emails/:id/attachments/:attachmentId`.
- [ ] Vista previa (`preview`) generada desde texto plano o primeros KB del HTML.

### 2.2 Sincronización IMAP profesional
- [ ] Sincronización incremental con `UIDVALIDITY` + `HIGHESTMODSEQ`.
- [ ] Guardar estado de sync por folder (`uidNext`, `modseq`, `lastUid`).
- [ ] Worker/queue para sync en background (BullMQ sobre Redis).
- [ ] WebSocket/SSE para notificar nuevos emails al frontend.

### 2.3 Cola de envío
- [ ] Encolar envíos de SMTP en BullMQ con reintentos.
- [ ] Guardar copia en carpeta Sent tras enviar exitoso.
- [ ] Soporte de reply/forward con headers `In-Reply-To` y `References`.

### 2.4 Tests de integración
- [ ] Auth: registro/login/refresh/logout.
- [ ] Drafts: CRUD + envío.
- [ ] Emails: listar, sync folder, obtener body.
- [ ] Contacts/Calendar: CRUD.
- [ ] Mock de `imapflow` y `nodemailer` para tests sin servidor real.

---

## Fase 3 — Frontend productivo

### 3.1 Bandeja de entrada completa
- [ ] Vista de detalle de email con body renderizado, adjuntos y acciones (responder, reenviar, archivar, eliminar).
- [ ] Selección múltiple y acciones masivas.
- [ ] Búsqueda full-text por asunto/remitente/contenido.
- [ ] Filtros rápidos (no leídos, con adjuntos, hoy, etc.).
- [ ] Infinite scroll o paginación mejorada.

### 3.2 Calendario
- [ ] Vista mensual/semanal/diaria con `vue-cal` o implementación propia.
- [ ] Crear/editar/eliminar eventos desde el calendario.
- [ ] Importar invites `.ics` recibidas por email.

### 3.3 Composer avanzado
- [ ] Editor HTML enriquecido (TipTap o Quill).
- [ ] Adjuntos drag & drop.
- [ ] Autocompletado de contactos.
- [ ] Autoguardado de drafts cada 30 s.

### 3.4 UX y accesibilidad
- [ ] Manejo global de errores y estados de carga.
- [ ] Toast notifications.
- [ ] Responsive para tablets/móviles.
- [ ] A11y: roles, focus traps, atajos de teclado.

---

## Fase 4 — Seguridad, observabilidad y producción

### 4.1 Seguridad
- [ ] Rotación de refresh tokens con family IDs (ya implementado; verificar casos edge).
- [ ] Rate limiting por IP más estricto en auth y setup.
- [ ] CSP headers y validación de orígenes de imágenes en HTML.
- [ ] Validación de certificados IMAP/SMTP configurable.
- [ ] Hash seguro de passwords de BD/Redis (no en texto plano en `.env`).

### 4.2 Observabilidad
- [ ] Logging estructurado con `pino` y correlación de request IDs.
- [ ] Métricas básicas con `/metrics` (Prometheus).
- [ ] Health checks detallados para IMAP/SMTP.

### 4.3 Producción
- [ ] Guía de despliegue en `docs/deployment.md`.
- [ ] Scripts de backup/restore de MongoDB y Redis.
- [ ] Variables de entorno documentadas y ejemplos para distintos hosts.
- [ ] SSL/TLS con Traefik o certbot en Docker prod.

---

## Fase 5 — Funcionalidades avanzadas (post-MVP)

- [ ] Soporte multi-cuenta en UI.
- [ ] CalDAV/CardDAV sync.
- [ ] Firmas configurables por cuenta.
- [ ] Reglas/filtros de correo.
- [ ] Modo offline con Service Worker.
- [ ] Internacionalización (i18n).

---

## Próximo sprint recomendado

Si se dispone de un sprint corto, priorizar:

1. **CI/CD**: crear `.github/workflows/ci.yml` + `docker.yml`.
2. **Tests de integración de auth y drafts** para subir cobertura y confianza.
3. **Parseo real de emails** con `postal-mime` y endpoint de body sanitizado.
4. **Vista detalle de email** en el frontend.

Estas cuatro tareas dejan el proyecto con un flujo completo usable y confiable.
