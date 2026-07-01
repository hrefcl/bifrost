# Funcional 07 — Admin · Panel de configuración de Bifrost Meet

> Fase 0 — Contrato funcional pre-implementación. Fuente de verdad: `docs/meet/DESIGN.md` (v2.3).
> Pantalla: nueva pestaña `meet` en `AdminView.vue`, componente `components/admin/AdminMeetPanel.vue`
> (clon del patrón `AdminSchedulingPanel.vue`). Singleton `MeetSettings` vía `GET/PATCH /api/admin/meet/settings`.

---

## Información general

- **Nombre:** Administración → Reuniones (configuración global de Bifrost Meet).
- **Objetivo:** Permitir al administrador activar/desactivar Bifrost Meet para toda la instalación y configurar los parámetros globales: URL de señalización, base pública para links, dominio TURN, límites de participantes y duración, política de invitados externos, branding y auditoría.
- **Descripción funcional:** Panel admin (clon de `AdminSchedulingPanel.vue`) montado como pestaña `meet` en `AdminView.vue`. Carga el singleton `MeetSettings` con `GET /api/admin/meet/settings` y lo persiste con `PATCH /api/admin/meet/settings`. El toggle `enabled` es el **master gate** de toda la feature en la UI: con `enabled=false`, las secciones Meet del usuario (Ajustes→Reuniones, checkboxes de calendario/scheduling, rutas públicas de unión) quedan ocultas/inactivas porque dependen de `meetEnabled` en `/api/config/public`. **Aviso clave:** ciertos cambios (dominio/wsUrl/turnDomain) afectan CSP horneada en deploy-time (nginx + helmet) y puertos/DNS provisionados por CloudFormation; **requieren redeploy/reprovisión** para tener efecto pleno, no solo guardar en BD.
- **Tipo de usuario:** Solo administrador (rol `admin`).
- **Permisos:** `requiresAdmin` (verificado en backend en `/api/admin/meet/settings`). El hook JWT global ya exige auth; la ruta admin reverifica rol.
- **Ruta:** `/admin` con pestaña activa `tab === 'meet'` (estado local `tab` en `AdminView.vue`; patrón de tabs por estado, no por URL).
- **Breadcrumbs:** `Administración › Reuniones`.
- **Relación con otras pantallas:**
  - **Ajustes → Reuniones** (`06-settings-meet.md`): su visibilidad depende del `enabled` de este panel.
  - **CalendarView / SchedulingView / PublicBookingView / MeetJoinView:** todas gated por `meetEnabled`, que deriva de este singleton.
  - **Infra (DESIGN §8):** `wsUrl`, `publicBaseUrl`, `turnDomain` se alinean con `docker-compose` (perfil `meet`), `livekit.yaml`, CSP de nginx/helmet y registros Route53 — cambios de dominio implican reprovisión.

---

## Diseño funcional

- **Layout:** Reutiliza el layout de `AdminView`: `AppLayout` → `.admin-inner` con `nav.tabs` (se agrega `<button class="tab" :class="{active: tab==='meet'}">` con icono `video`) y debajo el panel condicional `<AdminMeetPanel v-if="tab === 'meet'" />`. El panel sigue la estética de `AdminSchedulingPanel`: tarjetas `.card` con título `.h`, descripción `.desc`, filas de checkbox `.row`, grilla de campos `.grid`/`.fld`/`.in` y barra `.actions` (botón Guardar + feedback).
- **Secciones (dentro de `AdminMeetPanel.vue`):**
  1. **Activación (master gate):** checkbox `enabled` — "Activar Bifrost Meet" con descripción de que habilita la feature en toda la instalación.
  2. **Endpoints/dominios:** campos `wsUrl` (señalización wss), `publicBaseUrl` (base de links públicos), `turnDomain` (dominio TURN). Con **aviso de redeploy** visible.
  3. **Límites:** `maxParticipants` (número), `maxDurationMinutes` (número).
  4. **Invitados externos:** checkbox `allowExternal`.
  5. **Branding:** campo(s) `branding` (texto/JSON ligero: nombre/eslogan opcional para la sala).
  6. **Auditoría:** checkbox `auditEnabled`.
  7. **Barra de acciones:** botón "Guardar" + "Guardado ✓" / error.
- **Estado vacío:** El singleton siempre existe (se crea con defaults la primera vez). Si nunca se configuró, viene con valores por defecto del backend (Meet OFF).
- **Estado de carga:** `loading=true` → muestra "Cargando…" (`.muted`) mientras resuelve `GET`. Igual patrón que `AdminSchedulingPanel`.
- **Estado de error:** Si `GET` falla → `error` "No se pudo cargar la configuración." y no se renderiza el form. Si `PATCH` falla → `error` bajo las acciones. Si el usuario no es admin → backend responde 403 y el panel muestra error de carga (la pestaña no debería ser accesible para no-admins).

---

## Componentes

### Pestaña "Reuniones" (tab `meet`)
- **Descripción:** Botón de pestaña en `nav.tabs` de `AdminView`.
- **Visibilidad:** Solo en `/admin` (vista ya restringida a admin).
- **Permisos:** Admin.
- **Validaciones:** N/A.
- **Estados:** `active` cuando `tab==='meet'`.
- **Eventos:** `@click="tab='meet'"`.
- **Acciones:** Renderiza `<AdminMeetPanel />`.

### Checkbox "Activar Bifrost Meet" (`enabled`) — master gate
- **Descripción:** Interruptor maestro de la feature.
- **Visibilidad:** Siempre dentro del panel.
- **Permisos:** Admin.
- **Validaciones:** Booleano.
- **Estados:** marcado/desmarcado; deshabilitado al guardar.
- **Eventos:** `v-model="settings.enabled"`.
- **Acciones:** Al guardar con `enabled=true`, `meetEnabled` pasa a `true` en `/api/config/public` → habilita UI Meet en todo el SPA. Con `false`, oculta/inactiva todo Meet en la UI.

### Campos de dominio (`wsUrl`, `publicBaseUrl`, `turnDomain`)
- **Descripción:** Endpoints de señalización (wss), base de links públicos de unión, dominio TURN.
- **Visibilidad:** Siempre.
- **Permisos:** Admin.
- **Validaciones:** Formato URL (`wss://…` para `wsUrl`, `https://…` para `publicBaseUrl`), host válido para `turnDomain`.
- **Estados:** normal/foco/deshabilitado al guardar. Muestran **aviso de redeploy** (banner/nota): cambiar el dominio en BD no actualiza CSP horneada ni DNS/puertos hasta reprovisionar.
- **Eventos:** `v-model`.
- **Acciones:** Marcan formulario para guardar.

### Campos numéricos (`maxParticipants`, `maxDurationMinutes`)
- **Descripción:** Techo global de participantes por sala y duración máxima.
- **Visibilidad:** Siempre.
- **Permisos:** Admin.
- **Validaciones:** Enteros positivos; rangos razonables (ver Formularios). `maxParticipants` es el techo heredado por `livekit.yaml` (`room.max_participants`).
- **Estados:** normal/foco/deshabilitado.
- **Eventos:** `v-model.number`.
- **Acciones:** Marcan formulario.

### Checkbox "Permitir invitados externos" (`allowExternal`)
- **Descripción:** Política global de si externos (sin cuenta) pueden unirse por link.
- **Visibilidad:** Siempre.
- **Permisos:** Admin.
- **Validaciones:** Booleano. Nota: las salas de tipo `booking` fuerzan `allowExternalOverride=true` a nivel sala (DESIGN §4) independientemente de este global.
- **Estados:** marcado/desmarcado.
- **Eventos:** `v-model`.
- **Acciones:** Marca formulario.

### Campo "Branding" (`branding`)
- **Descripción:** Branding opcional para la pantalla de unión/sala (texto o JSON ligero: nombre/eslogan).
- **Visibilidad:** Siempre.
- **Permisos:** Admin.
- **Validaciones:** Longitud acotada; opcional.
- **Estados:** normal/foco.
- **Eventos:** `v-model`.
- **Acciones:** Marca formulario.

### Checkbox "Registrar auditoría" (`auditEnabled`)
- **Descripción:** Activa logs estructurados de `room.create` y `token.issue` (DESIGN §5/§13).
- **Visibilidad:** Siempre.
- **Permisos:** Admin.
- **Validaciones:** Booleano.
- **Estados:** marcado/desmarcado.
- **Eventos:** `v-model`.
- **Acciones:** Marca formulario; al guardar, habilita/inhabilita el registro de auditoría Meet.

### Bloque de feedback
- **Descripción:** "Guardado ✓" (`.ok`) y error (`.err`).
- **Visibilidad:** `v-if="saved"` / `v-if="error"`.
- **Estados:** efímero.

---

## Botones

### Guardar
- **Texto:** "Guardar" / "Guardando…" (mientras `saving`).
- **Icono:** Ninguno (botón `.btn`).
- **Ubicación:** `.actions` al final de la tarjeta de configuración.
- **Habilitado:** Cuando `!saving`.
- **Deshabilitado:** Mientras `saving===true`.
- **Acción:** `save()` → `PATCH /api/admin/meet/settings` con todos los campos del singleton.
- **Confirmaciones:** Si se está **desactivando** Meet (`enabled` de true→false), mostrar `confirm()` "Esto ocultará Bifrost Meet para todos los usuarios. ¿Continuar?" (acción de alto impacto). El resto de cambios no requiere confirmación.
- **Mensajes:** Éxito → "Guardado ✓". Error → "No se pudo guardar. Revisá los valores (URLs válidas, rangos)."
- **Navegación:** Permanece en la pestaña; tras guardar recarga el singleton (refresca estado).

---

## Formularios

### Campo: `enabled`
- **Nombre:** Activar Bifrost Meet.
- **Tipo:** Checkbox (boolean) — master gate.
- **Obligatorio:** Sí (siempre tiene valor).
- **Default:** `false`.
- **Placeholder:** N/A.
- **Validaciones:** Booleano.
- **Longitud:** N/A.
- **Ayuda:** "Activa o desactiva Bifrost Meet en toda la instalación. Con Meet desactivado, la base funciona idéntica a hoy."
- **Formato:** `true|false`.
- **Errores:** N/A individual; error global de guardado.

### Campo: `wsUrl`
- **Nombre:** URL de señalización (WebSocket).
- **Tipo:** Input text (URL).
- **Obligatorio:** Sí cuando `enabled=true`.
- **Default:** `wss://meet.<dominio>`.
- **Placeholder:** `wss://meet.example.com`.
- **Validaciones:** Debe empezar con `wss://`; host válido.
- **Longitud:** ≤255.
- **Ayuda:** "Señalización LiveKit (interno del SDK). **Cambiarla requiere redeploy** (CSP de nginx/helmet horneada en build/boot)."
- **Formato:** `wss://host`.
- **Errores:** "URL inválida (debe ser wss://)".

### Campo: `publicBaseUrl`
- **Nombre:** Base pública de links.
- **Tipo:** Input text (URL).
- **Obligatorio:** Sí cuando `enabled=true`.
- **Default:** `https://webmail.<dominio>`.
- **Placeholder:** `https://webmail.example.com`.
- **Validaciones:** Debe empezar con `https://`; host válido.
- **Longitud:** ≤255.
- **Ayuda:** "Base de los links de unión que se incluyen en correo/ICS (`/meet/<slug>`). Default = SPA real."
- **Formato:** `https://host`.
- **Errores:** "URL inválida (debe ser https://)".

### Campo: `turnDomain`
- **Nombre:** Dominio TURN.
- **Tipo:** Input text (host).
- **Obligatorio:** Opcional (TURN embebido).
- **Default:** `turn.meet.<dominio>`.
- **Placeholder:** `turn.meet.example.com`.
- **Validaciones:** Host/FQDN válido.
- **Longitud:** ≤255.
- **Ayuda:** "Dominio del TURN embebido. **Cambios requieren reprovisión** (Route53 + puertos del Security Group)."
- **Formato:** FQDN.
- **Errores:** "Dominio inválido".

### Campo: `maxParticipants`
- **Nombre:** Máx. participantes por sala.
- **Tipo:** Input number.
- **Obligatorio:** Sí.
- **Default:** Valor por defecto del backend (ej. `10`).
- **Placeholder:** `10`.
- **Validaciones:** Entero, mín. 2, máx. razonable (ej. 100) acorde a límites cgroup del EC2 compartido.
- **Longitud:** N/A.
- **Ayuda:** "Techo global; `livekit.yaml` lo hereda (`room.max_participants`). `ensureRoom` solo puede refinar por sala hacia abajo."
- **Formato:** Entero.
- **Errores:** "Debe ser un entero ≥ 2".

### Campo: `maxDurationMinutes`
- **Nombre:** Duración máxima (min).
- **Tipo:** Input number.
- **Obligatorio:** Sí.
- **Default:** Valor por defecto (ej. `120`).
- **Placeholder:** `120`.
- **Validaciones:** Entero, mín. 5, máx. 720 (12h, tope duro de tokens personales).
- **Longitud:** N/A.
- **Ayuda:** "Tope de duración; alimenta el TTL de tokens (clamp) y el cierre pasivo de salas."
- **Formato:** Entero.
- **Errores:** "Debe estar entre 5 y 720".

### Campo: `allowExternal`
- **Nombre:** Permitir invitados externos.
- **Tipo:** Checkbox (boolean).
- **Obligatorio:** No.
- **Default:** `false`.
- **Placeholder:** N/A.
- **Validaciones:** Booleano.
- **Longitud:** N/A.
- **Ayuda:** "Permite que personas sin cuenta se unan por link. Las salas de reservas (booking) siempre permiten externos."
- **Formato:** `true|false`.
- **Errores:** N/A.

### Campo: `branding`
- **Nombre:** Branding de sala.
- **Tipo:** Input text (o JSON ligero).
- **Obligatorio:** No.
- **Default:** Vacío (usa branding global de la instalación).
- **Placeholder:** "Nombre/eslogan a mostrar en la sala".
- **Validaciones:** Longitud ≤120; opcional.
- **Longitud:** 0–120.
- **Ayuda:** "Texto opcional que se muestra en la pantalla de unión/sala."
- **Formato:** Texto plano / JSON corto.
- **Errores:** "Branding demasiado largo".

### Campo: `auditEnabled`
- **Nombre:** Registrar auditoría.
- **Tipo:** Checkbox (boolean).
- **Obligatorio:** No.
- **Default:** `true`.
- **Placeholder:** N/A.
- **Validaciones:** Booleano.
- **Longitud:** N/A.
- **Ayuda:** "Registra logs estructurados de creación de sala y emisión de token."
- **Formato:** `true|false`.
- **Errores:** N/A.

---

## UX / UI

- **Flujo normal:** Admin entra a `/admin` → pestaña "Reuniones" → ajusta `enabled` + dominios + límites → "Guardar" → "Guardado ✓"; si activó Meet, la feature aparece para los usuarios.
- **Flujos alternativos:**
  - Activación inicial: admin marca `enabled`, completa `wsUrl`/`publicBaseUrl`, guarda → **luego** debe asegurarse de que el deploy/provisión tiene el perfil Meet y CSP correctos (aviso visible).
  - Cambio de dominio: admin cambia `wsUrl` en BD → banner advierte que sin redeploy la CSP bloqueará el wss → cambio incompleto hasta reprovisionar.
  - Desactivación: admin desmarca `enabled` → `confirm()` → Meet desaparece de la UI; infra puede seguir corriendo (idempotente) pero la UI lo oculta.
- **Casos borde:**
  - `enabled=true` pero `LIVEKIT_*` ausentes en backend → el gate `meetEnabled()` del backend igual responde "disabled" en endpoints Meet; documentar que activar en UI no basta sin secrets/infra.
  - `maxParticipants` por encima del techo de `livekit.yaml` → backend clampa; la UI debería reflejar el valor efectivo tras guardar.
  - Doble guardado → botón deshabilitado durante `saving`.
- **Loading:** "Cargando…" inicial; "Guardando…" en el botón.
- **Feedback:** "Guardado ✓" verde; error rojo bajo acciones.
- **Confirmaciones:** Solo al **desactivar** Meet (alto impacto global).
- **Mensajes:** Aviso persistente de redeploy junto a los campos de dominio. i18n `admin.meet.*`.
- **Accesibilidad:** Labels asociados, checkboxes y numéricos navegables por teclado, banner de aviso con rol informativo, foco visible.
- **Navegación:** Tabs por estado; sin recarga de página. Tras guardar, recarga el singleton.
- **Responsive:** Hereda grilla responsive del patrón `AdminSchedulingPanel` (`.grid` con `auto-fit minmax`).

---

## Reglas de negocio

- **Restricciones:** Solo admin. El singleton es único (clave `meet` en `SystemConfig`). `enabled` es el master gate de la UI Meet.
- **Permisos:** `requiresAdmin` reverificado en backend; la verificación de rol no se delega solo al frontend.
- **Dependencias:**
  - Backend: gate `meetEnabled()` también exige `LIVEKIT_*` presentes; activar en UI sin secrets no habilita realmente los endpoints.
  - Infra: `wsUrl`/`turnDomain` ↔ CSP nginx+helmet (deploy-time) y Route53/Security Group (CloudFormation) → **cambios de dominio requieren redeploy/reprovisión**.
  - `publicBaseUrl` ↔ links horneados en snapshot de Booking/ICS/correo.
- **Validaciones:** URLs (`wss://`, `https://`), host TURN, enteros con rango para límites, longitudes de branding.
- **Automatizaciones:** El valor `maxParticipants` se propaga como techo a `livekit.yaml`/`ensureRoom`; `auditEnabled` activa logs; `enabled` controla `/api/config/public`.
- **Integraciones:** LiveKit (límites/duración), CloudFormation (dominios/puertos), nginx/helmet (CSP), correo/ICS (`publicBaseUrl`).

---

## Casos de uso

- **Exitoso:** Admin activa Meet con dominios correctos en una instalación ya provisionada con perfil Meet → usuarios ven Meet y pueden crear/unirse a salas.
- **Alternativos:**
  - Admin sube `maxParticipants` de 10 a 20 (dentro del techo de infra) → salas nuevas heredan el límite.
  - Admin desactiva `allowExternal` → externos no pueden unirse salvo en salas de reserva.
  - Admin activa `auditEnabled` → aparecen logs de room.create/token.issue.
- **Error:** `PATCH` con `wsUrl` mal formada → 400 → mensaje "Revisá los valores".
- **Cancelaciones:** Admin cambia campos y sale de la pestaña sin guardar → cambios locales descartados.
- **Reintentos:** Tras error de red, "Guardar" sigue habilitado; reintento con mismo payload (idempotente sobre singleton).
- **No permitidas:** No-admin accediendo al endpoint → 403; activar Meet sin infra/secrets no surte efecto real (documentado, no bloqueado por la UI).

---

## APIs

### `GET /api/admin/meet/settings`
- **Endpoint:** `/api/admin/meet/settings`
- **Método:** GET
- **Parámetros:** Ninguno (JWT admin).
- **Respuesta:** `MeetSettings` = `{ enabled, wsUrl, publicBaseUrl, turnDomain, maxParticipants, maxDurationMinutes, allowExternal, branding, auditEnabled, recordingPolicy:'disabled' }`.
- **Errores:** 401 (sin auth), 403 (no admin).
- **Permisos:** Admin (`requiresAdmin`).

### `PATCH /api/admin/meet/settings`
- **Endpoint:** `/api/admin/meet/settings`
- **Método:** PATCH
- **Parámetros (body):** Subconjunto de `MeetSettings`: `{ enabled?, wsUrl?, publicBaseUrl?, turnDomain?, maxParticipants?, maxDurationMinutes?, allowExternal?, branding?, auditEnabled? }`. `recordingPolicy` queda fijo en `'disabled'` (no editable en MVP).
- **Respuesta:** `MeetSettings` actualizado (con `maxParticipants` clampado al techo si aplica).
- **Errores:** 400 (validación: URLs/rangos), 401, 403.
- **Permisos:** Admin.

### `GET /api/config/public` (efecto)
- **Endpoint:** `/api/config/public`
- **Método:** GET
- **Parámetros:** Ninguno.
- **Respuesta:** `{ meetEnabled, livekitWsUrl, meetPublicBaseUrl }` derivado del singleton + presencia de `LIVEKIT_*`.
- **Errores:** N/A.
- **Permisos:** Público. (Consecuencia: editar `enabled`/`wsUrl`/`publicBaseUrl` aquí cambia lo que el SPA expone a todos.)

---

## Modelo de datos

- **Entidades:** `MeetSettings` (singleton, persistido como `SystemConfig` con clave `meet`).
- **Relaciones:** Singleton global (no por usuario). Influye en `MeetRoom` (techo `maxParticipants`, `allowExternal`), en `/api/config/public` y en la lógica de tokens (TTL ↔ `maxDurationMinutes`).
- **Campos (`MeetSettings`):**
  - `enabled: boolean` (master gate).
  - `wsUrl: string` (wss de señalización).
  - `publicBaseUrl: string` (base de links públicos).
  - `turnDomain: string` (dominio TURN).
  - `maxParticipants: number` (techo global).
  - `maxDurationMinutes: number` (tope de duración).
  - `allowExternal: boolean` (política de externos).
  - `branding?: string` (branding de sala, opcional).
  - `auditEnabled: boolean` (logs de auditoría).
  - `recordingPolicy: 'disabled'` (fijo en MVP, no editable).
- **Persistencia:** Mongo (`SystemConfig` key `meet`), CRUD vía `/api/admin/meet/settings`. DTO `MeetSettings` en `@webmail6/shared`. **Importante:** los cambios de dominio en BD **no** modifican la CSP horneada (nginx/helmet en deploy/boot) ni la infraestructura (Route53/Security Group de CloudFormation); esos requieren redeploy/reprovisión.

---

## Auditoría

- El panel respeta `auditEnabled`: cuando está activo, el backend registra logs estructurados de `room.create` y `token.issue` con `{slug, userId|guest-opaco, ip, rol, ts}` (DESIGN §5/§13).
- Los joins/leaves reales **no** se auditan en MVP (requieren webhooks LiveKit → roadmap).
- Cambiar `auditEnabled` aquí activa/desactiva ese registro de inmediato (tras guardar).
- Métricas asociadas: counters in-memory `meet_rooms_created`, `meet_tokens_issued` (se resetean al reiniciar el proceso single-node — documentado).
- Recomendable (no MVP): registrar el propio cambio de `MeetSettings` (quién/cuándo activó-desactivó Meet) en un log de actividad admin.

---

## QA (checklist verificable)

- [ ] La pestaña "Reuniones" aparece en `/admin` solo para admin.
- [ ] Un usuario no-admin recibe 403 al pegar a `GET/PATCH /api/admin/meet/settings`.
- [ ] `GET` carga el singleton con sus defaults la primera vez (Meet OFF).
- [ ] Marcar `enabled` + Guardar hace que `/api/config/public` devuelva `meetEnabled:true`.
- [ ] Desmarcar `enabled` dispara `confirm()` de alto impacto antes de guardar.
- [ ] Con `enabled=false`, la sección "Reuniones" de Ajustes y los controles Meet del calendario/scheduling desaparecen.
- [ ] `wsUrl` que no empieza con `wss://` es rechazada (400) con mensaje claro.
- [ ] `publicBaseUrl` que no empieza con `https://` es rechazada (400).
- [ ] `maxParticipants` por encima del techo de infra se clampa y la UI muestra el valor efectivo tras guardar.
- [ ] `maxDurationMinutes` fuera de rango (5–720) es rechazado.
- [ ] El aviso de "requiere redeploy" es visible junto a los campos de dominio.
- [ ] Activar `enabled` sin `LIVEKIT_*` en backend: los endpoints Meet siguen respondiendo "disabled" (documentado, no rompe).
- [ ] `auditEnabled` ON genera logs de room.create/token.issue; OFF los suprime.
- [ ] Guardar deshabilita el botón ("Guardando…") y recarga el singleton al terminar.
- [ ] Error de validación muestra mensaje y conserva los valores editados.
- [ ] Consola del navegador sin errores/warnings al navegar la pestaña y guardar.
