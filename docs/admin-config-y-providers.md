# Admin, configuración y providers pluggables — Diseño (Webmail 6.0 / Bifrost)

> **Visión (del PM):** Bifrost es un FRONT de webmail (estilo Roundcube) que corre sobre
> cualquier servidor de correo. Lo que NO es del correo en sí — dónde se guardan los adjuntos,
> si se pueden crear buzones, etc. — debe ser **configurable por un admin** desde un **wizard
> simple**, y cada capacidad debe **aparecer sólo si su backend está activo**. Esta es la
> "stack de opciones" que el Equipo A define como tech lead. Fase 2 (diseño) — la
> implementación va incremental.

## 1. Principio: providers pluggables + feature-gating

Toda capacidad que dependa de infraestructura externa se modela como un **provider** con:
- una **interfaz** estable (el resto del código no sabe qué backend hay detrás),
- N **implementaciones** seleccionables (el admin elige una en el wizard),
- **config** persistida en `SystemConfig` (Mongo) + secretos fuera de la DB,
- **feature-gate**: la UI de la capacidad sólo aparece si el provider está configurado y `enabled`.

Mismo patrón que ya usamos para IMAP/SMTP (`services/mail-transport.ts`). Dos providers nuevos:

| Provider | Para qué | Opciones (stack que defino) | Si NO hay → |
|---|---|---|---|
| **Storage** | Guardar adjuntos (y futuros blobs) | `local` (mismo servidor/volumen, **default**) · `s3` (AWS S3 / MinIO / cualquiera S3-compatible: endpoint+bucket+region+keys) | Adjuntos se guardan `local` (siempre hay default → nunca bloquea) |
| **MailboxProvisioning** | Crear/borrar buzones en el servidor de correo | `none` (**default**, oculto) · `docker-mailserver` (ejecuta `setup email …` vía SSH/exec) · `api` (un endpoint HTTP del backend) | La sección "Crear cuenta de email" **no aparece** |

> Regla clave del PM: *"crear cuentas de email sólo disponible cuando existen las opciones
> activas"* → el provider de provisión es opt-in; sin él configurado, esa parte del admin
> simplemente no se muestra.

## 2. Cuenta admin

- La **primera** cuenta que se loguea/crea queda marcada `role: 'admin'` (campo nuevo en `User`).
- Sólo un admin ve `/admin` y puede tocar `SystemConfig` (storage, provisión, política de
  adjuntos, etc.). Endpoints admin protegidos por un guard `requireAdmin` (además de auth).
- Resto de usuarios: experiencia normal de webmail (sin `/admin`).

## 3. Interfaces (backend)

```ts
// services/storage/types.ts
export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ stream: Readable; contentType: string; size: number }>;
  delete(key: string): Promise<void>;
}
// implementaciones: LocalStorage (fs + volumen) · S3Storage (@aws-sdk/client-s3, sirve para
// AWS, MinIO, SeaweedFS S3, etc. — todos hablan el mismo protocolo).

// services/provisioning/types.ts
export interface MailboxProvisioner {
  createMailbox(email: string, password: string): Promise<void>;
  deleteMailbox(email: string): Promise<void>;
  listMailboxes(): Promise<string[]>;
}
// implementaciones: DockerMailserverProvisioner (SSH/exec `setup email add`) · ApiProvisioner.
```

El provider activo se resuelve en runtime desde `SystemConfig` (una factory, como mail-transport).

## 4. Wizard del admin (UX — simple, paso a paso)

Pantalla `/admin/setup` (y editable luego en `/admin/settings`). Cada paso es **opcional** y
con **defaults sanos**; el admin puede saltar y queda funcionando con lo mínimo.

```
Paso 1 · Storage de adjuntos
   ( ) Mismo servidor (recomendado para empezar)        ← default, 0 config
   ( ) S3 / compatible  → [endpoint] [bucket] [region] [access key] [secret]  [Probar conexión]

Paso 2 · Crear cuentas de email desde el panel  (opcional)
   ( ) No, ya administro los buzones por fuera           ← default → la sección no aparece
   ( ) docker-mailserver  → [host SSH] [usuario] [clave/keyfile]              [Probar]
   ( ) API del proveedor  → [URL] [token]                                     [Probar]

Paso 3 · Política de adjuntos
   Tamaño máx por archivo [25] MB · Tipos bloqueados [.exe,.bat,…]
```

- **"Probar conexión"** valida antes de guardar (no se guarda una config rota).
- Al guardar, se persiste en `SystemConfig`; los secretos (S3 secret, clave SSH) cifrados
  con la `ENCRYPTION_KEY` existente (AES-256-GCM, igual que las credenciales de cuenta).
- Feature-gate: si Paso 2 = "No", el resto de la app no muestra "Crear cuenta de email".

## 5. Adjuntos (consume el Storage provider) — el feature que esto desbloquea

1. **Subir** (compose): `POST /api/attachments` (multipart) → guarda en el provider → devuelve
   `{ storageKey, filename, size, mimeType }`. La UI lo agrega al draft (`draft.attachments`).
2. **Enviar**: `smtp.sendDraft` lee cada `attachment.storageKey` del provider y lo pasa a
   MailComposer (hoy los IGNORA — bug latente ya registrado).
3. **Forward**: copia los `storageKey` del original al nuevo draft (o re-stream del IMAP).
4. **Bajar**: ya existe `GET /emails/:id/attachments/:idx` (seguro: nosniff + attachment).

## 6. Plan incremental (cómo lo construyo, en orden, cada uno su PR + review B/D)

1. **PR-A** `role: admin` + guard `requireAdmin` + `/admin` shell vacío. (base, chico)
2. **PR-B** Storage provider: interfaz + `LocalStorage` + wizard Paso 1 + persistencia en
   SystemConfig. (sin S3 todavía → ya funciona con `local`)
3. **PR-C** Adjuntos end-to-end sobre Storage: upload + UI en compose + envío + forward + E2E.
4. **PR-D** `S3Storage` (opción S3 en el wizard) — aditivo.
5. **PR-E** MailboxProvisioning: interfaz + `DockerMailserverProvisioner` + wizard Paso 2 +
   UI "Crear cuenta" feature-gated. (la más compleja; al final)

Cada PR es chico, testeable y reviewado. Empezamos por PR-A/PR-B (base + storage local), que
ya deja adjuntos a tiro sin requerir S3 ni provisión.

## 7. Por qué así (decisiones de arquitectura)

- **No reinvento**: S3 SDK estándar (sirve para AWS/MinIO/SeaweedFS); el mismo seam que
  mail-transport; SystemConfig + cifrado AES ya existen.
- **Default `local` siempre presente** → la feature de adjuntos nunca queda bloqueada por falta
  de infra; S3 es opt-in para quien escala.
- **Feature-gating** → la complejidad (provisión de buzones) sólo se expone a quien la activó;
  el resto ve un webmail simple y limpio (objetivo "como Gmail").
