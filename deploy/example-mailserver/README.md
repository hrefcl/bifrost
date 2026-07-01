# 📬 Montar tu servidor de correo + Webmail 6.0 (Bifrost) — paso a paso

Guía para tener **tu propio servidor de correo + webmail** funcionando, sin ser experto.
Bifrost es el webmail (reemplaza a Roundcube); el correo real lo maneja
[docker-mailserver](https://docker-mailserver.github.io/) por detrás.

> ⏱️ Tiempo: ~20 min + propagación de DNS. Necesitás: un servidor Linux con Docker, un
> dominio, y acceso a tu panel de DNS.

---

## Paso 0 — Requisitos (verificá esto primero)

```bash
docker --version          # debe responder (Docker instalado)
docker compose version    # debe responder (Compose v2)
```

✅ Si ambos responden, seguí. Si no, instalá Docker: https://docs.docker.com/engine/install/

---

## Paso 1 — Descargá esta carpeta a tu servidor

```bash
git clone https://github.com/hrefcl/bifrost.git
cd bifrost/deploy/example-mailserver
```

---

## Paso 2 — Configurá todo con UN comando (asistente)

```bash
./setup.sh
```

El asistente te va a **preguntar tu dominio** (ej. `tudominio.com`) y tu **email de admin**,
y solito:

- reemplaza `example.com` por tu dominio en el compose,
- genera los secretos (`jwt_secret`, `encryption_key`) en `./secrets/`,
- te imprime los **registros DNS exactos** que tenés que cargar.

✅ Al terminar te muestra un resumen con los próximos pasos.

> ¿Preferís a mano? Mirá el `docker-compose.yml` (está comentado). Pero el `setup.sh` lo hace por vos.

---

## Paso 3 — Cargá los DNS que te imprimió el asistente

En tu panel de DNS, creá los registros que `setup.sh` te mostró:

| Tipo        | Nombre                  | Valor (ejemplo)                     |
| ----------- | ----------------------- | ----------------------------------- |
| `A`         | `mail.tudominio.com`    | IP de tu servidor                   |
| `A`         | `webmail.tudominio.com` | IP de tu servidor                   |
| `MX`        | `tudominio.com`         | `mail.tudominio.com` (prioridad 10) |
| `TXT` (SPF) | `tudominio.com`         | `v=spf1 mx ~all`                    |

(DKIM y DMARC se generan en el Paso 5 — el asistente te recuerda.)

✅ Verificá con `dig +short MX tudominio.com` (puede tardar en propagar).

---

## Paso 4 — Levantá todo

```bash
docker compose up -d
docker compose ps        # todos deben quedar "running" / "healthy"
```

✅ Esperá ~1 min a que Traefik saque el certificado TLS.

---

## Paso 5 — Creá tu primer buzón y la clave DKIM

```bash
# Clave DKIM (mejora la entregabilidad; te imprime un registro TXT para tu DNS):
docker compose exec mailserver setup config dkim

# Tu primer buzón de correo:
docker compose exec mailserver setup email add tu-usuario@tudominio.com
```

✅ Cargá el TXT del DKIM en tu DNS.

---

## Paso 6 — Entrá al webmail 🎉

Abrí **`https://webmail.tudominio.com`** y logueá con:

- **Email**: `tu-usuario@tudominio.com`
- **Password**: el que pusiste en el Paso 5
- (Host IMAP/SMTP: ya viene apuntando a tu mailserver)

La **primera cuenta que crees es la de admin** → desde Settings vas a poder configurar el
resto (incluido **dónde se guardan los adjuntos**: mismo servidor / S3 / …) con un wizard.
Ver `../../docs/admin-config-y-providers.md`.

---

## 📹 (Opcional) Bifrost Meet — videollamadas

Videollamadas self-hosted (LiveKit) en el **mismo** servidor. **Opcional**: si no lo activás, todo lo de
arriba funciona igual. Lo más fácil es activarlo en el asistente del Paso 2:

```bash
bifrost-provision           # respondé "y" a "¿Habilitar Bifrost Meet?"
# o, sin preguntar:
bifrost-provision --enable-meet
```

Eso sube la instancia a `t4g.large` (≥8 GiB, ~+$25/mes en el mismo EC2) si elegiste un tipo del catálogo
más chico — un tipo fuera del catálogo se respeta con un aviso (asegurate ≥8 GiB). Abre 3 puertos media
(`7881/tcp`, `7882/udp`, `3478/udp`) y agrega los DNS `A meet.<dominio>` y `A turn.meet.<dominio>` → tu IP.
Un deploy provisionado arranca con Meet **ON** (no hace falta encenderlo a mano; se apaga con `PATCH
/api/admin/meet/settings {"enabled":false}` si querés). Después activás la videollamada por tipo de
evento/reserva en la agenda (toggle "Reunión con video").

¿Ya tenés un LiveKit propio o querés LiveKit **Cloud**? Apuntalo por la **API del admin** (`wsUrl` +
API key/secret + `POST /api/admin/meet/test`) — el panel visual es F3.7-frontend. Guía completa:
**[`../../docs/meet/INSTALL.md`](../../docs/meet/INSTALL.md)**.

---

## ❓ Problemas comunes

| Síntoma             | Solución                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| El cert TLS no sale | Revisá que el `A` de `webmail.` apunte a tu IP y los puertos 80/443 estén abiertos.                      |
| No puedo enviar     | Puerto 25 saliente bloqueado por tu proveedor (común en clouds) → pedí que lo abran o usá un relay SMTP. |
| Login falla         | El buzón existe? (`setup email list`). Revisá `docker compose logs mailserver`.                          |
| Meet: media no conecta | Abrí UDP `7882`/`3478` y TCP `7881`; probá desde otra red. Detalle: `docs/meet/INSTALL.md` §5/§8.      |

> Antes de producción real: desactivá `--api.insecure` de Traefik, configurá backups de
> Mongo/Redis y revisá el hardening de `docs/deuda-tecnica.md` (F4).
