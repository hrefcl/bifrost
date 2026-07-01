# Funcional 06 — Ajustes · Sección "Reuniones" (Bifrost Meet)

> Fase 0 — Contrato funcional pre-implementación. Fuente de verdad: `docs/meet/DESIGN.md` (v2.3).
> Pantalla: nueva entrada de NAV en `SettingsView.vue`. Preferencias por usuario en `UserPreferences.meet`.

---

## Información general

- **Nombre:** Ajustes → Reuniones (Bifrost Meet, preferencias por usuario).
- **Objetivo:** Permitir que cada usuario autenticado configure cómo se comporta Bifrost Meet en *sus* eventos y reservas: si se crea sala automáticamente, qué nombre se muestra, si usa una sala personal persistente o una efímera por evento, y un mensaje de invitación por defecto.
- **Descripción funcional:** Sección dentro de la pantalla de Ajustes (patrón NAV lateral idéntico a "Apariencia", "Firma", "Seguridad"). Lee las preferencias del usuario desde `auth.user.preferences.meet` al montar y las persiste con `PATCH /auth/me/preferences` enviando el objeto `meet`. Es **solo configuración de preferencias**, no crea ni administra salas. La sección **solo es visible** cuando el administrador tiene Bifrost Meet habilitado globalmente (`config.meetEnabled === true`, leído de `GET /api/config/public` en el boot del SPA).
- **Tipo de usuario:** Cualquier usuario autenticado (rol `user` o `admin`). No requiere rol admin.
- **Permisos:** Autenticado (`requiresAuth: true`, hook JWT global). Cada usuario solo edita sus propias preferencias (`request.user.userId`); no hay acceso cruzado a otros tenants/usuarios.
- **Ruta:** `/settings` con sección activa `meet` (estado interno `section.value = 'meet'`; no hay sub-ruta propia, el patrón actual de `SettingsView` conmuta secciones por estado local, no por URL).
- **Breadcrumbs:** `Ajustes › Reuniones`.
- **Relación con otras pantallas:**
  - **Admin → Meet** (`07-admin-meet.md`): el master gate (`MeetSettings.enabled`) controla la **visibilidad** de esta sección. Si Meet está OFF, la entrada NAV "Reuniones" no se renderiza.
  - **CalendarView / SchedulingView:** la preferencia `autoCreateOnEvent` y `roomMode` determinan si y cómo se adjunta una sala al crear eventos/tipos de evento con Meet.
  - **PublicBookingView / correo / ICS:** `displayName` y `defaultInviteMessage` alimentan los textos que ve el invitado.
  - **Store `auth`:** la fuente local de las prefs (`auth.user.preferences.meet`) se actualiza tras guardar.

---

## Diseño funcional

- **Layout:** Reutiliza el layout de `SettingsView.vue`: `AppLayout` → contenedor `.settings` con dos columnas. Izquierda `nav.settings-nav` (título "Ajustes" + lista de botones NAV). Derecha `.settings-content` con el contenido de la sección activa. Se agrega un nuevo ítem a `NAV`: `{ id: 'meet', icon: 'video' }` (icono `video` ya previsto en `AppIcon.vue` por el diseño Meet). El ítem se inserta condicionado a `meetEnabled`.
- **Secciones (dentro del contenido "Reuniones"):**
  1. **Encabezado:** `h2.section-h` "Reuniones" + `p.section-desc` explicando que son preferencias personales para videollamadas Bifrost Meet.
  2. **Creación automática** (`.row`): toggle/checkbox `autoCreateOnEvent` — "Crear sala automáticamente al agendar".
  3. **Nombre visible** (`.row`): input de texto `displayName` — nombre que verán los participantes (default: nombre de la cuenta).
  4. **Modo de sala** (`.row`): control segmentado (`.segmented` con dos `.seg`) `roomMode` — "Por evento" (`per_event`) vs "Sala personal" (`personal`).
  5. **Mensaje de invitación** (`.row` o bloque): textarea `defaultInviteMessage` — texto opcional que se añade a la invitación.
  6. **Barra de guardado** (`.save-row`): botón primario "Guardar" + feedback "Guardado" / mensaje de error.
- **Estado vacío:** Si el usuario nunca configuró Meet, `auth.user.preferences.meet` es `undefined` → se aplican defaults (ver Formularios). No hay "empty state" visual; el formulario se muestra con valores por defecto.
- **Estado de carga:** Las prefs vienen ya cargadas en el store `auth` (no hay fetch propio al entrar). Durante el guardado, `saving = true` deshabilita el botón y muestra "Guardando…".
- **Estado de error:** Si `PATCH` falla, se muestra `span.err` con el mensaje i18n `settings.meet.error`. Si Meet está deshabilitado globalmente, la sección directamente no existe (no es un estado de error sino de no-visibilidad).

---

## Componentes

### NAV item "Reuniones"
- **Descripción:** Botón en la barra NAV de Ajustes que activa la sección Meet.
- **Visibilidad:** Solo si `meetEnabled === true` (config pública). Renderizado con `v-if`/filtro sobre el array `NAV`.
- **Permisos:** Autenticado.
- **Validaciones:** N/A.
- **Estados:** `active` cuando `section === 'meet'` (clase `.nav-item.active`).
- **Eventos:** `@click` → `section = 'meet'`.
- **Acciones:** Cambia la sección visible.

### Toggle "Crear sala automáticamente" (`autoCreateOnEvent`)
- **Descripción:** Checkbox que determina si, al crear eventos/reservas con Meet habilitado, se adjunta una sala sin pedirlo explícitamente.
- **Visibilidad:** Siempre dentro de la sección.
- **Permisos:** Autenticado.
- **Validaciones:** Booleano; sin validación adicional.
- **Estados:** marcado / desmarcado; deshabilitado mientras `saving`.
- **Eventos:** `v-model` sobre ref local `autoCreateOnEvent`.
- **Acciones:** Marca el formulario como "sucio" (habilita Guardar).

### Input "Nombre visible" (`displayName`)
- **Descripción:** Texto del nombre que se muestra a otros participantes en la llamada.
- **Visibilidad:** Siempre.
- **Permisos:** Autenticado.
- **Validaciones:** Longitud máx. 60 caracteres; se hace `trim`; vacío permitido (cae al default backend = nombre de cuenta).
- **Estados:** normal / foco / deshabilitado al guardar.
- **Eventos:** `v-model`.
- **Acciones:** Marca formulario sucio.

### Segmentado "Modo de sala" (`roomMode`)
- **Descripción:** Selección entre sala efímera por evento (`per_event`) o sala personal persistente (`personal`).
- **Visibilidad:** Siempre.
- **Permisos:** Autenticado.
- **Validaciones:** Enum estricto `'per_event' | 'personal'`.
- **Estados:** opción activa con clase `.seg.on`; deshabilitado al guardar.
- **Eventos:** `@click` por opción → setea `roomMode`.
- **Acciones:** Marca formulario sucio. (Nota informativa bajo el control: en modo `personal` el link es estable y reutilizable; en `per_event` cada evento genera un slug nuevo que expira.)

### Textarea "Mensaje de invitación" (`defaultInviteMessage`)
- **Descripción:** Texto libre opcional añadido al correo/invitación de la reunión.
- **Visibilidad:** Siempre.
- **Permisos:** Autenticado.
- **Validaciones:** Longitud máx. 500 caracteres; opcional; `trim`. El backend sanea HTML si correspondiera (se guarda como texto plano).
- **Estados:** normal / foco / deshabilitado al guardar.
- **Eventos:** `v-model`.
- **Acciones:** Marca formulario sucio.

### Bloque de feedback
- **Descripción:** `span.ok` "Guardado" y `span.err` con mensaje de error.
- **Visibilidad:** `v-if="saved"` / `v-if="error"`.
- **Estados:** efímero (`saved` se limpia al volver a editar).

---

## Botones

### Guardar
- **Texto:** "Guardar" (i18n `settings.meet.save`); "Guardando…" mientras persiste (`settings.meet.saving`).
- **Icono:** Ninguno (botón primario de texto, clase `.primary-btn`).
- **Ubicación:** Final de la sección, en `.save-row`.
- **Habilitado:** Cuando `!saving`. (Opcionalmente, solo si el formulario está "sucio"; el patrón actual de `SettingsView.signature` no exige dirty, basta `!saving`.)
- **Deshabilitado:** Mientras `saving === true` (clase `:disabled`, opacidad reducida).
- **Acción:** Llama `saveMeetPrefs()` → `PATCH /auth/me/preferences` con `{ meet: { autoCreateOnEvent, displayName, roomMode, defaultInviteMessage } }`.
- **Confirmaciones:** Ninguna (acción no destructiva).
- **Mensajes:** Éxito → "Guardado" (`settings.meet.saved`). Error → `settings.meet.error`.
- **Navegación:** Permanece en la misma sección; no navega.

---

## Formularios

### Campo: `autoCreateOnEvent`
- **Nombre:** Crear sala automáticamente al agendar.
- **Tipo:** Checkbox (boolean).
- **Obligatorio:** No.
- **Default:** `false`.
- **Placeholder:** N/A.
- **Validaciones:** Booleano.
- **Longitud:** N/A.
- **Ayuda:** "Adjunta una videollamada Bifrost Meet automáticamente cuando creás un evento o recibís una reserva con Meet activado."
- **Formato:** `true|false`.
- **Errores:** N/A (no falla individualmente; error global de guardado).

### Campo: `displayName`
- **Nombre:** Nombre visible.
- **Tipo:** Input text.
- **Obligatorio:** No.
- **Default:** Vacío en el form → el backend usa el nombre de la cuenta si queda vacío.
- **Placeholder:** Nombre de la cuenta del usuario (ej. "Ada Lovelace").
- **Validaciones:** `trim`; máx. 60 caracteres.
- **Longitud:** 0–60.
- **Ayuda:** "Así te verán los demás participantes en la llamada."
- **Formato:** Texto plano.
- **Errores:** "El nombre no puede superar 60 caracteres" (validación cliente) / error global de guardado.

### Campo: `roomMode`
- **Nombre:** Modo de sala.
- **Tipo:** Segmentado (enum select).
- **Obligatorio:** Sí (siempre tiene un valor).
- **Default:** `per_event`.
- **Placeholder:** N/A.
- **Validaciones:** `∈ {'per_event','personal'}`.
- **Longitud:** N/A.
- **Ayuda:** "Por evento: una sala efímera por reunión (link nuevo, expira). Sala personal: un link estable y reutilizable."
- **Formato:** String enum.
- **Errores:** Valor fuera de enum → rechazado por backend (400); no debería ocurrir desde la UI.

### Campo: `defaultInviteMessage`
- **Nombre:** Mensaje de invitación.
- **Tipo:** Textarea.
- **Obligatorio:** No.
- **Default:** Vacío.
- **Placeholder:** "Ej.: Te espero en la videollamada, cualquier duda escribime."
- **Validaciones:** `trim`; máx. 500 caracteres; texto plano (sin HTML).
- **Longitud:** 0–500.
- **Ayuda:** "Se incluye al final de la invitación/correo de la reunión."
- **Formato:** Texto plano.
- **Errores:** "Máximo 500 caracteres" / error global de guardado.

---

## UX / UI

- **Flujo normal:** Usuario abre Ajustes → ve "Reuniones" en NAV (porque Meet está ON) → entra → ajusta toggle/nombre/modo/mensaje → "Guardar" → ve "Guardado" → el store `auth` refleja las nuevas prefs de inmediato.
- **Flujos alternativos:**
  - Meet OFF globalmente → la entrada "Reuniones" no aparece; si el usuario llega por estado obsoleto, la sección no se renderiza (no hay datos huérfanos).
  - Usuario sin prefs previas → defaults; al guardar se crea el objeto `meet`.
  - Cambio de `roomMode` de `personal` a `per_event` → no destruye salas existentes; solo cambia el comportamiento de creación futura.
- **Casos borde:**
  - Nombre con solo espacios → `trim` lo deja vacío → backend cae al nombre de cuenta.
  - Mensaje con 500+ chars → validación cliente bloquea o trunca; el backend reafirma el límite.
  - Doble click en Guardar → botón deshabilitado durante `saving` evita reenvío.
- **Loading:** Botón "Guardando…" + deshabilitado; resto del form deshabilitado durante el guardado.
- **Feedback:** "Guardado" verde efímero; error rojo persistente hasta nueva edición.
- **Confirmaciones:** No requeridas (no destructivo).
- **Mensajes:** i18n namespace `settings.meet.*` (`title`, `desc`, `autoCreate`, `displayName`, `roomMode`, `roomModePerEvent`, `roomModePersonal`, `inviteMessage`, `save`, `saving`, `saved`, `error`).
- **Accesibilidad:** Inputs con `<label>` asociado; segmentado navegable por teclado; textarea con `aria-multiline`; foco visible. Contraste según tokens del tema.
- **Navegación:** Conmutación por estado local; sin recarga. Permanece dentro de `/settings`.
- **Responsive:** Hereda el layout responsive de `SettingsView` (nav lateral colapsa en pantallas chicas según el patrón existente del proyecto).

---

## Reglas de negocio

- **Restricciones:** La sección solo es visible y editable cuando `MeetSettings.enabled === true` (master gate vía `GET /api/config/public`). Si Meet está OFF, las prefs `meet` pueden existir en BD pero no se exponen para edición.
- **Permisos:** Autenticado; cada usuario solo sus prefs (`userId`). Sin acción admin.
- **Dependencias:** `auth` store (prefs locales), config pública (`meetEnabled`), endpoint `PATCH /auth/me/preferences`.
- **Validaciones:** Enum `roomMode`; longitudes `displayName`≤60, `defaultInviteMessage`≤500; `autoCreateOnEvent` boolean.
- **Automatizaciones:** `autoCreateOnEvent` y `roomMode` son consumidos por `createBooking()` / calendario para decidir creación y tipo de sala (ver DESIGN §6). Esta pantalla **no** ejecuta esa lógica, solo persiste la preferencia.
- **Integraciones:** Indirecta con agenda/calendario/correo/ICS a través de las prefs guardadas.

---

## Casos de uso

- **Exitoso:** Usuario activa "Crear sala automáticamente", deja modo "Por evento", guarda → futuras reservas con Meet generan sala efímera automáticamente.
- **Alternativos:**
  - Usuario elige "Sala personal" para tener un link fijo que comparte siempre el mismo → guarda OK.
  - Usuario define `displayName` distinto a su nombre de cuenta → se refleja en la llamada.
- **Error:** `PATCH` falla por red/backend → muestra error, no altera el store; el usuario reintenta.
- **Cancelaciones:** El usuario sale de la sección sin guardar → los cambios locales se descartan (no hay persistencia hasta Guardar).
- **Reintentos:** Tras error, "Guardar" vuelve a estar habilitado; reintento idempotente (mismo payload).
- **No permitidas:** Editar prefs de otro usuario (no existe ruta para ello); enviar `roomMode` fuera de enum (400); acceder a la sección con Meet OFF (no se renderiza).

---

## APIs

### `GET /api/config/public`
- **Endpoint:** `/api/config/public`
- **Método:** GET
- **Parámetros:** Ninguno.
- **Respuesta:** `{ meetEnabled: boolean, livekitWsUrl: string, meetPublicBaseUrl: string }`.
- **Errores:** N/A (siempre responde; si Meet OFF → `meetEnabled:false`).
- **Permisos:** Público (`requiresAuth:false`). Consumido en el boot del SPA para decidir visibilidad de la sección.

### `GET /auth/me` (contexto)
- **Endpoint:** `/auth/me`
- **Método:** GET
- **Parámetros:** Ninguno (JWT).
- **Respuesta:** Usuario con `preferences.meet?: { autoCreateOnEvent, displayName?, roomMode, defaultInviteMessage? }`.
- **Errores:** 401 sin token.
- **Permisos:** Autenticado. (La sección lee de `auth.user.preferences`, ya cargado en sesión.)

### `PATCH /auth/me/preferences`
- **Endpoint:** `/auth/me/preferences`
- **Método:** PATCH
- **Parámetros (body):** `{ meet: { autoCreateOnEvent: boolean, displayName?: string, roomMode: 'per_event'|'personal', defaultInviteMessage?: string } }`. Merge parcial con el resto de preferencias (firma, etc.) — solo se envía/actualiza la clave `meet`.
- **Respuesta:** Objeto de preferencias actualizado y saneado (incluye `meet`).
- **Errores:** 400 (validación: enum/longitud); 401 (sin auth).
- **Permisos:** Autenticado; solo sobre `request.user.userId`.

---

## Modelo de datos

- **Entidades:** `UserPreferences` (objeto embebido en `User`), clave nueva `meet`.
- **Relaciones:** `User (1) → UserPreferences (1)`; `UserPreferences.meet` ⇄ comportamiento de `MeetRoom`/`createBooking` (la preferencia influye, no almacena salas).
- **Campos (`UserPreferences.meet`):**
  - `autoCreateOnEvent: boolean` (default `false`).
  - `displayName?: string` (opcional, ≤60).
  - `roomMode: 'per_event' | 'personal'` (default `per_event`).
  - `defaultInviteMessage?: string` (opcional, ≤500).
- **Persistencia:** Mongo (documento `User`, sub-objeto `preferences.meet`), vía `PATCH /auth/me/preferences`. DTO en `@webmail6/shared` (`UserPreferences.meet`). Campo opcional → backward compatible (usuarios sin Meet no se ven afectados).

---

## Auditoría

- Esta pantalla **no** genera auditoría de salas (eso ocurre en backend al crear sala/emitir token, gobernado por `MeetSettings.auditEnabled` — ver `07-admin-meet.md` y DESIGN §5/§13).
- El cambio de preferencias se trata como un `PATCH` de perfil estándar; no se registra log estructurado de Meet por editar prefs.
- Si en el futuro se requiere trazabilidad de cambios de preferencias, se sumaría al log de actividad de cuenta (fuera de alcance MVP).

---

## QA (checklist verificable)

- [ ] Con Meet ON (`meetEnabled:true`), la entrada NAV "Reuniones" aparece en Ajustes.
- [ ] Con Meet OFF, la entrada NAV "Reuniones" **no** se renderiza.
- [ ] Al entrar sin prefs previas, el form muestra defaults (`autoCreateOnEvent=false`, `roomMode=per_event`, campos vacíos).
- [ ] Al entrar con prefs existentes, el form carga los valores guardados desde `auth.user.preferences.meet`.
- [ ] Guardar envía `PATCH /auth/me/preferences` con la clave `meet` correctamente formada.
- [ ] Tras guardar OK, se muestra "Guardado" y `auth.user.preferences.meet` queda actualizado en memoria.
- [ ] `displayName` >60 caracteres es rechazado/limitado.
- [ ] `defaultInviteMessage` >500 caracteres es rechazado/limitado.
- [ ] `roomMode` solo acepta `per_event` o `personal`; valor inválido → 400.
- [ ] Botón "Guardar" se deshabilita y muestra "Guardando…" durante la petición.
- [ ] Error de red muestra mensaje y permite reintento sin perder los valores ingresados.
- [ ] El merge parcial NO borra otras preferencias (firma, apariencia) al guardar `meet`.
- [ ] Un usuario no puede editar preferencias de otro (sin ruta; aislamiento por `userId`).
- [ ] Consola del navegador sin errores/warnings tras navegar y guardar.
