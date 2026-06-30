# 04 · Configuración de Bifrost Meet en el Tipo de Evento (Host)

> **Fase 0 — Contrato funcional pre-implementación.** Fuente de verdad: `docs/meet/DESIGN.md` (v2.3). Pantalla de referencia: `packages/web/src/views/SchedulingView.vue` (modal de tipo de evento, sección Location).

---

## Información general

- **Nombre:** Toggle "Incluir Bifrost Meet" en el tipo de evento.
- **Objetivo:** Permitir al host (dueño de la agenda) marcar un tipo de evento para que **todas sus reservas generen automáticamente una sala de videollamada Bifrost Meet**, sin tener que pegar manualmente un enlace de Zoom/Meet externo.
- **Descripción funcional:** Dentro del modal de creación/edición de un tipo de evento (`SchedulingView.vue`), en la sección **Location**, se añade un control de tipo switch/checkbox **"Incluir Bifrost Meet"**. Al activarlo se establece `EventType.meetEnabled = true`. Cuando está activo:
  - El campo manual `location.value` (URL/dirección) queda **deshabilitado e ignorado** para este tipo: el enlace de la reunión lo genera el sistema en cada reserva.
  - En cada `createBooking()` de este tipo de evento, el backend pre-asigna un `slug` y crea una `MeetRoom` (`source: 'booking'`), horneando `meetUrl = ${publicBaseUrl}/meet/<slug>` dentro del `snapshot.location` inmutable del Booking.
  - El enlace generado **reemplaza** cualquier `location.value` manual en el snapshot, el evento de calendario, el correo y el ICS.
  - El toggle solo es visible/operable si `location.type === 'video'` (Meet es videollamada por definición).
- **Tipo de usuario:** Autenticado — **host** (dueño del tipo de evento; `requiresAuth: true`).
- **Permisos:** JWT válido; `request.user.userId` debe ser el dueño del `EventType`. Multitenant estricto por `userId`.
- **Gating:** El control solo se muestra/habilita si la feature global está activa: `GET /api/config/public → meetEnabled === true`. Con Meet OFF, el toggle no se renderiza y los tipos existentes conservan `meetEnabled` sin efecto (degradado limpio).
- **Ruta:** `/scheduling` (pestaña **Tipos**), modal de tipo de evento (crear/editar).
- **Breadcrumbs:** `Agenda (Scheduling) › Tipos de evento › [Nuevo tipo | Editar tipo] › Sección Ubicación (Location)`.
- **Relación con otras pantallas:**
  - **PublicBookingView** (doc 05): consume el `meetEnabled` del tipo para mostrar el enlace tras reservar.
  - **CalendarView**: checkbox equivalente "Agregar Bifrost Meet" para eventos manuales.
  - **SettingsView › Reuniones**: preferencias `meet` del host (modo de sala, displayName, mensaje de invitación).
  - **AdminView › AdminMeetPanel**: enable/disable global, dominio/wsUrl, maxParticipants. Si admin desactiva Meet, este toggle desaparece.

---

## Diseño funcional

### Layout
Modal centrado (`.modal__box`, ~420px, scroll vertical) abierto desde la pestaña **Tipos** al pulsar "+ Nuevo tipo" o "Editar". Campos en columna. La sección **Location** agrupa:
1. Selector **Tipo de ubicación** (`location.type`: video / presencial / teléfono / personalizado).
2. **Toggle "Incluir Bifrost Meet"** (NUEVO) — visible solo cuando `location.type === 'video'` y `meetEnabled` global activo.
3. Campo **Valor de ubicación** (`location.value`) — se **deshabilita** y muestra texto de ayuda cuando el toggle está activo.

### Secciones
- **Encabezado del modal:** título "Nuevo tipo de evento" / "Editar tipo de evento".
- **Datos básicos:** nombre, slug, duración, color.
- **Ubicación (Location):** tipo + toggle Meet + valor.
- **Reglas de reserva:** buffers, antelación mínima, rango de fechas, límite diario, horario.
- **Acciones:** Cancelar / Guardar.

### Estados
- **Vacío:** al crear, `meetEnabled` parte en `false` (default del modelo) y `location.type = 'video'`.
- **Carga:** mientras `store.fetchEventTypes()` resuelve, el modal no se abre; spinner/`loading` a nivel vista.
- **Carga de config Meet:** mientras `GET /api/config/public` no resuelve en el boot, el toggle se renderiza deshabilitado (o ausente) hasta conocer `meetEnabled`.
- **Error:** si guardar falla, se muestra `typeError` (mensaje del backend o `scheduling.error`) sobre las acciones del modal; el modal permanece abierto con los datos.

---

## Componentes

| Componente | Descripción | Visibilidad | Permisos | Validaciones | Estados | Eventos | Acciones |
|---|---|---|---|---|---|---|---|
| **Toggle "Incluir Bifrost Meet"** | Switch/checkbox que setea `form.meetEnabled` | Solo si `meetEnabledGlobal === true` **y** `form.location.type === 'video'` | Host JWT | Ninguna intrínseca; si se cambia `location.type` ≠ video, se fuerza `meetEnabled=false` | on / off / oculto | `change` → set `form.meetEnabled` | Activa/desactiva auto-generación de sala |
| **Selector Tipo de ubicación** (`location.type`) | `<select>` video/in_person/phone/custom | Siempre | Host JWT | Valor ∈ enum | — | `change` → si ≠ video, ocultar y resetear toggle | Determina visibilidad del toggle |
| **Campo Valor de ubicación** (`location.value`) | Input de URL/dirección manual | Siempre | Host JWT | Texto libre | Habilitado / **Deshabilitado** (cuando toggle ON) | `input` | Manual cuando Meet OFF; ignorado cuando Meet ON |
| **Texto de ayuda Meet** | Nota: "El enlace se generará automáticamente en cada reserva" | Solo con toggle ON | Host JWT | — | — | — | Informativo |
| **Botón Guardar** | Persiste el tipo de evento (`createEventType`/`updateEventType`) | Siempre | Host JWT | Form válido | normal / enviando | `click` → `saveType()` | Persiste incluyendo `meetEnabled` |

---

## Botones

| Texto | Icono | Ubicación | Habilitado | Deshabilitado | Acción | Confirmaciones | Mensajes | Navegación |
|---|---|---|---|---|---|---|---|---|
| **Guardar** | — (`.btn`) | Pie del modal | Siempre que el form tenga título y slug | Mientras envía | `saveType()` → `store.createEventType`/`updateEventType` con `meetEnabled` | No | Éxito: cierra modal; error: `typeError` | Permanece en `/scheduling` (Tipos) |
| **Cancelar** | — | Pie del modal | Siempre | — | Cierra modal sin guardar | No | — | Permanece en `/scheduling` |
| **+ Nuevo tipo** | `+` | Cabecera pestaña Tipos | Siempre | — | `openCreateType()` | No | — | Abre modal |
| **Editar** | — | Card de tipo | Siempre | — | `openEditType(id)` | No | — | Abre modal con datos |
| **(Toggle) Incluir Bifrost Meet** | `video` (`AppIcon`) | Sección Location | Solo si gating cumplido | Si `location.type ≠ video` o Meet OFF global | Set `form.meetEnabled` | No | Ayuda contextual | — |

---

## Formularios

### Campo: Tipo de ubicación (`location.type`)
- **Nombre:** Tipo de ubicación · **Tipo:** select · **Obligatorio:** sí · **Default:** `video` · **Placeholder:** — · **Validaciones:** ∈ {video, in_person, phone, custom} · **Longitud:** — · **Ayuda:** "Cómo se realizará la reunión." · **Formato:** enum · **Errores:** valor fuera de enum → rechazo backend.

### Campo: Incluir Bifrost Meet (`meetEnabled`)
- **Nombre:** Incluir Bifrost Meet · **Tipo:** toggle/checkbox (boolean) · **Obligatorio:** no · **Default:** `false` · **Placeholder:** — · **Validaciones:** solo editable si `location.type === 'video'` y Meet global activo; al cambiar tipo a ≠ video se fuerza `false` · **Longitud:** — · **Ayuda:** "Genera automáticamente una sala de videollamada Bifrost Meet para cada reserva de este tipo. Reemplaza el enlace manual." · **Formato:** boolean · **Errores:** ninguno (campo opcional, idempotente).

### Campo: Valor de ubicación (`location.value`)
- **Nombre:** Valor de ubicación · **Tipo:** text/url · **Obligatorio:** no (ignorado si `meetEnabled`) · **Default:** `''` · **Placeholder:** "https://… o dirección" · **Validaciones:** texto libre; **deshabilitado** cuando `meetEnabled` ON · **Longitud:** límite razonable (p. ej. ≤ 2048) · **Ayuda:** con Meet ON → "Se ignora: el enlace se genera por reserva." · **Formato:** string · **Errores:** —.

*(Resto de campos del modal — nombre, slug, duración, color, buffers, antelación, rango, límite diario, horario — son preexistentes y no se documentan aquí.)*

---

## UX / UI

- **Flujo normal:**
  1. Host abre `/scheduling` › Tipos › "+ Nuevo tipo" (o Editar).
  2. Selecciona `location.type = video`.
  3. Aparece el toggle **"Incluir Bifrost Meet"**; lo activa.
  4. El campo Valor de ubicación se deshabilita y muestra la ayuda.
  5. Pulsa **Guardar** → `meetEnabled: true` persistido.
- **Flujos alternativos:**
  - Cambia `location.type` a no-video → el toggle desaparece y `meetEnabled` se fuerza a `false` (no se permite Meet sin video).
  - Edita un tipo que ya tenía `meetEnabled: true` → el toggle aparece activo y `location.value` deshabilitado.
- **Casos borde:**
  - Meet desactivado globalmente (admin) tras haber configurado tipos: el toggle no se renderiza; los bookings dejan de generar sala (degradado) sin romper la agenda.
  - Host sin `username` configurado: puede igualmente marcar el toggle; el enlace público depende del slug global de la sala, no del username.
- **Loading:** boot carga `GET /api/config/public` antes de habilitar el toggle.
- **Feedback:** al guardar con éxito, modal se cierra; en la lista, la card muestra el tipo de ubicación (video). Errores en `typeError`.
- **Confirmaciones:** no se requiere confirmación para activar/desactivar el toggle (cambio reversible y no destructivo; las salas ya generadas en bookings pasados no se alteran).
- **Mensajes:** ayuda contextual junto al toggle; error genérico `scheduling.error` / mensaje del backend.
- **Accesibilidad:** toggle con `<label>` asociado, navegable por teclado, `aria-checked`; el campo deshabilitado expone `aria-disabled`.
- **Navegación:** todo ocurre dentro del modal; no cambia de ruta.
- **Responsive:** modal con `max-height: 90vh` y scroll; columna única apta para móvil.

---

## Reglas de negocio

- **Restricciones:**
  - `meetEnabled` solo puede ser `true` si `location.type === 'video'`.
  - El enlace de Meet **reemplaza** `location.value` en el snapshot del booking; nunca coexisten dos ubicaciones.
  - El toggle solo aplica a tipos de evento del host autenticado (multitenant por `userId`).
- **Permisos:** JWT host; el `EventType` debe pertenecer a `request.user.userId`.
- **Dependencias:** feature global `MeetSettings.enabled` + `LIVEKIT_*` presentes; `GET /api/config/public.meetEnabled`.
- **Validaciones:** backend ignora/rechaza `meetEnabled: true` si el tipo no es `video` (defensa servidor además del cliente).
- **Automatizaciones:** al guardar `meetEnabled: true`, no se crea sala alguna en este momento; la sala se crea **por reserva** dentro de `createBooking()` (slug pre-Booking, `MeetRoom` write requerido, cero RPC LiveKit en el lock). La sala LiveKit real se auto-crea al primer join.
- **Integraciones:** modelo `EventType` (+`meetEnabled`), `booking-service.ts` (hook), `MeetRoom`, correo/ICS.

---

## Casos de uso

- **Exitoso:** Host marca "Incluir Bifrost Meet" en un tipo video y guarda → futuros bookings generan sala y enlace automáticamente.
- **Alternativos:**
  - Host edita y desmarca el toggle → `meetEnabled: false`; futuros bookings usan `location.value` manual (o ninguno). Bookings ya creados conservan su enlace (snapshot inmutable).
  - Host cambia `location.type` a teléfono → toggle desaparece, `meetEnabled` queda `false`.
- **Error:** Guardado falla (red/validación) → `typeError`, modal abierto, sin pérdida de datos.
- **Cancelaciones:** Host pulsa Cancelar → no se persiste ningún cambio del toggle.
- **Reintentos:** Reintentar Guardar es idempotente sobre `meetEnabled` (boolean).
- **No permitidas:** Activar Meet en tipo no-video; activar Meet con feature global OFF (el control no existe); editar el `meetEnabled` de un tipo de otro host (rechazo por `userId`).

---

## APIs

> Los endpoints de tipos de evento son los existentes de la agenda; este doc solo añade el campo `meetEnabled` al payload.

### Crear tipo de evento
- **Endpoint:** `POST /api/schedule/event-types` (vía `store.createEventType`)
- **Método:** POST · **Auth:** JWT host
- **Parámetros (body):** `{ slug, title, durationMinutes, color, location:{type,value}, ..., meetEnabled?: boolean }`
- **Respuesta:** `EventTypeDto` incluyendo `meetEnabled`.
- **Errores:** 401 sin auth; 422 validación (incl. `meetEnabled:true` con tipo ≠ video → coerción a false o error).
- **Permisos:** dueño `userId`.

### Editar tipo de evento
- **Endpoint:** `PATCH /api/schedule/event-types/:id` (vía `store.updateEventType`)
- **Método:** PATCH · **Auth:** JWT host
- **Parámetros:** parcial, p. ej. `{ meetEnabled: true }` o `{ active }`.
- **Respuesta:** `EventTypeDto` actualizado.
- **Errores:** 401, 403 (no es dueño), 404 (no existe), 422.
- **Permisos:** dueño `userId`.

### Config pública (gating del toggle)
- **Endpoint:** `GET /api/config/public`
- **Método:** GET · **Auth:** público
- **Respuesta:** `{ meetEnabled, livekitWsUrl, meetPublicBaseUrl }`
- **Errores:** —
- **Permisos:** público.

---

## Modelo de datos

- **Entidades:**
  - `EventType` (+ campo nuevo `meetEnabled: boolean`, default `false`).
  - `MeetRoom` (creada por reserva, no aquí): `userId`, `slug` (unique global), `bookingId` (unique parcial), `source:'booking'`, `mode:'per_event'`, `status`, `maxParticipants`, `expiresAt`.
  - `MeetSettings` (singleton SystemConfig `meet`): `enabled`, `wsUrl`, `publicBaseUrl`, `maxParticipants`, `allowExternal`…
- **Relaciones:**
  - `EventType.meetEnabled` → condiciona el hook de `createBooking()` que crea `MeetRoom` y hornea `meetUrl` en `Booking.snapshot.location`.
  - `MeetRoom.bookingId` 1:1 con `Booking` (idempotencia).
- **Campos:** ver tabla `MeetRoom` en DESIGN §4.
- **Persistencia:** Mongoose; `meetEnabled` opcional/no destructivo (rollback = revertir rama). Sin migraciones SQL.

---

## Auditoría

- Cambios de `meetEnabled` siguen la auditoría normal de edición de `EventType` (no se añade evento de auditoría específico de Meet en esta pantalla).
- La auditoría de Meet (`auditEnabled`) se registra en **room.create** y **token.issue** (slug, userId, ip, rol, ts) — eso ocurre en el flujo de reserva/join, no en la configuración del tipo.
- No se exponen secretos (`LIVEKIT_API_KEY/SECRET`) en ninguna respuesta de esta pantalla.

---

## QA (checklist verificable)

- [ ] Con Meet global OFF (`config.public.meetEnabled=false`), el toggle **no** se renderiza en el modal.
- [ ] Con Meet global ON y `location.type=video`, el toggle aparece y es operable.
- [ ] Activar el toggle deshabilita el campo `location.value` y muestra la ayuda.
- [ ] Cambiar `location.type` a no-video oculta el toggle y fuerza `meetEnabled=false`.
- [ ] Guardar un tipo con toggle ON persiste `meetEnabled:true` (verificable en `EventTypeDto`).
- [ ] Editar un tipo con `meetEnabled:true` reabre el modal con toggle activo y `value` deshabilitado.
- [ ] Backend rechaza/coerce `meetEnabled:true` cuando `location.type ≠ video`.
- [ ] Un host no puede modificar `meetEnabled` de un tipo de otro `userId` (403/404).
- [ ] Tras activar y crear una reserva del tipo, el booking trae `snapshot.location.type='video'` con `meetUrl` (slug) horneado.
- [ ] Desactivar el toggle no altera el enlace de bookings ya creados (snapshot inmutable).
- [ ] Sin errores en consola del navegador (F12) al abrir/guardar el modal.
- [ ] El toggle es accesible por teclado y expone estado `aria-checked`.
