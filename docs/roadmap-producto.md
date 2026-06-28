# Roadmap de producto — Bifrost (Webmail 6.0)

> Visión (ver también `docs/cli-provisioning-aws.md` §0): un **Gmail open-source de bajo costo**
> para PYMEs/freelancers, self-host, "llegar e instalar y funciona". Núcleo = webmail; se expande
> hacia la suite (calendario, contactos, video, agenda, Drive).

## Modos de instalación

1. **Reemplazar Roundcube (el camino simple).** El usuario YA tiene servidor de correo → despliega
   sólo el webmail (`docker-compose.prod.yml`: Mongo+Redis+API+Web) y Bifrost habla IMAP/SMTP con su
   servidor (la cuenta se configura en el login). Reemplazo directo de Roundcube, con calendario +
   contactos que Roundcube no tiene.
2. **Full turnkey (el "no tengo nada").** El CLI `bifrost-provision` levanta TODO preconfigurado en
   AWS (docker-mailserver + Bifrost all-in-one, reusa `deploy/example-mailserver/`). Ver fase final.

**Cloud:** hoy el CLI soporta **sólo AWS**; GCP/Azure son futuro (la capa `aws/` está aislada para
permitirlo). **Storage à la carte:** correo en EBS, o S3 (bajo costo/escala). Todo personalizable.

## Roadmap de la suite (hacia Gmail)

- ✅ **Correo** (IMAP/SMTP, sync, threading, composer, adjuntos, búsqueda, snooze).
- ✅ **Calendario** (FullCalendar, eventos CRUD).
- ✅ **Contactos**.
- ✅ **Admin** (cuentas, cuotas, branding white-label, storage local/S3).
- 🔜 **Video/Meet**: botón que integra **LiveKit self-hosted** (sala por evento/llamada).
- 🔜 **Agenda/booking**: un colaborador **expone su disponibilidad** para que otros le agenden
   reuniones (estilo Calendly/appointment slots), sobre el calendario existente.
- 🔜 **Drive de empresa**: ampliar cuota S3 → **folder dedicado** servido por **CloudFront** sobre
   S3 = Drive propio de la empresa (objetos cifrados, reusa el subsistema storage).

## Versionado + auto-update (pedido del PM — "donde metemos mano después")

**Parte 1 — YA EXISTE (no reinventar):**
- `release.yml`: en push de tag `v*` → crea un **GitHub Release versionado** con notas.
- `docker.yml`: en tag `v*` → publica **imágenes Docker versionadas** (semver) a `ghcr.io` + `latest`.

**Parte 2 — POR HACER: botón "Actualizar" en el admin web.**
- AdminView gana una pestaña/sección **"Actualizaciones"**: muestra la **versión actual** (env
  `BIFROST_VERSION` horneada en build) vs la **última disponible** (consulta releases de GitHub /
  tags de ghcr), y un botón **Actualizar**.
- Al actualizar: se baja la imagen nueva y se recrea el stack (`docker compose pull && up -d`); los
  datos persisten en volúmenes (Mongo/maildir/S3). **Rollback** al tag previo si falla.
- 🔒 **DECISIÓN DE SEGURIDAD (clave):** la **API NO debe tener acceso al socket de Docker** —
  montarlo en el contenedor de la app es equivalente a root en el host (escape trivial). En su
  lugar: un **updater aislado** (un sidecar mínimo con el socket, o un `systemd` timer en el host)
  que la API señaliza (p. ej. escribe un flag/registro); el updater hace el `pull`+`up` con el
  privilegio confinado a ese componente. La API sólo **pide** la actualización; no la ejecuta.
- El canal de releases lo controla el equipo (publica versiones; los boxes de los clientes las
  consumen). Opt-in/opt-out por instalación.
