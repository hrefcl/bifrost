# 05 · Reserva Pública con Bifrost Meet (Invitado / Guest)

> **Fase 0 — Contrato funcional pre-implementación.** Fuente de verdad: `docs/meet/DESIGN.md` (v2.3). Pantalla de referencia: `packages/web/src/views/public/PublicBookingView.vue` (asistente de reserva en 4 pasos, paso "confirmado").

---

## Información general

- **Nombre:** Enlace de Bifrost Meet en la confirmación de reserva pública.
- **Objetivo:** Que el invitado (guest) que reserva un tipo de evento con `meetEnabled` reciba el **enlace de la videollamada** de forma segura: visible en el **paso 4 (confirmado)** del asistente y también por **correo + ICS**.
- **Descripción funcional:** En `PublicBookingView.vue` el invitado completa el flujo de 4 pasos (1=fecha, 2=hora, 3=datos, 4=confirmado). Si el tipo de evento reservado tiene `meetEnabled = true`, el backend ya horneó `snapshot.location.value = ${publicBaseUrl}/meet/<slug>` al crear el Booking. En el **paso 4** se muestra el enlace "Unirse a la videollamada" tomado del `Booking` devuelto (`confirmed.snapshot.location.value` cuando `type === 'video'`). El mismo enlace llega por correo de confirmación y queda en el VEVENT del ICS (`URL`/`LOCATION`).
  - **Privacidad (secreto post-reserva):** el enlace **solo se revela DESPUÉS de reservar**. Nunca aparece en los pasos 1–3 ni en la metadata pública del tipo de evento (`GET /schedule/public/:userSlug/:eventSlug`). El slug es `randomBytes(16).base64url`, no enumerable, 404 idéntico si no existe.
  - **Reagendar:** crea un Booking nuevo que **hereda el mismo snapshot** → **mismo enlace de Meet** preservado.
  - **Cancelar:** marca el Booking `cancelled` y **cierra la sala** (`MeetRoom.status: closed` + `deleteRoom` best-effort).
- **Tipo de usuario:** Público — invitado/guest (no autenticado).
- **Permisos:** Ruta pública (`meta.guestOk` / `config.requiresAuth: false`). No requiere JWT. Acceso al enlace = posesión del secreto (slug) entregado tras reservar.
- **Gating:** Solo se muestra bloque Meet si el tipo reservado tenía `meetEnabled` y el Booking trae `snapshot.location.type === 'video'` con un `value` de tipo `…/meet/<slug>`. Con Meet OFF o degradado, no aparece bloque y la confirmación funciona igual (sin enlace).
- **Ruta:** `/u/:userSlug/:eventSlug` (asistente de reserva). El enlace de Meet apunta a `/meet/:slug` (ruta pública de join, `MeetJoinView.vue`).
- **Breadcrumbs:** `Perfil público (/u/:userSlug) › Tipo de evento (:eventSlug) › Reservar › Confirmado`.
- **Relación con otras pantallas:**
  - **Doc 04 (SchedulingView):** el host activa `meetEnabled`; sin eso, este flujo no muestra enlace.
  - **MeetJoinView / MeetCallView** (`/meet/:slug`): destino del enlace; pre-join (nombre, preview cam/mic) y sala estilo Google Meet.
  - **Gestión de reserva** (`/booking/:managementToken`): cancelar/reagendar; reagendar preserva el enlace, cancelar cierra la sala.
  - **Correo/ICS:** el worker de email lee `snapshot.location.value` y añade el bloque "Unirse".

---

## Diseño funcional

### Layout
Asistente de una sola columna dentro de `PublicLayout`. Cabecera con título del tipo, duración y etiqueta de ubicación. Cuerpo por pasos:
- **Paso 1–2 (`.picker`):** navegación de día + grilla de horarios (`.slots`).
- **Paso 3 (`.formstep`):** formulario invitado (nombre, email, teléfono, preguntas personalizadas).
- **Paso 4 (`.done`):** check ✓, "¡Reunión confirmada!", email de confirmación, fecha/hora, **bloque enlace Meet (NUEVO)** y enlace de gestión.

### Secciones
- **Cabecera:** `ev.title`, `durationMinutes`, `locLabel[ev.location.type]` (p. ej. "Videollamada"). **No** muestra el enlace (pre-reserva).
- **Bloque Meet (paso 4):** título "Unirse a la videollamada", botón/enlace al `…/meet/<slug>`, botón "Copiar enlace", nota "También te lo enviamos por correo."

### Estados
- **Vacío (sin slots):** "No hay horarios disponibles este día."
- **Carga:** "Cargando…" (boot del tipo) y "Buscando horarios…" (slots).
- **Error de carga:** `serverError` → "Algo salió mal"; `loadErr`/404 → "Reunión no encontrada".
- **Confirmado sin enlace (degradado):** paso 4 normal sin bloque Meet; nota "Revisa tu correo para los detalles" (el correo tampoco traerá enlace si la sala falló).
- **Confirmado con enlace:** paso 4 con bloque Meet visible.

---

## Componentes

| Componente | Descripción | Visibilidad | Permisos | Validaciones | Estados | Eventos | Acciones |
|---|---|---|---|---|---|---|---|
| **Bloque "Unirse a la videollamada"** | Muestra el enlace `…/meet/<slug>` desde `confirmed.snapshot.location` | Solo en paso 4 y solo si `confirmed.snapshot.location.type==='video'` y `value` presente | Público (posee el secreto) | `value` no vacío y formato `…/meet/<slug>` | visible / oculto (degradado) | — | Abrir/copiar enlace |
| **Enlace/Botón "Unirse"** | `<a target="_blank">` al join | Con bloque Meet | Público | — | normal | `click` | Navega a `/meet/:slug` |
| **Botón "Copiar enlace"** | Copia el `value` al portapapeles | Con bloque Meet | Público | — | normal / "Copiado" | `click` → `navigator.clipboard` | Copia URL |
| **Grilla de horarios** (`.slots`) | Slots disponibles | Pasos 1–2 | Público | Slot ∈ disponibles | cargando / vacío / lista | `click pickSlot` | Avanza a paso 3 |
| **Formulario invitado** (`.formstep`) | Nombre/email/teléfono/preguntas | Paso 3 | Público | `canSubmit` | normal / enviando | `submit` | Crea Booking |
| **Confirmación** (`.done`) | Check + datos + enlace gestión | Paso 4 | Público | — | — | — | Mostrar resultado |

---

## Botones

| Texto | Icono | Ubicación | Habilitado | Deshabilitado | Acción | Confirmaciones | Mensajes | Navegación |
|---|---|---|---|---|---|---|---|---|
| **Confirmar reunión** | — (`.primary`) | Paso 3 | Si `canSubmit` y no `submitting` | Datos inválidos o enviando | `submit()` → `POST …/book` | No | "Confirmando…"; error en `submitError` | Éxito → paso 4 |
| **Unirse a la videollamada** | `video` | Paso 4, bloque Meet | Si hay enlace | Sin enlace (degradado) | Abre `/meet/:slug` en pestaña nueva | No | — | `MeetJoinView` |
| **Copiar enlace** | `copy` | Paso 4, bloque Meet | Si hay enlace | — | Copia `value` | No | "Enlace copiado" | — |
| **Gestionar reserva** | — (`.managelink`) | Paso 4 | Si `manageToken` | Sin token (replay idempotente) | Abre `/booking/:token` | No | Fallback: "usa el enlace del correo" | Gestión |
| **‹ Cambiar horario** | — (`.back`) | Paso 3 | Siempre | — | `step = 2` | No | — | Vuelve a horarios |
| **‹ / ›** (día) | — (`.ghost`) | Pasos 1–2 | `›` siempre; `‹` si `dayOffset>0` | `‹` en hoy | `changeDay(±1)` | No | — | Cambia día |

---

## Formularios

### Campo: Nombre
- **Nombre:** Nombre · **Tipo:** text · **Obligatorio:** sí · **Default:** `''` · **Placeholder:** — · **Validaciones:** `.trim()` no vacío · **Longitud:** ≤ 200 · **Ayuda:** — · **Formato:** texto · **Errores:** bloquea `canSubmit`.

### Campo: Email
- **Nombre:** Email · **Tipo:** email · **Obligatorio:** sí · **Default:** `''` · **Placeholder:** — · **Validaciones:** regex `/.+@.+\..+/` · **Longitud:** ≤ 320 · **Ayuda:** "Aquí recibirás el enlace de la videollamada." · **Formato:** email · **Errores:** bloquea `canSubmit`.

### Campo: Teléfono
- **Nombre:** Teléfono · **Tipo:** tel · **Obligatorio:** no · **Default:** `''` · **Placeholder:** — · **Validaciones:** — · **Longitud:** ≤ 64 · **Ayuda:** — · **Formato:** tel · **Errores:** —.

### Campo: Preguntas personalizadas (`customQuestions[]`)
- **Nombre:** label de cada pregunta · **Tipo:** textarea · **Obligatorio:** según `q.required` · **Default:** vacío · **Placeholder:** — · **Validaciones:** si `required`, `.trim()` no vacío · **Longitud:** ≤ 4096 · **Ayuda:** — · **Formato:** texto · **Errores:** bloquea `canSubmit`.

> El enlace de Meet **no** es un campo de formulario: es salida de solo lectura en el paso 4. El invitado no lo introduce ni lo ve antes de confirmar.

---

## UX / UI

- **Flujo normal:**
  1. Invitado abre `/u/:userSlug/:eventSlug` → ve título y "Videollamada" (sin enlace).
  2. Elige día (paso 1) y hora (paso 2).
  3. Completa datos (paso 3) y pulsa **Confirmar reunión**.
  4. Paso 4: "¡Reunión confirmada!" + **bloque "Unirse a la videollamada"** con el enlace `…/meet/<slug>`.
  5. El mismo enlace llega por correo + ICS.
- **Flujos alternativos:**
  - **Reagendar** (desde correo o `/booking/:token`): nuevo Booking hereda snapshot → **mismo enlace**; el invitado puede seguir usando el link original.
  - **Cancelar:** Booking `cancelled`, `MeetRoom.status: closed`; el enlace deja de mintear tokens (join responde 403/404).
  - **Replay idempotente** (mismo `Idempotency-Key`): devuelve el mismo Booking y **el mismo** enlace/sala (no se crea una nueva); `managementToken` puede venir `null` → fallback "usa el correo".
- **Casos borde:**
  - **Degradado:** la sala no se pudo crear → Booking confirmado sin `type:'video'` ni enlace; paso 4 sin bloque Meet; correo sin bloque "Unirse". Nunca se muestra `type:'video'` sin URL.
  - **Slot ocupado (409):** vuelve a paso 2, recarga slots, mensaje "Ese horario ya no está disponible".
  - **Servicio ocupado (503):** mensaje "Servicio ocupado, intenta de nuevo".
  - **Ventana temporal:** el enlace existe desde la confirmación, pero el **token de join** solo se emite dentro de `startAt − 15min ≤ now ≤ endAt + 30min`; fuera de ventana, `MeetJoinView` informa "La sala aún no está disponible / la reunión terminó".
- **Loading:** "Cargando…", "Buscando horarios…", "Confirmando…".
- **Feedback:** check ✓, copia con "Enlace copiado", errores en `.err`.
- **Confirmaciones:** ninguna extra para ver/copiar el enlace.
- **Mensajes:** ver tabla de errores APIs.
- **Accesibilidad:** slots con `aria-pressed`; enlace Meet como `<a>` con texto descriptivo; botón copiar con feedback textual; foco gestionado al avanzar de paso.
- **Navegación:** "Unirse" abre `/meet/:slug` en pestaña nueva (no pierde la confirmación).
- **Responsive:** columna única, grilla de slots `auto-fill minmax(92px)`, apto móvil.

---

## Reglas de negocio

- **Restricciones:**
  - El enlace de Meet **solo** se expone tras crear el Booking (secreto post-reserva). Jamás en pasos 1–3 ni en la metadata pública del tipo.
  - El enlace es **inmutable**: vive en `snapshot.location.value`; reschedule lo hereda; nada lo reescribe.
  - El bloque Meet aparece solo si `snapshot.location.type === 'video'` con `value` presente.
- **Permisos:** ruta pública; el join posterior valida sala existente + backlink (Booking no `cancelled`) + ventana temporal + `allowExternal` (forzado `true` en salas de booking).
- **Dependencias:** `EventType.meetEnabled` (doc 04), `createBooking()` que hornea `meetUrl`, `MeetRoom` write requerido, `GET /api/config/public`.
- **Validaciones:** `canSubmit` (cliente) + revalidación de slot e idempotencia (servidor). El enlace no se valida en cliente (viene del backend).
- **Automatizaciones:**
  - Al confirmar, el backend (dentro del lock, cero RPC LiveKit) crea la `MeetRoom` y hornea el enlace; la sala LiveKit real se auto-crea al primer join.
  - Reschedule: migra `MeetRoom.bookingId` y recalcula `expiresAt = newEndAt + 30min`, conservando el slug.
  - Cancel: `MeetRoom.status: closed` + `deleteRoom` best-effort.
- **Integraciones:** correo (`sendBookingEmail` + `buildIcs`), CalendarEvent (`meetUrl`/`meetRoomId`), LiveKit (join).

---

## Casos de uso

- **Exitoso:** Invitado reserva un tipo `meetEnabled` → paso 4 muestra el enlace; correo + ICS lo incluyen; al unirse dentro de ventana, entra a la sala.
- **Alternativos:**
  - Reagenda → mismo enlace sigue válido en el nuevo Booking.
  - Replay idempotente → mismo enlace, sin sala duplicada.
- **Error:** Sala no creada (degradado) → confirmación sin enlace, correo sin bloque "Unirse"; el host recibe alerta/log.
- **Cancelaciones:** Invitado/host cancela → sala cerrada; intentar unirse → 403/404 ("La reunión fue cancelada").
- **Reintentos:** Reintento de `submit` con mismo `Idempotency-Key` → mismo Booking + enlace; reintento de join re-fetch del token (reconexión breve) antes del expiry.
- **No permitidas:**
  - Ver/adivinar el enlace antes de reservar (no enumerable, 404 idéntico).
  - Mintear token de join fuera de la ventana temporal (403).
  - Unirse a sala de un Booking `cancelled` (404 por backlink inválido).

---

## APIs

### Crear reserva (book)
- **Endpoint:** `POST /api/schedule/public/:userSlug/:eventSlug/book`
- **Método:** POST · **Auth:** público (`guestOk`)
- **Parámetros:** body `{ startAt, invitee:{name,email,timezone,phone?}, answers[] }`; header `Idempotency-Key`.
- **Respuesta:** `{ booking: Booking, managementToken: string|null }`. Si `meetEnabled`, `booking.snapshot.location = { type:'video', value:'…/meet/<slug>' }`.
- **Errores:** 409 slot ocupado; 503 servicio ocupado; 4xx datos inválidos. (Fallo de sala NO falla el booking → degradado.)
- **Permisos:** público; multitenant por slug.

### Metadata pública del tipo (pre-reserva)
- **Endpoint:** `GET /api/schedule/public/:userSlug/:eventSlug`
- **Método:** GET · **Auth:** público
- **Respuesta:** `PublicEventType` (título, duración, `location.type`, preguntas) — **sin enlace de Meet**.
- **Errores:** 404 no encontrado; 5xx server.
- **Permisos:** público.

### Metadata pública de la sala (al unirse)
- **Endpoint:** `GET /api/meet/public/:slug`
- **Método:** GET · **Auth:** público
- **Respuesta:** metadata mínima de la sala. **404 idéntico** si no existe/`closed`.
- **Errores:** 404; rate-limit IP+slug 60/min.
- **Permisos:** público.

### Token de invitado (join)
- **Endpoint:** `POST /api/meet/public/:slug/token`
- **Método:** POST · **Auth:** público (fail-closed)
- **Parámetros:** body `{ name? }` (metadata; identidad real = `guest-<random>` opaca).
- **Respuesta:** `MeetTokenResponse` (AccessToken efímero, grants externo sin `roomAdmin`, TTL = ventana+gracia).
- **Errores:** 403 fuera de ventana / `allowExternal=false`; 404 sala inexistente o backlink (Booking) `cancelled`/ausente; 429 rate-limit (20/min IP+slug).
- **Permisos:** público; gate ventana temporal + backlink válido.

### Config pública
- **Endpoint:** `GET /api/config/public`
- **Método:** GET · **Auth:** público
- **Respuesta:** `{ meetEnabled, livekitWsUrl, meetPublicBaseUrl }`.
- **Permisos:** público.

---

## Modelo de datos

- **Entidades:**
  - `Booking` (fuente de verdad) con `snapshot.location` **inmutable**; cuando `meetEnabled`, `value = …/meet/<slug>`.
  - `MeetRoom`: `slug` (unique global), `bookingId` (unique parcial), `source:'booking'`, `mode:'per_event'`, `status:'active'|'closed'`, `maxParticipants`, `allowExternalOverride:true`, `expiresAt = endAt+30m`.
  - `CalendarEvent`: `meetRoomId?`, `meetUrl?` (misma URL horneada).
- **Relaciones:**
  - `Booking 1:1 MeetRoom` (por `bookingId`); reschedule migra `bookingId` al nuevo Booking conservando slug.
  - `MeetRoom ↔ CalendarEvent` por `meetRoomId`.
- **Campos:** ver DESIGN §4.
- **Persistencia:** Mongoose; enlace inmutable en snapshot; cancel = `status:closed` (soft, no hard-delete).

---

## Auditoría

- **room.create** y **token.issue** se registran si `MeetSettings.auditEnabled`: slug, identidad opaca (`guest-<random>`), IP, rol, timestamp. Los joins reales (entrada efectiva a la sala) **no** se auditan en MVP (requieren webhooks LiveKit — roadmap).
- El correo/ICS de confirmación queda en el flujo de email del Booking (no expone secretos LiveKit).
- El enlace en sí no es secreto criptográfico de servidor, pero el **token** de join nunca viaja en frontend salvo el AccessToken efímero emitido por backend.

---

## QA (checklist verificable)

- [ ] En pasos 1–3 el enlace de Meet **no** aparece en ningún punto del DOM ni en la respuesta de `GET …/:eventSlug`.
- [ ] Tras confirmar un tipo `meetEnabled`, el paso 4 muestra el bloque "Unirse a la videollamada" con `…/meet/<slug>`.
- [ ] El enlace mostrado coincide exactamente con `confirmed.snapshot.location.value`.
- [ ] El correo de confirmación y el ICS contienen el mismo enlace (`URL`/`LOCATION` del VEVENT).
- [ ] Botón "Copiar enlace" copia la URL y da feedback "Enlace copiado".
- [ ] "Unirse" abre `/meet/:slug` en pestaña nueva.
- [ ] Reagendar genera un Booking nuevo con **el mismo** enlace de Meet.
- [ ] Cancelar cierra la sala (`status:closed`); intentar unirse responde 403/404.
- [ ] Replay idempotente (mismo `Idempotency-Key`) devuelve el mismo enlace/sala, sin duplicar `MeetRoom`.
- [ ] Degradado (sala no creada): paso 4 sin bloque Meet, booking confirmado igual, sin `type:'video'` sin URL.
- [ ] Token de join fuera de ventana (`< startAt−15m` o `> endAt+30m`) → 403.
- [ ] Slug inexistente o de Booking cancelado → 404 idéntico (no enumerable).
- [ ] Sin errores en consola (F12) en el paso 4 con y sin enlace.
- [ ] El enlace de Meet es accesible (enlace `<a>` con texto descriptivo, navegable por teclado).
