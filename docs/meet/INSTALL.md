# Bifrost Meet — instalación, operación y troubleshooting

Videollamadas self-hosted (LiveKit) integradas al webmail, la agenda y el correo. **Opcional y
modular**: la instalación funciona IGUAL con Meet apagado. Mismo EC2 (no hay un 2º servidor), costo
mínimo, sin SaaS. Esta guía es para el **operador** que instala/mantiene el servidor.

> Documentación relacionada: diseño técnico en [`DESIGN.md`](./DESIGN.md), bitácora de revisión en
> [`REVIEW-LOG.md`](./REVIEW-LOG.md), y la **Fase 0 funcional por pantalla** en
> [`functional/`](./functional/00-index.md) (qué ve y hace el usuario en cada pantalla).

---

## 1. Las dos formas de tener Meet

Meet puede usar **tres** backends de LiveKit; se elige por dónde apuntás las credenciales:

| Modo | Cuándo | Cómo se configura |
|---|---|---|
| **Bundled (self-hosted en el mismo EC2)** | Default turnkey; un solo servidor, costo mínimo | El provisioner lo arma (este doc, §2) |
| **LiveKit externo self-hosted** | Ya tenés un LiveKit propio en otra máquina | Credenciales en el admin → URL wss + API key/secret |
| **LiveKit Cloud (pago)** | Querés SFU gestionado / escala | Credenciales en el admin → URL `wss://<proj>.livekit.cloud` + key/secret |

El **modo es automático por la URL**: si el admin carga credenciales en la DB, mandan sobre el bundled;
para volver al bundled hay que resetear los campos explícitamente (secret vacío **y** `wsUrl` al del
bundled — ver el PATCH exacto en §6; borrar sólo el secret no alcanza).

> **Estado (2026-06):** el bundled (§2) y el backend de credenciales externas/Cloud (API + prueba de
> conexión, §6) están operativos. El **panel visual** de configuración del servidor en el admin llega con
> F3.7-frontend; hasta entonces la config externa/Cloud se hace por la API del admin (§6).

---

## 2. Activar el bundled al instalar (provisioner)

```bash
bifrost-provision
# … respondé el wizard …
# ¿Habilitar Bifrost Meet (videollamadas LiveKit self-hosted)?  → y
```

o sin preguntar (no-interactivo): `bifrost-provision --enable-meet`.

Qué hace al activarlo:

- **Piso de instancia**: para un tipo del **catálogo** con <8 GiB (p.ej. `t4g.medium`) sube a `t4g.large`
  — LiveKit + mailserver + Mongo + ClamAV no entran en 4 GiB. Un tipo **fuera del catálogo** se respeta
  con un aviso (el wizard no puede verificar su RAM → asegurate vos de que tenga ≥8 GiB). En el **mismo**
  EC2 (~**+$25/mes** respecto del piso de 4 GiB).
- **CloudFormation**: agrega un **2º Security Group** con sólo los puertos media (§3) — el SG base queda
  intacto. Crea los registros **A `meet.<dominio>`** y **A `turn.meet.<dominio>`** → la Elastic IP (si
  gestionás el DNS desde el stack; si no, te los imprime para cargarlos a mano).
- **Cloud-init** (`.env` del compose): `MEET_PROVISIONED=1`, `COMPOSE_PROFILES=meet`, genera las claves
  LiveKit (`openssl`, en el host), `LIVEKIT_WS_URL=wss://meet.<dom>`, `LIVEKIT_API_URL=http://livekit:7880`,
  `MEET_PUBLIC_BASE_URL=https://webmail.<dom>`. Fija `rtc.node_ip` = Elastic IP (ICE determinista) en `livekit.yaml`.
- **Sin Meet**: nada de lo anterior aplica; el stack es byte-idéntico al de sólo-correo.

**Interruptor maestro — ya viene encendido.** Un deploy **provisionado** (`MEET_PROVISIONED=1`, que setea
el provisioner con `--enable-meet`) arranca con Meet **ON** por default: no hace falta ningún paso extra.
Si querés **apagarlo** (o volver a encenderlo), o si hiciste un deploy manual sin `MEET_PROVISIONED`, usá:

```http
PATCH /api/admin/meet/settings   { "enabled": true }   # o false para apagar
```

(autenticado como admin; el **toggle visual** llega con F3.7-frontend). Un `enabled` explícito en la DB
manda sobre el default provisionado. Luego activás la videollamada **por tipo de evento / reserva** en la
agenda (toggle "Reunión con video" en Scheduling) → el link se hornea en la reserva, el email y el ICS.
Probá una reunión (§7).

---

## 3. Puertos (firewall / Security Group)

Meet abre **sólo 3 puertos** sobre los del correo/web. **Nunca** un rango `1-65535`.

| Puerto | Protocolo | Para qué |
|---|---|---|
| 7881 | TCP | ICE/TCP (fallback cuando UDP está bloqueado) |
| 7882 | UDP | Mux de media (single-port, todo el RTP/RTCP) |
| 3478 | UDP | TURN/STUN embebido (no usamos coturn) |

- El **7880** (API de signaling de LiveKit) **nunca** se publica: sólo lo alcanza Traefik por la red
  docker interna. El signaling del navegador entra por **`wss://meet.<dom>` (443/TLS)**, que Traefik
  rutea a `livekit:7880`.
- Si gestionás tu propio firewall (no el SG del stack), abrí esos 3 puertos a `0.0.0.0/0`.

---

## 4. Costos

Meet **no agrega un servidor**: corre en el mismo EC2. El costo es el **piso de RAM**:

| Escenario | Instancia | ~USD/mes |
|---|---|---|
| Sólo correo (mínimo) | t4g.medium (4 GiB) | ~$24 |
| Correo + Meet (piso) | t4g.large (8 GiB) | ~$49 |

Es decir, **~+$25/mes** por habilitar Meet (la diferencia medium→large). Si ya estabas en `t4g.large`
por otras razones, Meet agrega **$0** de instancia. Tráfico de media: sale por el data-transfer normal
de EC2 (las llamadas son P2P-vía-SFU en tu propio servidor, sin egress a un tercero).

---

## 5. Limitaciones y roadmap (honesto)

- **Redes que SÓLO abren 443/TCP** (algunas corporativas restrictivas): la media necesita UDP (7882/3478)
  o TCP/7881. Hoy **no** abrimos TURN/TLS sobre 443 → un invitado externo detrás de un firewall que sólo
  deja salir 443/TCP podría **no** conectar la media (el signaling sí entra por wss/443). **Es la 1ª
  limitación conocida**; el fast-follow del roadmap es TURN/TLS:443 (SNI passthrough L4 / 2ª IP). El wss
  por 443 es **sólo signaling**, no media.
- **Single-node**: un LiveKit por servidor (sin Redis, sin escala horizontal). Suficiente para una PYME;
  para más concurrencia, apuntá a LiveKit externo/Cloud (§6).
- **Grabación**: **no implementada** todavía (roadmap). El backend nunca otorga el grant `roomRecord` y
  `recordingPolicy` es siempre `disabled`; el flag `autoRecord` se persiste pero **aún no tiene efecto**
  (queda para cuando se integre LiveKit Egress / Cloud). Hoy **ninguna** llamada se graba.

---

## 6. Apuntar a LiveKit externo o Cloud

Sin reprovisionar, el admin puede apuntar Meet a **otro LiveKit** (self-hosted externo o **Cloud**)
cargando las credenciales en la DB. El **panel visual** llega con F3.7-frontend; hoy se hace por la API
del admin (autenticado como admin):

```http
PATCH /api/admin/meet/settings
{ "enabled": true,
  "wsUrl": "wss://<proj>.livekit.cloud",   # el signaling wss va en wsUrl (NO en livekitApiUrl)
  "livekitApiKey": "<API_KEY>",
  "livekitApiSecret": "<API_SECRET>" }      # el secret se guarda CIFRADO; nunca vuelve por la API
# Opcional: "livekitApiUrl": "https://<proj>.livekit.cloud"  # la API REST de LiveKit: http/https
#           (si se omite, se DERIVA del wsUrl). Región/máx-participantes/resolución también opcionales.

POST  /api/admin/meet/test                  # prueba de conexión ANTES de confiar en las credenciales
```

> **Importante — `wsUrl` vs `livekitApiUrl`.** El `wss://` (signaling del navegador) va en **`wsUrl`**.
> `livekitApiUrl` es la API REST server-side y la API la valida como **http/https sin userinfo** (mandar
> un `wss://` ahí devuelve 400). Si omitís `livekitApiUrl`, se deriva del `wsUrl` (`wss→https`).

A partir de guardar, Meet usa ese servidor (la DB manda sobre el env del bundled).

Notas:
- El **secret se guarda CIFRADO** (AES-GCM con `ENCRYPTION_KEY`) y **nunca** vuelve por la API (el GET
  admin sólo muestra `hasApiSecret: true`).
- Para **volver al bundled**, un solo PATCH con los tres campos explícitos:
  `{ "livekitApiSecret": "", "wsUrl": "wss://meet.<dom>", "livekitApiUrl": "" }`. Borrar el secret hace
  caer las **credenciales** al LiveKit local por env; el `wsUrl` hay que **fijarlo explícito** al del
  bundled. Mandar `wsUrl: ""` **NO** vuelve al env: `getStoredMeetSettings` sólo cae a `LIVEKIT_WS_URL`
  si el campo es null/ausente, no si es `""` (usa `??`). Un `wsUrl` vacío queda persistido y deja
  `meetEnabled` en `false` (exige un `wsUrl` no vacío) → Meet deja de funcionar aunque `enabled` siga en
  `true`. `livekitApiUrl: ""` sí se limpia (se re-deriva del `wsUrl`). Si no reseteás el `wsUrl`, el SPA
  seguiría apuntando al servidor anterior con credenciales del bundled.
- **Grabación**: `autoRecord` se persiste pero **no tiene efecto todavía** (ver §5) — no esperes grabaciones.
- El **CSP del SPA** ya permite `wss:` porque el servidor fue provisionado con `MEET_PROVISIONED=1` →
  podés cambiar de servidor sin redeploy.

---

## 7. Checklist de prueba manual (post-deploy)

1. **DNS**: `dig +short meet.<dom>` y `dig +short turn.meet.<dom>` devuelven la Elastic IP.
2. **TLS**: `https://meet.<dom>/` responde (426/200 — el cert ACME puede tardar unos minutos).
3. **Contenedor**: `docker compose ps livekit` → `Up`. `docker compose logs livekit` sin errores de config.
4. **Toggle**: en una reserva/evento con Meet, el link `https://webmail.<dom>/meet/<slug>` abre la sala.
5. **Cámara/mic**: entran y publican; el audio local no hace eco (no se reproduce a sí mismo).
6. **Compartir pantalla**: el botón comparte y el resto la ve en spotlight.
7. **Invitado externo**: desde OTRA red (4G del teléfono) se une por el link público y conecta media.
8. **Cierre**: al cancelar la reserva, el link deja de admitir nuevos ingresos (404 de la sala).

Si 7 falla pero 1-6 andan: probablemente la red del invitado sólo deja 443/TCP (ver §5).

---

## 8. Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| El link abre pero la media no conecta | UDP 7882/3478 cerrados, o red del invitado sólo-443 | Verificá el SG/firewall (§3); probá desde otra red; ver §5 |
| `wss://meet.<dom>` no abre (426 nunca) | Traefik no rutea / cert ACME pendiente / livekit caído | `docker compose logs traefik livekit`; esperá el cert |
| Error CSP `connect-src wss:` en consola del navegador | `MEET_PROVISIONED` no seteado | Confirmá `MEET_PROVISIONED=1` en `.env` y recreá `web`+`api` |
| Al unirse: 503 / "servicio no disponible" | Credenciales LiveKit rotas (ver `livekitSource`) | La API del admin (`GET /api/admin/meet/settings`) muestra `livekitSource: error`: reingresá key/secret (§6/§9) |
| ICE falla / clientes ven IP privada | `node_ip` mal o EIP no asociada | Verificá `rtc.node_ip` = Elastic IP en `livekit.yaml` |
| LiveKit no arranca | `livekit.yaml` inválido para la imagen pinneada | `docker compose logs livekit`; validá el YAML contra `v1.8.4` |

Logs útiles: `docker compose logs -f livekit traefik api`. La imagen está **pinneada** a
`livekit/livekit-server:v1.8.4` (no `:latest`).

---

## 9. Rotación de claves

- **Claves LiveKit del bundled** (`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` en `.env`): generá nuevas
  (`openssl rand -hex 32`), reemplazalas en `.env` y `docker compose up -d livekit api` (ambas deben
  coincidir: el JWT que mintea la API tiene que validar contra la key del contenedor LiveKit).
- **Credenciales externas/Cloud guardadas en la DB**: rotalas por la API del admin (§6, `PATCH
  /api/admin/meet/settings`) — el secret se re-cifra. Para limpiarlas, mandá el secret vacío (vuelve al bundled).
- **`ENCRYPTION_KEY`** (clave maestra que cifra el secret en la DB): si la rotás, el secret guardado deja
  de desencriptar → la API del admin reporta `livekitSource: error` y las salas dan 503. **Solución**:
  reingresá la key/secret de LiveKit (`PATCH /api/admin/meet/settings`) → se re-cifran con la nueva `ENCRYPTION_KEY`.

---

## 10. Registro de decisiones (por qué es así)

- **Mismo EC2, sin 2º servidor**: la tesis de costo de Bifrost (correo casi-gratis para PYMEs) no
  sobrevive a un servidor extra. LiveKit en la misma caja, profile `meet`, límites cgroup.
- **Opcional/modular**: con Meet OFF la instalación es byte-idéntica → no penaliza a quien no lo usa.
- **Screen share en el MVP**; UI estilo Google Meet.
- **TURN/TLS diferido** (decisión de producto): no abrimos el TURNS estándar (5349/tcp) hoy; cobertura
  honesta (ver §5). El fast-follow del roadmap para redes sólo-443 es **TURN/TLS:443** (SNI passthrough L4 / 2ª IP).
- **EIP inyectada por CloudFormation** (no IMDS): el `EIPAssociation` asocia DESPUÉS de que el cloud-init
  señaliza, así que IMDS daría la IP efímera; se usa `Fn::Join` con `GetAtt ElasticIP.PublicIp`.
- **Modo de servidor automático por la URL** (sin selector explícito). **Grabación**: no implementada aún;
  cuando se integre será vía LiveKit Egress/Cloud (el flag `autoRecord` ya se persiste para ese futuro).
- **El mal uso lo paga el operador**: defaults sanos + estos docs, sin maquinaria de babysitting.
