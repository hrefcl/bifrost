# 03 · Bifrost Meet en el formulario de eventos del Calendario

> **Fase 0 — Documentación funcional (contrato pre-implementación).** Fuente de verdad: `docs/meet/DESIGN.md` (v2.3). Pantalla base: `packages/web/src/views/CalendarView.vue`. Este documento describe la integración de Bifrost Meet en el modal de creación/edición y en el modal de detalle de eventos del calendario.

---

## Información general

- **Nombre:** Integración Bifrost Meet en Calendario (checkbox "Agregar Bifrost Meet" + link de reunión en detalle de evento).
- **Objetivo:** Permitir que un usuario autenticado adjunte (o quite) una sala de videollamada Bifrost Meet a un evento de su calendario desde el mismo modal de creación/edición, y consultar/copiar el link de unión desde el modal de detalle.
- **Descripción funcional:** En el modal de crear/editar evento de `CalendarView.vue` se añade un checkbox "Agregar Bifrost Meet" ubicado junto al checkbox "Todo el día". El checkbox solo es visible si el sistema tiene Meet habilitado (`meetEnabled` proveniente de `GET /api/config/public`). Al guardar el evento con el checkbox activo, el frontend adjunta una sala mediante `POST /api/calendar/events/:id/meet`; el backend crea/asocia un `MeetRoom` y devuelve `meetUrl`/`meetRoomId`. En el modal de detalle del evento, si el evento tiene `meetUrl`, se muestra una fila con el link de la reunión y un botón "Copiar". Desmarcar el checkbox al editar (o usar el control de quitar) ejecuta `DELETE /api/calendar/events/:id/meet`. El comportamiento por defecto del checkbox y el modo de sala respetan la preferencia de usuario `meet.roomMode` (`per_event` vs `personal`).
- **Tipo de usuario:** Usuario autenticado dueño del evento (single-tenant, aislamiento por `userId`). No hay roles diferenciados en esta pantalla: cualquier usuario logueado gestiona sus propios eventos y salas.
- **Permisos requeridos:** Sesión JWT válida (`requiresAuth: true`). El usuario solo opera sobre eventos cuyo `userId` coincide con `request.user.userId` (endpoints owner-bound). No requiere rol admin. La funcionalidad Meet debe estar habilitada globalmente (`MeetSettings.enabled = true` y `LIVEKIT_*` presentes); de lo contrario el checkbox no se muestra.
- **Ruta:** `/calendar` (vista `CalendarView.vue`, `meta.requiresAuth: true`). Los modales de crear/editar y de detalle son overlays dentro de la misma ruta (no hay ruta hija propia).
- **Breadcrumbs:** `Inicio / Calendario`. Los modales no alteran el breadcrumb (son overlays).
- **Relación con otras pantallas:**
  - **SettingsView → sección "Reuniones":** define `UserPreferences.meet` (`autoCreateOnEvent`, `roomMode`, `displayName`, `defaultInviteMessage`) que determinan el default del checkbox y el `mode` de la sala creada (`02-settings-meet.md`).
  - **AdminView → AdminMeetPanel:** define `MeetSettings.enabled`, `maxParticipants`, `allowExternal`, etc.; controla si el checkbox es visible (`05-admin-meet.md`).
  - **MeetJoinView / MeetCallView (`/meet/:slug`):** destino del `meetUrl` mostrado en el detalle; pantalla pública de pre-join y llamada (`04-meet-join-call.md`).
  - **SchedulingView / PublicBookingView:** ruta paralela donde Meet se adjunta automáticamente a bookings de agenda (no es esta pantalla; aquí es calendario manual).

---

## Diseño funcional

### Layout

Dos overlays modales sobre la grilla de FullCalendar:

1. **Modal crear/editar** (`v-if="showCreate"`), ancho 380px, contiene en orden:
   - Título del modal: "Nuevo evento" / "Editar evento".
   - Input título del evento.
   - Grid 2 columnas: "Inicio" y "Fin" (datetime-local).
   - **Fila de checkboxes** (clase `.check`): checkbox "Todo el día" y, a su lado, el **nuevo checkbox "Agregar Bifrost Meet"** (visible solo si `meetEnabled`).
   - Input ubicación.
   - Textarea descripción.
   - Mensaje de error (`.err`) si aplica.
   - Pie: botones "Guardar" y "Cancelar".

2. **Modal detalle** (`v-if="detail"`), ancho 380px, borde superior coloreado por calendario, contiene:
   - Título (summary).
   - Fila fecha/hora.
   - Fila ubicación (si existe).
   - Fila calendario.
   - **Nueva fila Meet** (si `detail.meetUrl`): icono `video` + link de unión truncado + botón "Copiar".
   - Descripción (si existe).
   - Pie: botones "Editar" y "Eliminar".

### Secciones

- **Sección checkbox Meet (crear/editar):** un único checkbox aditivo en la fila de checkboxes. Sin sub-formulario. La leyenda muestra el `mode` resultante de forma implícita (ver Reglas de negocio): texto fijo "Agregar Bifrost Meet".
- **Sección link Meet (detalle):** read-only, solo lectura del `meetUrl` con acción de copiar. No editable desde aquí (se quita re-editando el evento o con la acción "Quitar Meet").

### Estados vacíos / carga / error

- **Vacío (Meet OFF global):** el checkbox NO se renderiza; la fila de detalle Meet NO se renderiza. La pantalla se comporta como el calendario actual sin Meet. Sin mensajes.
- **Carga de config:** mientras `GET /api/config/public` no haya respondido en el boot del store, `meetEnabled` es `false` por defecto ⇒ checkbox oculto hasta confirmar habilitado (fail-safe: nunca mostrar un control que el backend rechazaría).
- **Carga al guardar/adjuntar:** al pulsar "Guardar" con Meet activo, botón en estado `loading` (deshabilitado) mientras corre `PATCH evento` + `POST .../meet`. Spinner/disabled hasta resolver.
- **Carga al copiar:** feedback inmediato (cambia el texto/tooltip del botón a "Copiado").
- **Error adjuntar:** si `POST .../meet` falla, se muestra mensaje de error en `.err` del modal y el evento queda guardado SIN sala (no se bloquea el guardado del evento). Mensaje: "El evento se guardó, pero no se pudo crear la sala de reunión. Inténtalo de nuevo desde el detalle."
- **Error quitar:** si `DELETE .../meet` falla, se mantiene el link visible y se muestra error: "No se pudo quitar la reunión. Inténtalo de nuevo."
- **Estado degradado backend:** si `MeetSettings.enabled=false` en el momento del POST, el endpoint responde `200 {disabled:true}` y el frontend trata el evento como sin Meet (no muestra link, no error bloqueante).

---

## Componentes

### 1. Checkbox "Agregar Bifrost Meet"

- **Nombre:** `addMeetCheckbox` (modelo: `createForm.addMeet: boolean`).
- **Descripción:** Toggle que indica si el evento debe tener una sala Bifrost Meet adjunta al guardar.
- **Visibilidad:** Solo si `meetEnabled === true` (del store de config público). Oculto totalmente con Meet OFF.
- **Permisos:** Usuario autenticado dueño del evento. Sin permiso especial.
- **Validaciones:** Ninguna propia (booleano). No afecta la validación de rango de fechas existente.
- **Estados:** `unchecked` (default según preferencia), `checked`, `disabled` (mientras guarda).
- **Eventos:** `change` → actualiza `createForm.addMeet`. No dispara llamada de red inmediata; la acción ocurre en "Guardar".
- **Acciones:** Determina si tras guardar el evento se llama a `POST .../meet` (si pasó de off→on o evento nuevo con on) o `DELETE .../meet` (si en edición pasó de on→off).

### 2. Fila de link Meet (modal detalle)

- **Nombre:** `meetLinkRow`.
- **Descripción:** Muestra el `detail.meetUrl` (link público de unión `https://webmail.<dom>/meet/<slug>`) con un botón "Copiar".
- **Visibilidad:** Solo si `detail.meetUrl` tiene valor.
- **Permisos:** Dueño del evento (el detalle ya está filtrado por `userId`).
- **Validaciones:** N/A (solo lectura).
- **Estados:** `default`, `copied` (transitorio ~2s tras copiar).
- **Eventos:** click en "Copiar" → `navigator.clipboard.writeText(detail.meetUrl)`.
- **Acciones:** Copiar al portapapeles. El link en sí puede abrirse en nueva pestaña (target `_blank`, `rel="noopener"`).

### 3. Botón "Copiar"

- Ver sección **Botones**.

### 4. Botón "Quitar Meet" (opcional, en detalle o en edición)

- **Nombre:** `removeMeetButton`.
- **Descripción:** Quita la sala adjunta. En el modal de edición equivale a desmarcar el checkbox; en el detalle puede ofrecerse como acción explícita.
- **Visibilidad:** Solo si el evento tiene `meetRoomId`/`meetUrl`.
- **Permisos:** Dueño del evento.
- **Validaciones:** Confirmación previa (ver Botones).
- **Estados:** `default`, `loading`, `disabled`.
- **Eventos / Acciones:** `DELETE /api/calendar/events/:id/meet`.

---

## Botones

### Botón "Guardar" (modal crear/editar) — reutiliza el existente

- **Texto:** `t('calendar.save')` → "Guardar".
- **Icono:** Ninguno (botón `.create-btn`).
- **Ubicación:** Pie del modal crear/editar.
- **Habilitado:** Cuando `summary` no vacío y rango de fechas válido (`end > start`).
- **Deshabilitado:** Durante el guardado (estado loading) o con rango inválido.
- **Acción:** (1) PATCH/POST del evento (lógica existente `submitCreate`); (2) si `addMeet` cambió respecto al estado original, llamar `POST` o `DELETE` `.../meet` con el `id` del evento resultante.
- **Confirmaciones:** Ninguna al adjuntar. Al quitar (desmarcar en edición de un evento que tenía sala): confirmación "Se eliminará la sala de reunión y el link dejará de funcionar. ¿Continuar?".
- **Mensajes éxito:** Modal se cierra; el evento aparece con su link en el detalle. (Opcional toast "Reunión agregada".)
- **Mensajes error:** `.err` en el modal (ver Estados de error).
- **Navegación:** Cierra el modal, permanece en `/calendar`.

### Botón "Copiar" (modal detalle)

- **Texto:** "Copiar" (o icono solo); tras copiar: "Copiado".
- **Icono:** `copy` (de `AppIcon.vue`); opcional `check` en estado copiado.
- **Ubicación:** Fila de link Meet, al final del link.
- **Habilitado:** Siempre que haya `meetUrl`.
- **Deshabilitado:** N/A.
- **Acción:** Copia `meetUrl` al portapapeles.
- **Confirmaciones:** Ninguna.
- **Mensajes éxito:** Cambio transitorio de texto/tooltip a "Copiado" (~2s) + opcional toast.
- **Mensajes error:** Si `clipboard` falla: tooltip "No se pudo copiar; copia manualmente".
- **Navegación:** Ninguna.

### Botón "Quitar Meet" (opcional)

- **Texto:** "Quitar reunión".
- **Icono:** `x` o `videoOff`.
- **Ubicación:** Modal detalle (junto a la fila del link) o implícito por desmarcado en edición.
- **Habilitado:** Si el evento tiene sala.
- **Deshabilitado:** Durante la llamada DELETE.
- **Acción:** `DELETE /api/calendar/events/:id/meet`.
- **Confirmaciones:** "Se eliminará la sala y el link dejará de funcionar. ¿Continuar?".
- **Mensajes éxito:** La fila del link desaparece; opcional toast "Reunión eliminada".
- **Mensajes error:** "No se pudo quitar la reunión. Inténtalo de nuevo."
- **Navegación:** Permanece en el detalle/calendario.

---

## Formularios

El formulario base de evento (`createForm`) conserva sus campos existentes (summary, description, location, startDate, endDate, allDay). Se documenta únicamente el campo nuevo.

### Campo: `addMeet` (Agregar Bifrost Meet)

- **Nombre:** `addMeet` (label visible: "Agregar Bifrost Meet").
- **Tipo:** Checkbox booleano (`input[type=checkbox]`, patrón clase `.check`).
- **Obligatorio:** No.
- **Default:**
  - Evento nuevo: `UserPreferences.meet.autoCreateOnEvent` (si `true` ⇒ pre-marcado). Si la preferencia es `false`/ausente ⇒ desmarcado.
  - Evento en edición: refleja el estado real del evento (`true` si `event.meetRoomId` existe, `false` si no).
- **Placeholder:** N/A (checkbox).
- **Validaciones:** Ninguna. Independiente de las demás validaciones del formulario.
- **Longitud:** N/A.
- **Ayuda:** Tooltip/subtexto opcional: "Crea una sala de videollamada y agrega el link al evento." Si `roomMode = personal`, la ayuda indica "Se usará tu sala personal".
- **Formato:** Booleano. Persistido indirectamente vía la existencia de `MeetRoom`/`meetUrl` del evento (no es un campo propio del `CalendarEvent` más allá de `meetRoomId`/`meetUrl`).
- **Errores:** No genera errores de validación de formulario. Errores provienen de la llamada `POST/DELETE .../meet` (ver Estados/Botones).

---

## UX / UI

### Flujo normal (adjuntar al crear)

1. Usuario abre "Crear" (o arrastra rango) → modal con `addMeet` pre-marcado/desmarcado según preferencia.
2. Completa título/fechas, deja el checkbox "Agregar Bifrost Meet" marcado.
3. Pulsa "Guardar": se crea el evento (POST), se obtiene su `id`, se llama `POST /api/calendar/events/:id/meet`.
4. El backend crea el `MeetRoom` (mode según preferencia), setea `meetUrl`/`meetRoomId` y responde el evento actualizado.
5. Modal se cierra; al hacer click en el evento, el detalle muestra el link con botón "Copiar".

### Flujos alternativos

- **Adjuntar a evento existente sin sala:** abrir detalle → "Editar" → marcar checkbox → "Guardar" ⇒ `POST .../meet`.
- **Quitar sala existente:** abrir detalle → "Editar" → desmarcar checkbox → confirmar → "Guardar" ⇒ `DELETE .../meet`. (O botón "Quitar reunión" directo en el detalle.)
- **Copiar link:** detalle → "Copiar" ⇒ portapapeles.
- **Modo personal (`roomMode = personal`):** marcar el checkbox asocia el evento a la **sala personal persistente** del usuario (mismo slug reutilizado entre eventos); desmarcar solo desvincula el evento, NO cierra la sala personal.
- **Modo por evento (`roomMode = per_event`):** marcar crea una sala efímera nueva (`mode: per_event`, con `expiresAt`); desmarcar la cierra (`status: closed`).

### Casos borde

- **Meet se deshabilita globalmente entre crear y editar:** el checkbox deja de mostrarse; eventos con `meetUrl` previo siguen mostrando el link en el detalle (no se borra el dato), pero el link puede no mintear tokens (gate `meetEnabled`).
- **Evento sin guardar / id inexistente:** no se puede adjuntar Meet a un evento que aún no existe; el orden es siempre crear evento → luego adjuntar.
- **Idempotencia:** repetir `POST .../meet` sobre un evento que ya tiene sala devuelve la misma sala (no duplica).
- **Quitar una sala ya quitada:** `DELETE` idempotente, responde OK aunque no hubiese sala.
- **Fallo parcial:** evento guardado pero `POST .../meet` falla ⇒ evento existe sin sala; se informa al usuario y puede reintentar desde el detalle.
- **Doble click "Guardar":** botón deshabilitado durante loading evita doble POST.

### Loading

- Botón "Guardar" deshabilitado + indicador mientras corre la cadena evento→meet.
- Botón "Copiar"/"Quitar" deshabilitados durante su acción.

### Feedback

- Toasts opcionales: "Reunión agregada", "Reunión eliminada", "Link copiado".
- Estado "Copiado" transitorio en el botón.
- Mensajes de error inline en `.err`.

### Confirmaciones

- Solo al **quitar** una sala (acción destructiva del link). Adjuntar y copiar no requieren confirmación.

### Mensajes

- Éxito: silencioso (cierre de modal) o toast.
- Error adjuntar: "El evento se guardó, pero no se pudo crear la sala de reunión."
- Error quitar: "No se pudo quitar la reunión."
- Error copiar: "No se pudo copiar; copia manualmente."

### Accesibilidad

- Checkbox con `<label>` asociado (patrón `.check` existente), focusable por teclado, togglea con Espacio.
- Botón "Copiar" con `aria-label="Copiar link de la reunión"`; estado "Copiado" anunciado vía `aria-live="polite"`.
- Link de unión navegable por teclado, `rel="noopener"`.
- Confirmación de quitar accesible (foco atrapado en el diálogo).
- Contraste según tokens Bifrost (`--text-1/2`, `--accent`).

### Navegación

- Todo ocurre dentro de `/calendar` mediante overlays. El link de Meet abre `/meet/:slug` (pública) en nueva pestaña.

### Responsive

- Modal `max-width: calc(100vw - 32px)`; el checkbox Meet hereda la fila `.check` (wrap natural en pantallas estrechas). La fila del link en el detalle trunca el `meetUrl` con elipsis para no desbordar el modal de 380px.

---

## Reglas de negocio

- **Restricciones:**
  - El checkbox solo existe si `meetEnabled` (gate global `MeetSettings.enabled` + `LIVEKIT_*`).
  - Solo se adjunta Meet a eventos ya persistidos (con `id`).
  - El usuario solo gestiona Meet de sus propios eventos (owner-bound por `userId`).
- **Permisos:** JWT requerido. Sin rol admin. Sin scopes adicionales.
- **Dependencias:**
  - `GET /api/config/public` para conocer `meetEnabled`, `livekitWsUrl`, `meetPublicBaseUrl`.
  - `UserPreferences.meet.roomMode` y `autoCreateOnEvent` para defaults y `mode`.
  - Modelo `MeetRoom` + campos `CalendarEvent.meetRoomId`/`meetUrl`.
- **Validaciones:** Las del evento (rango de fechas, título). El adjuntar no añade validaciones de formulario.
- **Automatizaciones:**
  - `autoCreateOnEvent = true` ⇒ checkbox pre-marcado en eventos nuevos.
  - `roomMode = per_event` ⇒ sala efímera con `expiresAt = endAt + 30m`; `roomMode = personal` ⇒ reusa/crea sala persistente.
  - El `meetUrl` se proyecta también para email/ICS si el evento dispara correos (consistencia de URL con el snapshot).
- **Integraciones:**
  - Endpoints calendario-meet (`POST`/`DELETE .../meet`).
  - LiveKit (sala se auto-crea al primer join; esta pantalla NO llama a LiveKit, solo persiste el `MeetRoom`).
  - SettingsView (preferencias) y AdminMeetPanel (settings globales).

### Interacción con preferencia de usuario `roomMode`

| `roomMode` | Al marcar el checkbox | Al desmarcar | `MeetRoom.mode` | Slug |
|---|---|---|---|---|
| `per_event` (default) | Crea sala efímera nueva ligada al evento | `status: closed` (cierra la sala) | `per_event` | nuevo por evento |
| `personal` | Asocia el evento a la sala personal persistente del usuario (crea la personal si no existe) | Desvincula el evento; la sala personal sigue activa | `personal` | reutilizado |

`autoCreateOnEvent` controla únicamente el **valor por defecto** del checkbox en eventos nuevos; no fuerza la creación si el usuario lo desmarca.

---

## Casos de uso

- **Exitoso (crear con Meet):** usuario crea evento con checkbox activo → evento + sala creados → link visible y copiable en detalle.
- **Exitoso (quitar Meet):** usuario edita evento con sala, desmarca, confirma → sala cerrada/desvinculada, link desaparece.
- **Alternativo (modo personal):** usuario con `roomMode=personal` marca el checkbox en varios eventos → todos comparten el mismo link de su sala personal.
- **Alternativo (copiar y compartir):** usuario abre detalle, copia el link, lo pega en un correo/chat externo.
- **Error (fallo al adjuntar):** POST evento OK pero `POST .../meet` 5xx → evento sin sala + mensaje; reintento disponible.
- **Error (Meet deshabilitado en backend):** `POST .../meet` responde `{disabled:true}` → frontend no muestra link, sin error bloqueante.
- **Cancelación:** usuario cierra el modal (X/Cancel/click-fuera) antes de guardar → no se crea evento ni sala (reset defensivo de `editingId`).
- **Reintento:** tras fallo de adjuntar, reabrir detalle → editar → re-marcar → guardar.
- **No permitida:** intentar adjuntar Meet a un evento de otro usuario → backend responde 403/404 (owner-bound); la UI no expone eventos ajenos.

---

## APIs

> Prefijo de integración calendario-meet. Token LiveKit **nunca** se genera en esta pantalla.

### 1. `GET /api/config/public`

- **Endpoint:** `/api/config/public`
- **Método:** GET
- **Auth:** Público (`requiresAuth: false`).
- **Parámetros:** Ninguno.
- **Respuesta:** `{ meetEnabled: boolean, livekitWsUrl: string, meetPublicBaseUrl: string }`.
- **Errores:** 200 siempre (config runtime); ante error de boot, `meetEnabled: false`.
- **Permisos:** N/A.
- **Uso en pantalla:** decide visibilidad del checkbox y de la fila de link.

### 2. `POST /api/calendar/events/:id/meet`

- **Endpoint:** `/api/calendar/events/:id/meet`
- **Método:** POST
- **Auth:** JWT (owner-bound: `userId` del evento = `request.user.userId`).
- **Parámetros:** Path `id` (id del CalendarEvent). Body opcional `{ mode?: 'per_event'|'personal' }` (si se omite, usa `UserPreferences.meet.roomMode`).
- **Respuesta:** Evento actualizado con `meetRoomId`, `meetUrl` (o `{ disabled: true }` si Meet OFF global). Idempotente: si ya existe sala, la devuelve.
- **Errores:** 404 evento inexistente/ajeno; 403 sin permiso; 200 `{disabled:true}` si Meet deshabilitado; 5xx fallo al crear `MeetRoom`.
- **Permisos:** Dueño del evento.

### 3. `DELETE /api/calendar/events/:id/meet`

- **Endpoint:** `/api/calendar/events/:id/meet`
- **Método:** DELETE
- **Auth:** JWT (owner-bound).
- **Parámetros:** Path `id`.
- **Respuesta:** Evento actualizado sin `meetUrl`/`meetRoomId`. Idempotente (OK aunque no hubiera sala). En `per_event` cierra la sala (`status: closed` + `deleteRoom` best-effort); en `personal` solo desvincula el evento.
- **Errores:** 404 evento inexistente/ajeno; 403 sin permiso.
- **Permisos:** Dueño del evento.

### 4. (Referencia) `PATCH`/`POST /api/calendar/events/:id` — guardado del evento

- Endpoint existente del calendario (store `updateEvent`/`createEvent`). La cadena de guardado primero persiste el evento y luego invoca el endpoint meet. Documentado en la pantalla base de calendario.

---

## Modelo de datos

### Entidades

- **`MeetRoom`** (`packages/api/src/models/MeetRoom.ts`), `userId`-scoped:
  - `userId` (ObjectId, host).
  - `slug` (string, **único global**, `randomBytes(16).base64url`, no enumerable).
  - `name` (string).
  - `mode` (`'per_event' | 'personal'`).
  - `status` (`'active' | 'closed'`).
  - `source` (`'manual' | 'calendar' | 'booking'`) → en esta pantalla = `'calendar'`.
  - `calendarEventId?` (ObjectId, enlace al evento).
  - `bookingId?` (ObjectId, no aplica en calendario manual).
  - `maxParticipants` (number, de `MeetSettings`).
  - `allowExternalOverride?` (boolean).
  - `expiresAt?` / `purgeAt?` (Date; `per_event` expira a `endAt + 30m`).
- **`CalendarEvent`** (extendido): `+ meetRoomId?` (ObjectId), `+ meetUrl?` (string, URL pública con slug; no secreto).
- **`UserPreferences.meet`** (shared): `{ autoCreateOnEvent, displayName?, roomMode: 'per_event'|'personal', defaultInviteMessage? }`.
- **`MeetSettings`** (singleton SystemConfig key `meet`): `{ enabled, wsUrl, publicBaseUrl, maxParticipants, allowExternal, ... }`.

### Relaciones

- `CalendarEvent.meetRoomId` → `MeetRoom._id` (1:1 lógico; en `personal` un mismo `MeetRoom` puede estar referenciado por varios eventos).
- `MeetRoom.calendarEventId` → `CalendarEvent._id` (en `source: calendar`, modo `per_event`).
- `MeetRoom.userId` → `User._id` (host/tenant).

### Campos persistidos por esta pantalla

- Adjuntar: crea/asocia `MeetRoom` (`source: calendar`, `mode` según preferencia) y setea `CalendarEvent.meetRoomId` + `meetUrl`.
- Quitar: limpia `meetRoomId`/`meetUrl` del evento; `per_event` ⇒ `MeetRoom.status: closed`.

### Persistencia

- MongoDB (Mongoose 8). Índices `MeetRoom`: `{slug}` único global, `{userId, status}`, `{calendarEventId}`, `{purgeAt}` TTL largo opcional. El slug se reserva atómicamente; el `meetUrl = ${meetPublicBaseUrl}/meet/${slug}`.

---

## Auditoría

- **Eventos auditados** (cuando `MeetSettings.auditEnabled = true`), log estructurado:
  - `room.create` al adjuntar: `{ slug, userId, source:'calendar', mode, calendarEventId, ip, ts }`.
  - `room.close` al quitar (per_event): `{ slug, userId, calendarEventId, ts }`.
  - `token.issue` NO ocurre en esta pantalla (sucede en el join público).
- **Trazabilidad:** `MeetRoom` mantiene `source` y `calendarEventId` para correlacionar la sala con el evento de origen. Soft-lifecycle (`status: closed`, no hard-delete) preserva historial.
- **Métricas:** counter `meet_rooms_created` se incrementa al adjuntar (in-memory single-node; se resetea al reiniciar el proceso).
- **No auditado en MVP:** joins/leaves reales (requiere webhooks LiveKit — roadmap).

---

## QA (checklist verificable)

- [ ] Con `meetEnabled=false` (Meet OFF global): el checkbox NO aparece en crear/editar y la fila de link NO aparece en detalle.
- [ ] Con `meetEnabled=true`: el checkbox "Agregar Bifrost Meet" aparece junto al checkbox "Todo el día".
- [ ] Evento nuevo con `autoCreateOnEvent=true`: checkbox pre-marcado; con `false`: desmarcado.
- [ ] Crear evento con checkbox activo guarda el evento y luego llama `POST /api/calendar/events/:id/meet`.
- [ ] Tras adjuntar, el modal de detalle muestra la fila con `meetUrl` y botón "Copiar".
- [ ] Botón "Copiar" copia el `meetUrl` exacto al portapapeles y muestra estado "Copiado".
- [ ] El `meetUrl` apunta a `${meetPublicBaseUrl}/meet/<slug>` y abre la pantalla pública de join.
- [ ] Editar evento con sala muestra el checkbox marcado; desmarcar + guardar pide confirmación y llama `DELETE .../meet`.
- [ ] Tras quitar (per_event): la fila de link desaparece y la sala queda `status: closed`.
- [ ] `roomMode=personal`: marcar en dos eventos distintos produce el MISMO `meetUrl`; quitar uno NO afecta al otro ni cierra la sala personal.
- [ ] `roomMode=per_event`: cada evento marcado obtiene un slug/link distinto.
- [ ] Idempotencia: re-llamar `POST .../meet` sobre evento con sala no crea sala duplicada (devuelve la misma).
- [ ] Idempotencia: `DELETE .../meet` sobre evento sin sala responde OK sin error.
- [ ] Fallo de `POST .../meet`: el evento queda guardado sin sala y se muestra mensaje de error no bloqueante.
- [ ] Owner-bound: un usuario no puede adjuntar/quitar Meet en eventos de otro `userId` (403/404).
- [ ] Backend con `MeetSettings.enabled=false`: `POST .../meet` responde `{disabled:true}` y la UI no muestra link ni error bloqueante.
- [ ] Accesibilidad: checkbox togglea con teclado; botón "Copiar" con `aria-label` y estado anunciado.
- [ ] Responsive: en modal a 380px el `meetUrl` se trunca sin desbordar; el checkbox Meet hace wrap correcto.
- [ ] Cancelar el modal (X/Cancel/click-fuera) no crea evento ni sala; `editingId` se resetea (sin heredar edición previa).
- [ ] Auditoría: al adjuntar con `auditEnabled=true` se registra `room.create` con `source:'calendar'` y `calendarEventId`.
