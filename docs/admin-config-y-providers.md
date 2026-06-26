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
- **config** persistida en `SystemConfig` (Mongo); los secretos (S3 secret, clave SSH) se
  guardan **cifrados** con la `ENCRYPTION_KEY` (AES-256-GCM, igual que las credenciales de
  cuenta) — NO en texto plano, NO en logs, NO se devuelven en los GET (se muestran como `••••`),
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

- El admin es la **cuenta creada por el setup inicial** (campo `role: 'admin'` en `User`). NO
  "el primer login" (sería tomable si la app queda expuesta). Si no existe admin, bootstrap
  **transaccional** con lock (evita carrera de dos primeros logins). Ver §6.bis-F.
- Sólo un admin ve `/admin` y puede tocar `SystemConfig`. Guard `requireAdmin` que **consulta
  la DB** (`user.role`), no confía sólo en el claim del JWT. Feature-gate también en backend
  (403 si el provider está disabled) — ocultar la UI no alcanza.
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

## 6.bis Hardening del diseño (resuelve la review B/D — sin esto NO se codea)

Tras la review de diseño (B: HIGH abiertos; D 7.5/10), estas condiciones son **sine qua non**
antes de PR-A. Con ellas el diseño queda construible (B/D → 8.5/10).

### A. Scope = single-org (NO multi-tenant) — decisión explícita
Bifrost es **self-hosted, una organización por deployment**. `SystemConfig` es **global**
(no por-cuenta/dominio). **Multi-org/SaaS es NON-GOAL** declarado. Si algún día se necesita,
es otro proyecto (config por-tenant). Documentado para que nadie asuma lo contrario.

### B. `SystemConfig` (schema por provider)
```ts
{ key: 'storage' | 'provisioning',
  providerType: 'local' | 's3' | 'none' | 'docker-mailserver' | 'api',
  enabled: boolean,
  config: { ... },                 // no-secreto (endpoint, bucket, region, host…)
  secrets: { ...encrypted },       // cifrado AES-GCM; nunca se devuelve en GET
  updatedAt: Date, updatedBy: userId }   // ← auditoría mínima inline
```

### C. Adjuntos: ownership + provider-bound (cierra 2 HIGH)
Modelo `AttachmentBlob` (no basta `{ storageKey }`):
```ts
{ id, storageKey,                 // key random server-side (no input del cliente)
  providerType: 'local' | 's3',   // ← PROVIDER-BOUND: se lee SIEMPRE de su provider,
                                    //   aunque el activo haya cambiado (no rompe viejos)
  userId, accountId,              // ← OWNERSHIP server-side: enviar/bajar valida dueño
  draftId?, refCount,             // lifecycle: forward incrementa refCount del mismo blob
  filename, mimeType, size, createdAt }
```
- El **provider activo se usa SÓLO para escrituras nuevas**. Lecturas van al `providerType`
  del blob → cambiar de `local`→`s3` **no rompe** adjuntos existentes.
- **Migración** de blobs viejos = script opt-in aparte (NO automático al cambiar provider).
- **Ownership**: `POST /attachments` ata el blob a `userId`; send/download validan dueño (403
  ajeno) — mismo patrón que `requireOwnedEmail`.

### D. LocalStorage hardening
`storageKey` random server-side (uuid), guardado bajo un root fijo, **sin path traversal**
(jamás concatenar input del cliente al path), writes atómicos (tmp+rename), cap de tamaño,
rate-limit del upload.

### E. MailboxProvisioning (SSH) — contrato de seguridad (cierra el HIGH de inyección)
- **NUNCA** interpolar email/password en un string de shell. Ejecutar con **args como array**
  (sin shell) o un **forced command** del lado del mailserver (la SSH key del provisioner
  sólo puede correr `setup email …`, nada más — `command="..."` en authorized_keys).
- **Validación estricta** ANTES de ejecutar: email `^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$`,
  password sin metacaracteres de shell (o pasado por stdin, nunca en argv).
- **Host key verification** (no `StrictHostKeyChecking=no`).
- Cuenta SSH de **mínimos privilegios**, clave dedicada, cifrada en `SystemConfig`.

### F. Admin bootstrap seguro (cierra el HIGH de "primer login")
- El admin es la **cuenta creada por el setup inicial** (no "el primer login"). Si no hay
  admin, bootstrap **transaccional** (lock) para evitar carrera de dos primeros logins.
- `requireAdmin` **consulta la DB** (`user.role`), no confía sólo en el claim del JWT.
- **Recuperación** (el "flag de reinstall" estilo WordPress, para no quedar afuera): un
  comando del **lado del servidor** `pnpm --filter @webmail6/api admin:grant <email>` (o env
  `ADMIN_BOOTSTRAP_EMAIL` leído sólo al boot) que marca/restaura un admin. **Nunca expuesto en
  la web** → requiere acceso al servidor (filesystem/CLI), igual que resetear WP por wp-cli.
  Así, perder el admin se arregla con acceso al server, no abre una puerta web.

### G. Feature-gate también en backend
Ocultar la UI NO alcanza: los endpoints de provisión/admin devuelven **403** si el provider
está `disabled`/`none`. La UI es conveniencia; el backend es la barrera real.

### H. Auditoría + lifecycle
- **Audit log** (colección): cambios de `SystemConfig`, pruebas de conexión, alta/baja de
  buzones, rotación de secretos → `{ who, action, target, at }`.
- **Cleanup**: sweep de blobs huérfanos (draft borrado, envío fallido, `refCount==0`); cuota
  total por usuario (además del cap por-archivo); límite de archivos por correo.

## 7. Por qué así (decisiones de arquitectura)

- **No reinvento**: S3 SDK estándar (sirve para AWS/MinIO/SeaweedFS); el mismo seam que
  mail-transport; SystemConfig + cifrado AES ya existen.
- **Default `local` siempre presente** → la feature de adjuntos nunca queda bloqueada por falta
  de infra; S3 es opt-in para quien escala.
- **Feature-gating** → la complejidad (provisión de buzones) sólo se expone a quien la activó;
  el resto ve un webmail simple y limpio (objetivo "como Gmail").
