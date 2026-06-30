# Bifrost (Webmail 6.0) — Estado actual

Documento vivo del estado real del producto. Reemplaza los docs de estado point-in-time anteriores
(auditoría, estado-final, continuar, pendientes-pm, roadmap, backlog, plan-consolidado, post-mortem).
La **verdad** del producto son: este doc + el [documento funcional](documento-funcional.md) + el código.
La deuda técnica viva está en [deuda-tecnica.md](deuda-tecnica.md).

## Qué es

Webmail moderno open-source, **white-label**, reemplazo de Roundcube. Cliente Gmail-like sobre
**cualquier servidor IMAP/SMTP**. Pensado para que una PYME tenga correo propio casi-gratis (un EC2
modesto + S3 para adjuntos), turnkey y con buena entregabilidad.

## Arquitectura

Monorepo pnpm (`packages/`):

- **`web`** — Vue 3 + Vite (SPA). Inbox, composer (TipTap), calendario, contactos, ajustes, admin.
- **`api`** — Fastify + Mongoose (MongoDB) + Redis + `imapflow`/`nodemailer`. Sync IMAP, envío SMTP,
  auth JWT (access + refresh con rotación), threading, storage de adjuntos (local/S3), branding.
- **`shared`** — tipos TypeScript compartidos.
- **`provisioner`** — CLI `bifrost-provision`: levanta el stack completo en AWS (CloudFormation +
  EC2 Graviton/t4g + docker-mailserver + Traefik/Let's Encrypt + SES relay). Ver
  [cli-provisioning-aws.md](cli-provisioning-aws.md).

Despliegue: imágenes Docker multi-arch (amd64+arm64) `ghcr.io/hrefcl/bifrost/{web,api}`, orquestadas
por docker-compose junto a docker-mailserver, mongo, redis y traefik.

## Funciona hoy (verificado en prod: webmail.aulion.app)

**Correo**
- Sync IMAP incremental (UIDVALIDITY, expunge, flags, anti-OOM por cursor).
- Lectura en **iframe sandbox** (aísla CSS + bloquea scripts, CSP); descarga .eml; "ver original".
- Envío SMTP con Message-ID determinista (dedupe en reintentos), firma server-side, In-Reply-To/References.
- **Conversaciones (threading)**: union-find por (Message-ID/In-Reply-To/References) scopeado a cuenta;
  backfill automático de históricos; inbox agrupado (1 fila/conversación); vista apilada de la cadena;
  colapso de citas estilo Gmail ("···").
- Auto-guardado de contactos + autocompletado en el composer; archivar/eliminar/snooze; búsqueda
  server-side; auto-refresh del buzón.
- Firmas HTML ricas con imágenes hosteadas (data:→URL, para que Gmail no las rompa).

**Admin (rol admin, verificado en backend)**
- Alta/edición de cuentas (verifica IMAP real) + cuota; **bootstrap admin** (1er usuario = admin).
- **Branding white-label** en runtime (nombre, color, logo, eslogan).
- Storage de adjuntos: local o S3 (wizard con test de conexión).
- **Versión/build desplegado** visible (detecta cache) + **auto-update Fase 1** estilo WordPress
  (avisa "hay build nuevo"; Fase 2 = aplicar de 1 click, en deuda).

**Infra / deploy turnkey en AWS**
- CLI de provisioning end-to-end probado en Graviton: deploy → webmail + Let's Encrypt → recibe →
  envía (SES relay, production access). Cifrado S3/KMS.

## QA

- `api`: ~218 tests (unit + integración con mongodb-memory-server + IMAP/SMTP fake).
- `web`: unit (vitest) + **e2e Playwright** (mailbox 14 casos, API real en memoria).
- CI: lint + typecheck + test + build + **Docker multi-arch** + smoke (arranque real del contenedor).
- Protocolo multi-equipo A/B/C/D (Claude implementa; codex/z.ai/kimi revisan) en cambios sensibles.

## Foco actual / pendiente

Ver [deuda-tecnica.md](deuda-tecnica.md). Destacados:

- **TD-PROVISION** — alta de buzón (no sólo conectar uno existente) de 1 click desde el admin.
- **TD-SELFUPDATE-FASE2** — botón "Actualizar" real (sidecar updater).
- **TD-EMAIL-SEND-EXTERNALIZE** — externalizar imágenes pegadas en el composer al enviar.
- **TD-THREADING-UI / TD-QUOTE-COLLAPSE** — refinamientos (grouping paginado, Outlook desktop,
  fallback textual de citas).

Sin HIGH abierto.
