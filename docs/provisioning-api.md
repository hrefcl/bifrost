# API de provisioning de buzones (Bifrost como autoridad de cuentas)

Bifrost puede **crear y eliminar buzones de correo por API**, sin claves AWS ni SSH al servidor. Así un
sistema externo (por ejemplo un panel corporativo o un script de altas) gestiona las cuentas de correo
programáticamente, en lugar de conectarse al servidor a correr `setup email add` a mano.

Requiere que el servidor **cree los buzones** (deploy turnkey con `docker-mailserver`). Si el servidor está
en modo «traé tu propio IMAP», la API responde `503`.

---

## 1. De dónde se obtiene la API-key

### Opción A — desde el panel (recomendado)

1. Entrá al **Admin** → sección **Provisioning** (grupo _Configuración_).
2. En **API-keys de provisioning**, escribí un nombre (ej. `Panel Vanir`) y **Generar key**.
3. **Copiá la key en ese momento**: se muestra **una sola vez** (se guarda hasheada; no se puede volver a
   ver). Si la perdés, revocá esa y generá otra.
4. Pegá la key en el sistema que la va a usar.

Podés **revocar** cualquier key desde la misma pantalla: los sistemas que la usaban dejan de tener acceso
al instante, sin afectar a las demás.

> Permiso necesario: `accounts.manage` (el admin lo tiene siempre).

### Opción B — key bootstrap del servidor (turnkey)

El instalador genera una key en el archivo `deploy/example-mailserver/secrets/provision_api_key.txt` del
servidor (montada en la API como docker-secret `PROVISION_API_KEY`). Sirve para automatizar el primer
arranque. En el servidor:

```bash
cat /opt/bifrost/deploy/example-mailserver/secrets/provision_api_key.txt
```

Para el día a día conviene generar keys **nominadas** desde el panel (se pueden revocar de forma
individual y quedan con nombre + último uso para auditoría).

---

## 2. Cómo se usa

Base URL = la del webmail (ej. `https://webmail.tudominio.com`). Autenticación: header
**`X-Provision-Key: <TU_KEY>`** en cada request. Todo el prefijo `/api/provision/*` responde `404` si el
servidor no tiene **ninguna** key configurada (así no se revela que el endpoint existe).

### Crear un buzón

```bash
curl -X POST https://webmail.tudominio.com/api/provision/mailboxes \
  -H "X-Provision-Key: <TU_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"email":"nuevo@tudominio.com","displayName":"Nuevo","quotaBytes":0}'
```

Campos: `email` (requerido); `password` (opcional — si lo omitís, Bifrost genera una fuerte y la devuelve
en la respuesta, **una sola vez**); `displayName` (opcional); `quotaBytes` (opcional, `0` = sin límite).

Respuesta `201`:

```json
{
  "id": "665f...",
  "email": "nuevo@tudominio.com",
  "status": "active",
  "quotaBytes": 0,
  "password": "K7f2v…"   // sólo si Bifrost la generó (password omitida en el request)
}
```

El buzón tarda unos segundos en quedar operativo (el mailserver reaplica su config); la llamada **espera
esa activación** antes de responder `201`.

**Idempotencia del alta:** mandá un header `Idempotency-Key: <uuid>`. Si reintentás con la misma key,
Bifrost devuelve la **misma respuesta cacheada** (incluida la password generada) en vez de un `409` →
nunca perdés la password ante un retry tras una respuesta perdida. La cache dura 15 min.

### Listar buzones (paginado + búsqueda)

```bash
curl "https://webmail.tudominio.com/api/provision/mailboxes?page=1&pageSize=100&search=ana" \
  -H "X-Provision-Key: <TU_KEY>"
```

Respuesta `200`: `{ "items": [<Mailbox>], "total": <int>, "page": <int>, "pageSize": <int> }`.
`search` filtra por email o nombre visible. `pageSize` máx 500.

### Editar perfil del buzón

```bash
curl -X PATCH https://webmail.tudominio.com/api/provision/mailboxes/user%40tudominio.com \
  -H "X-Provision-Key: <TU_KEY>" -H "Content-Type: application/json" \
  -d '{"displayName":"Nombre Visible","quotaBytes":0,"aliases":["alias@tudominio.com"],"active":true}'
```

Todos los campos opcionales. `active:false` **suspende** (corta IMAP/SMTP sin borrar el correo, conservando
la contraseña); `active:true` **reactiva** con la misma contraseña. Respuesta `200` → `<Mailbox>`.

### Cambiar contraseña (admin fija una)

```bash
curl -X PUT https://webmail.tudominio.com/api/provision/mailboxes/user%40tudominio.com/password \
  -H "X-Provision-Key: <TU_KEY>" -H "Content-Type: application/json" -d '{"password":"<nueva>"}'
```

Respuesta `200` → `{ "ok": true }`.

### Resetear contraseña (Bifrost genera una)

```bash
curl -X POST https://webmail.tudominio.com/api/provision/mailboxes/user%40tudominio.com/reset-password \
  -H "X-Provision-Key: <TU_KEY>" -H "Content-Type: application/json" -d '{}'
```

Respuesta `200` → `{ "email": "...", "password": "<nueva>" }` (mostrar/entregar **una sola vez**).

### Modelo `<Mailbox>` (mismo shape en list/get/create/patch)

```json
{
  "id": "…", "email": "user@tudominio.com", "displayName": "Nombre Visible",
  "status": "active | suspended", "quotaBytes": 0, "quotaUsedBytes": 0,
  "aliases": ["alias@tudominio.com"], "createdAt": "ISO-8601", "updatedAt": "ISO-8601"
}
```

> `quotaUsedBytes` hoy devuelve `0` (el uso real vive en el Maildir del mailserver; requiere doveadm/montar
> el maildata — follow-up). El resto de los campos son exactos.

### Respuestas a las dudas de semántica

- **¿Un `502` puede ocurrir después de un write exitoso?** No de forma que pierda datos: todos los writes
  al mailserver son **atómicos** (temp + rename) con **rollback** en el alta → un `502`/`5xx` significa
  **sin side-effect**, así que **reintentar es seguro**. Y para el caso "el write tuvo éxito pero la
  respuesta se perdió", el alta acepta **`Idempotency-Key`** (el retry devuelve la misma respuesta con la
  password generada, no un `409`).
- **`X-Provision-Key` uniforme:** sí, **todos** los endpoints de `/api/provision/*` usan el mismo guard
  `X-Provision-Key`. El `401 "Invalid or missing token"` que veías en `GET /api/provision/mailboxes` era
  porque ese endpoint (listado) **no existía** → caía en el guard global de sesión; ahora existe y usa
  `X-Provision-Key` como el resto.

### Eliminar un buzón

Revoca el acceso IMAP/SMTP **y** borra la cuenta de Bifrost. El email va URL-encodeado (`@` → `%40`):

```bash
curl -X DELETE https://webmail.tudominio.com/api/provision/mailboxes/nuevo%40tudominio.com \
  -H "X-Provision-Key: <TU_KEY>"
```

Respuesta `200`: `{ "ok": true }`. El correo almacenado **no** se borra del disco (queda recuperable); lo
que se elimina es el acceso.

### Consultar si un buzón existe

```bash
curl https://webmail.tudominio.com/api/provision/mailboxes/nuevo%40tudominio.com \
  -H "X-Provision-Key: <TU_KEY>"
```

`200` → `{ "email": "...", "status": "active" }` · `404` → no existe. Útil para hacer el alta idempotente.

---

## 3. Códigos de respuesta

| Código | Significado |
| ------ | ----------- |
| `201`  | Buzón creado. |
| `200`  | Baja/consulta OK. |
| `401`  | Falta el header `X-Provision-Key` o la key es inválida/revocada. |
| `404`  | El buzón no existe (baja/consulta) **o** el endpoint está oculto (ninguna key configurada). |
| `409`  | Ya existe un buzón con ese email (alta). |
| `502`  | No se pudo escribir en el servidor de correo (reintentá). |
| `503`  | Este servidor no crea buzones (modo «traé tu IMAP»). |

---

## 4. Seguridad

- Las keys se guardan **hasheadas** (SHA-256); el valor en claro sólo se muestra al generarlas.
- Usá **HTTPS** siempre (la key viaja en un header).
- Generá una key **por sistema** y revocala si se compromete — no compartas una sola entre integraciones.
- La verificación del header es a prueba de _timing_; sin key configurada el endpoint ni siquiera se revela.

Detalle de implementación: `packages/api/src/services/mailbox/` (provider de buzones),
`packages/api/src/services/provision-keys.ts` (keys) y `packages/api/src/routes/provision.ts` (API).
