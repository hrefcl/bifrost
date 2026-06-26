# Webmail 6.0 — Informe de Auditoría de Estado Actual

> Fecha de auditoría: 2026-06-24  
> Alcance: documento funcional, maquetas existentes y código presente en el repositorio.

## 1. Resumen Ejecutivo

El repositorio `/Users/devuno/Href/webemail/bifrost` contiene un **documento funcional y arquitectónico muy detallado** para Webmail 6.0, junto con una **maqueta visual interactiva en React** que ilustra el diseño de interfaz. Sin embargo, **no existe un proyecto de software ejecutable** (backend, frontend productivo, infraestructura Docker, tests ni configuración de build). El estado actual es, por tanto, **prototipo de diseño + especificación completa**.

La principal divergencia detectada es tecnológica: las maquetas están construidas en **React con JSX en el navegador (Babel standalone)**, mientras que el documento funcional prescribe **Vue 3 + TypeScript + Vite**. La construcción real debe seguir el stack del documento, aprovechando las maquetas como referencia visual/pixel y como fuente de datos de ejemplo.

## 2. Elementos Auditados

| Elemento | Ubicación | Estado |
|----------|-----------|--------|
| Documento funcional completo | `docs/webmail60_for_conversion.md`, `docs/webmail60_sec01.md` … `sec14.md` | ✅ Completo |
| Investigación de soporte | `docs/research/webmail_wide01.md` … `wide08.md`, `webmail_cross_verification.md`, `webmail_insight.md` | ✅ Completa |
| Maqueta visual interactiva | `maqueta/Webmail 6.0/` (HTML + JSX) | ✅ Funcional como prototipo |
| Maqueta standalone adicional | `maqueta/Bifrost 6.0 (standalone).html`, `maqueta/bifrost.html` | ⚠️ No auditadas en profundidad (parecen variantes) |
| README / ADRs / CI / Config | Raíz del repo | ❌ No existen |
| Backend (Fastify, MongoDB, Redis, IMAP) | — | ❌ No existe |
| Frontend productivo (Vue 3 + TS + Vite) | — | ❌ No existe |
| Tests (unitarios/integración/E2E) | — | ❌ No existen |
| Docker / Compose / Nginx | — | ❌ No existe |

## 3. Funcionalidades Implementadas

Solo la maqueta React proporciona funcionalidades de interfaz con datos simulados (`WM_ACCOUNTS`, `WM_FOLDERS`, `WM_THREADS`, etc.):

- Pantalla de login multi-cuenta (selección de cuenta + contraseña).
- Layout de tres paneles: sidebar, lista de conversaciones, reading pane.
- Sidebar con carpetas estándar (Recibidos, Destacados, Enviados, Borradores, Archivo, Spam, Papelera), etiquetas y mini-barra de almacenamiento.
- Lista de emails con: selección, destacado, archivar, eliminar, categorías (Principal/Novedades/Promociones) y badge de no leídos.
- Reading pane con vista de conversación, adjuntos, responder/responder a todos/reenviar.
- Composer emergente con campos Para/Cc/Asunto, cuerpo y auto-guardado simulado.
- Vista de calendario semanal con eventos y modal de detalle.
- Vista de ajustes con secciones: General, Cuentas, Apariencia, Seguridad, Filtros.
- Cambio de tema claro/oscuro y selector de color de acento.

Toda la lógica es local en memoria; no hay persistencia ni comunicación con servidores reales.

## 4. Funcionalidades Parcialmente Implementadas

Ninguna. La maqueta es puramente visual/estática. No hay backend, base de datos, autenticación real, sincronización IMAP, envío SMTP, almacenamiento de adjuntos, etc.

## 5. Funcionalidades No Implementadas (respecto al MVP Fase 1)

### Core
- Registro/login real contra servidor IMAP.
- JWT de acceso (15 min) + refresh token en cookie HttpOnly + Redis.
- Encriptación AES-256-GCM de credenciales IMAP/SMTP.
- Gestión multi-cuenta (CRUD, test de conectividad, sincronización forzada).
- Rate limiting con Redis sliding window.

### Email
- Sincronización IMAP de headers (`BODY.PEEK[HEADER.FIELDS]`).
- Modelos Mongoose: `users`, `accounts`, `folders`, `emails`, `attachments`, `drafts`.
- Índices compuestos ESR en MongoDB.
- Obtención de cuerpo bajo demanda + cache Redis 1h.
- Sanitización HTML server-side (DOMPurify/sanitize-html).
- API REST de emails, carpetas, flags, mover/copiar/eliminar.
- Envío SMTP con Nodemailer y copia en Sent vía IMAP APPEND.
- Auto-guardado de borradores cada 10s en MongoDB.
- Adjuntos: upload a SeaweedFS, preview, límite 25MB.

### Calendario
- Integración CalDAV con `tsdav`.
- CRUD de eventos y sincronización bidireccional.
- Parseo de `.ics` con `ical.js`.
- UI FullCalendar día/semana/mes.

### Contactos
- Agenda básica y autocompletado.

### Infraestructura
- Monorepo pnpm workspaces.
- Docker Compose con MongoDB, Redis, SeaweedFS, Nginx.
- Multi-stage Dockerfiles para `api` y `web`.
- CI/CD con GitHub Actions.
- Nginx reverse proxy + SSL.

### QA
- Tests unitarios (Vitest).
- Tests de integración (Fastify.inject + Testcontainers).
- Tests E2E (Playwright).
- Cobertura ≥ 85%.

## 6. Divergencias Detectadas

| # | Documento Funcional | Maquetas / Código | Clasificación | Acción Requerida |
|---|---------------------|-------------------|---------------|------------------|
| 1 | Vue 3 + TypeScript + Vite | React + JSX en navegador (Babel standalone) | Decisión pendiente / Error de implementación de la maqueta | Reescribir frontend en Vue 3 + TS + Vite, usando maquetas como referencia visual. |
| 2 | Fastify + Node.js 20 | No hay backend | Funcionalidad faltante | Construir backend desde cero. |
| 3 | MongoDB + Redis + SeaweedFS | Datos en memoria (`WM_*`) | Funcionalidad faltante | Implementar modelos, caché y object storage. |
| 4 | `lucide-vue-next` para iconos | Iconos SVG inline manual (`_ICON_PATHS`) | Funcionalidad faltante | Reemplazar por librería de iconos Vue. |
| 5 | Pinia para estado | `useState` de React | Funcionalidad faltante | Migrar a stores Pinia. |
| 6 | Tiptap 2 editor WYSIWYG | `<textarea>` plano | Funcionalidad faltante | Integrar Tiptap en Vue. |
| 7 | Virtual scrolling (`@vueuse/core`) | Renderizado completo de lista | Funcionalidad faltante | Implementar virtual scroll. |
| 8 | Tailwind CSS + Headless UI | Estilos inline (`style={{...}}`) | Funcionalidad faltante | Migrar a Tailwind + componentes accesibles. |
| 9 | Tests ≥ 85% cobertura | Sin tests | Funcionalidad faltante | Crear suite de tests. |
| 10 | Docker Compose + CI/CD | Sin infraestructura | Funcionalidad faltante | Crear Dockerfiles, compose y workflows. |
| 11 | Documento menciona Fastify 4 / imapflow v1 / Mongoose 8 | No aplicable (aún no hay código) | Decisión pendiente | Usar versiones compatibles con Node 22 LTS: Fastify 5, imapflow ^1, Mongoose 8, etc. |

## 7. Riesgos Inmediatos

1. **Stack desactualizado en el documento.** El documento cita versiones de 2024-2026 (Fastify 4, Vue 3.4, Node 20). Para un proyecto nuevo en 2026 conviene usar Node 22 LTS, Fastify 5, Mongoose 8 y Vitest 2/3. Se documentarán las versiones reales elegidas.
2. **Maqueta como "verdad" visual.** Las maquetas usan estilos inline y CSS variables custom (`--accent`, `--surface`, etc.). Deben traducirse a tokens de Tailwind sin perder la estética.
3. **Complejidad del calendario.** CalDAV + RRULE + timezones es la funcionalidad de mayor riesgo técnico; se recomienda dejarla para el final del MVP o iterar en fases.
4. **Seguridad.** El manejo de credenciales IMAP y la sanitización HTML son críticos; cualquier error es bloqueante.
5. **Testing de protocolos reales.** Requiere servidores IMAP/SMTP de prueba (Ethereal.email, MailSlurp, contenedores Dovecot) para validar envío/recepción.

## 8. Decisiones Arquitectónicas Iniciales

1. **Frontend:** Vue 3.4+ con `<script setup>`, TypeScript strict, Vite 5/6, Pinia, Vue Router 4, Tailwind CSS 3.4, Headless UI, `@vueuse/core`, `lucide-vue-next`, Tiptap 2, FullCalendar Vue 3.
2. **Backend:** Fastify 5, Node 22 LTS, Mongoose 8, imapflow, Nodemailer, PostalMime, sanitize-html + DOMPurify, BullMQ 5, ioredis.
3. **Base de datos / caché:** MongoDB 7, Redis 7.
4. **Object storage:** SeaweedFS 3.x (Apache 2.0).
5. **Infraestructura:** Docker Compose multi-service, Nginx reverse proxy, GitHub Actions CI/CD.
6. **Testing:** Vitest (unit + integration), Testcontainers, Playwright E2E.
7. **Autenticación:** BFF pattern — JWT en memoria (15 min), refresh token opaco en Redis + cookie HttpOnly Secure SameSite=Strict.
8. **Encriptación:** AES-256-GCM a nivel de campo para credenciales IMAP/SMTP/OAuth2.
9. **Sincronización:** headers-first, body-on-demand; `BODY.PEEK` para no marcar \Seen; cache Redis 1h para cuerpos.

## 9. Recomendación de Construcción

Dado el estado actual, se propone un enfoque incremental:

1. **Sprint 0 — Fundamentos:** monorepo, Docker Compose, TypeScript strict, ESLint, Prettier, modelos Mongoose, auth JWT/refresh.
2. **Sprint 1 — IMAP Bridge:** conexión IMAP, sincronización de headers, API de carpetas/emails, body-on-demand con cache.
3. **Sprint 2 — Frontend Core:** login, layout tres paneles, lista de emails, reading pane, dark mode.
4. **Sprint 3 — Compose + Drafts + Adjuntos:** Tiptap, auto-save, upload SeaweedFS, envío SMTP.
5. **Sprint 4 — Calendario + Contactos:** CalDAV, FullCalendar, agenda básica.
6. **Sprint 5 — QA + Infra:** tests unitarios/integración/E2E, CI/CD, Nginx, hardening.

Cada sprint debe terminar con **build, lint, type-check y tests verificados** antes de pasar al siguiente.
