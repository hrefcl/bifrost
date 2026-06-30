# Funcional · Pantalla de Pre-ingreso (Meet Join)

> **Fase 0 — Contrato pre-implementación.** Fuente de verdad: `docs/meet/DESIGN.md` (v2.3). Esta pantalla es la antesala pública de una videollamada Bifrost Meet. Componente: `packages/web/src/views/public/MeetJoinView.vue`.

---

## Información general

- **Nombre:** Pantalla de Pre-ingreso a la reunión (Meet Join / "Lobby").
- **Objetivo:** Permitir que cualquier persona con el link de la sala (`/meet/:slug`) configure su nombre visible (si es externa), revise y elija sus dispositivos de cámara/micrófono, vea un preview local antes de entrar, y solicite el token de acceso para unirse a la llamada.
- **Descripción funcional:** Pantalla pública (no requiere sesión) renderizada al abrir un link de Bifrost Meet. Carga la configuración pública de la instancia (`GET /api/config/public`) y la metadata mínima de la sala (`GET /api/meet/public/:slug`). Muestra un preview de cámara/micrófono usando `getUserMedia` local (sin LiveKit todavía), permite seleccionar dispositivos mediante `enumerateDevices`, y al pulsar **Unirse** solicita el AccessToken al backend (`POST /api/meet/public/:slug/token`). Si el token se emite correctamente, monta `MeetCallView.vue` para conectarse a LiveKit. El token **siempre se genera en backend**; el frontend nunca conoce el `LIVEKIT_API_SECRET`.
- **Tipo de usuario:** Invitado anónimo (externo), usuario interno autenticado, o host. La pantalla es la misma para los tres; la diferencia de grants la resuelve el backend al emitir el token (la identidad del participante siempre es **opaca**: `guest-<randomBytes(8)>`).
- **Permisos requeridos:** Ninguno a nivel de aplicación (`meta.guestOk = true`, ruta pública). El acceso real lo gobierna el backend: existencia de la sala, `allowExternal`, ventana temporal y cupo. El navegador debe conceder permisos de cámara/micrófono para el preview (opcional para unirse solo en audio/sin medios).
- **Ruta:** `/meet/:slug` (SPA, `meta.guestOk`). El `slug` es `randomBytes(16).base64url`, no enumerable. **Importante:** `/meet/:userSlug` (perfil de usuario) se re-mapea/redirige a `/u/:userSlug`; `/meet/:slug` queda reservado para salas Meet.
- **Breadcrumbs:** No aplica (pantalla pública full-width sin jerarquía de navegación). Se renderiza dentro de `PublicLayout` (marca del admin: logo + nombre + tagline).
- **Relación con otras pantallas:**
  - **Origen:** link en correo de confirmación/recordatorio de booking, ICS (`URL`/`LOCATION` del VEVENT), `PublicBookingView` (paso "confirmed"), `CalendarView` (modal detalle del evento), o link copiado manualmente.
  - **Destino:** `MeetCallView.vue` (pantalla in-call, doc `02-meet-call.md`) tras emisión exitosa del token.
  - **Errores terminales:** sin destino de navegación; se muestra un estado de error en la misma pantalla (404 idéntico, Meet deshabilitado, sala llena, externo no permitido, fuera de ventana).

---

## Diseño funcional

- **Layout:** Centrado, una sola columna sobre `PublicLayout`. Dos zonas principales apiladas (responsive: lado a lado en ≥768px, apiladas en móvil):
  1. **Panel de preview** (izquierda/arriba): recuadro de video con el stream local de cámara; superpuestos los selectores rápidos de dispositivo y los toggles mic/cam.
  2. **Panel de ingreso** (derecha/abajo): nombre de la sala, campo "Tu nombre" (solo si externo), selectores de dispositivo detallados y botón **Unirse**.
- **Secciones:**
  - **Encabezado:** nombre visible de la sala (de la metadata pública) y subtítulo contextual ("Listo para unirte" / "La reunión empieza en X").
  - **Preview de medios:** `<video>` con el track local en mute (autoplay, playsinline). Si la cámara está apagada o sin permiso → avatar/placeholder con iniciales del nombre.
  - **Controles de dispositivo:** dropdown de cámara, dropdown de micrófono, (opcional) dropdown de salida de audio; toggles de mute mic/cam pre-join.
  - **Formulario de identidad:** campo "Tu nombre" (solo externos; internos/host lo heredan de su perfil/preferencias).
  - **Acción primaria:** botón **Unirse**.
- **Paneles:** No hay paneles colapsables; todo visible en una vista. Mensajería de error reemplaza el panel de ingreso cuando el acceso está bloqueado.
- **Estados vacíos:**
  - Sin cámara/micrófono disponibles: el preview muestra placeholder "Sin cámara"; el botón Unirse permanece habilitado (se puede entrar sin medios y activarlos luego).
  - Sin dispositivos enumerados: selectores deshabilitados con texto "No se detectaron dispositivos".
- **Estados de carga:**
  - **Boot:** spinner mientras se resuelven `GET /api/config/public` + `GET /api/meet/public/:slug` (en paralelo).
  - **Preview:** skeleton/placeholder en el recuadro de video hasta que `getUserMedia` resuelve.
  - **Unirse:** botón en estado loading (spinner + texto "Conectando…") mientras se solicita el token y se establece la conexión inicial.
- **Estados de error** (todos mostrados in-place, sin redirección):
  - **Meet deshabilitado** (`config.meetEnabled = false` o respuesta `{disabled:true}`): mensaje "Las videollamadas no están disponibles en este servidor". Sin botón Unirse.
  - **Sala inexistente / cerrada** (`404`): mensaje **idéntico** "Esta reunión no existe o ya finalizó" (no se distingue inexistente de cerrada, por diseño anti-enumeración).
  - **Sala llena** (al pedir token, cap de `maxParticipants`): "La reunión alcanzó el máximo de participantes. Intenta más tarde."
  - **Externo no permitido** (`403`, `allowExternal=false` y no es interno): "Esta reunión solo admite participantes de la organización."
  - **Fuera de ventana temporal** (`403`, salas booking/calendar): "Aún no puedes unirte / la reunión ya cerró. Disponible entre [inicio−15min] y [fin+30min]."
  - **Permiso de medios denegado:** banner no bloqueante "No pudimos acceder a tu cámara/micrófono. Puedes unirte y activarlos después."
  - **Error de red / 5xx:** "No pudimos conectar con el servidor. Reintenta." con botón Reintentar.

---

## Componentes

### 1. `RoomHeader`
- **Nombre:** Encabezado de sala.
- **Descripción:** Muestra el nombre visible de la sala (`metadata.name`) y un subtítulo de estado (listo / cuenta regresiva / cerrado).
- **Visibilidad:** Siempre que la sala exista y Meet esté habilitado.
- **Permisos:** Público.
- **Validaciones:** El nombre proviene de metadata pública mínima; nunca expone `userId` ni datos de otros tenants.
- **Estados:** normal, fuera-de-ventana (subtítulo con horario), cerrado/404 (reemplazado por error).
- **Eventos:** ninguno interactivo.
- **Acciones:** ninguna.

### 2. `MediaPreview`
- **Nombre:** Preview de cámara/micrófono.
- **Descripción:** Recuadro `<video>` con el stream local de `getUserMedia({video, audio})`. Medidor de nivel de micrófono opcional. **No usa LiveKit**; es preview local puro.
- **Visibilidad:** Visible si Meet habilitado y sala válida.
- **Permisos:** Requiere permiso de navegador para cámara/micrófono (degradación elegante si se niega).
- **Validaciones:** Si `getUserMedia` falla → placeholder + banner; no bloquea Unirse.
- **Estados:** cargando, activo (cam on), cámara apagada (placeholder), sin permiso, sin dispositivo.
- **Eventos:** se re-inicializa al cambiar dispositivo seleccionado; se detiene (stop tracks) al desmontar o al pasar a `MeetCallView`.
- **Acciones:** liberar tracks locales al navegar a la llamada (evitar doble captura).

### 3. `DeviceSelectors`
- **Nombre:** Selectores de dispositivo.
- **Descripción:** Dropdowns para cámara, micrófono y (si disponible) salida de audio, poblados con `navigator.mediaDevices.enumerateDevices()`.
- **Visibilidad:** Visible siempre; opciones dependen de dispositivos detectados.
- **Permisos:** Las etiquetas de dispositivo solo aparecen tras conceder permiso de medios (comportamiento estándar del navegador).
- **Validaciones:** Si no hay dispositivos de un tipo → selector deshabilitado con texto vacío.
- **Estados:** poblado, vacío/deshabilitado, cambiando (re-adquiere preview).
- **Eventos:** `change` → re-inicializa `MediaPreview` con el `deviceId` elegido y persiste la elección (in-memory / `localStorage`) para pasarla a la llamada.
- **Acciones:** propaga los `deviceId` seleccionados a `MeetCallView` al unirse.

### 4. `DisplayNameField` (formulario)
- **Nombre:** Campo "Tu nombre".
- **Descripción:** Input de texto para el nombre visible del invitado externo. (Ver sección Formularios.)
- **Visibilidad:** Solo para externos (invitado sin sesión). Internos/host: oculto (nombre heredado de perfil/`UserPreferences.meet.displayName`).
- **Permisos:** Público.
- **Validaciones:** requerido para externos, 1–60 caracteres, se sanea (trim, sin control chars).
- **Estados:** vacío (Unirse deshabilitado), válido, error.
- **Eventos:** `input`/`blur` valida; habilita botón Unirse.
- **Acciones:** el nombre se envía como **metadata** del participante (nunca como identidad; la identidad es opaca y la asigna el backend).

### 5. `PreJoinToggles`
- **Nombre:** Toggles pre-ingreso de mic/cam.
- **Descripción:** Dos botones de alternancia para entrar con micrófono y/o cámara activados o silenciados desde el inicio.
- **Visibilidad:** Visible junto al preview.
- **Permisos:** Público.
- **Validaciones:** ninguna; estado puramente de UI que se traslada a la llamada.
- **Estados:** mic on/off, cam on/off.
- **Eventos:** `click` alterna; `cam off` apaga el track de preview.
- **Acciones:** define el estado inicial de publicación al conectar en `MeetCallView`.

### 6. `JoinButton`
- **Nombre:** Botón Unirse. (Ver sección Botones.)

### 7. `AccessErrorPanel`
- **Nombre:** Panel de error de acceso.
- **Descripción:** Reemplaza el panel de ingreso cuando el acceso está bloqueado (404 idéntico, deshabilitado, llena, externo no permitido, fuera de ventana, error de red).
- **Visibilidad:** Solo en estados de error terminal o reintentable.
- **Permisos:** Público.
- **Validaciones:** mapea el código/razón backend a un mensaje localizado (i18n `meet:`).
- **Estados:** terminal (sin acción), reintentable (botón Reintentar).
- **Eventos:** click en Reintentar → reintenta la solicitud de token/metadata.
- **Acciones:** Reintentar; copiar link de soporte (opcional).

---

## Botones

### Unirse
- **Texto:** "Unirse" (i18n `meet:join.cta`).
- **Icono:** `video` (de `AppIcon.vue`).
- **Ubicación:** Panel de ingreso, acción primaria (full-width inferior).
- **Habilitado cuando:** Meet habilitado, sala válida (200), y —si externo— el campo nombre es válido (1–60). Para internos/host: habilitado en cuanto la metadata carga.
- **Deshabilitado cuando:** carga en curso, nombre inválido/vacío (externo), Meet deshabilitado, o estado de error terminal.
- **Acción al click:** `POST /api/meet/public/:slug/token` con `{ displayName }` (externo). Al recibir `{ token, livekitWsUrl }` válido → libera tracks de preview y monta `MeetCallView` (`Room.connect(livekitWsUrl, token)`).
- **Confirmaciones:** Ninguna (acción directa). Si el navegador no concedió permisos de medios, no se bloquea: se une igual.
- **Mensajes éxito/error:**
  - Éxito: transición inmediata a la llamada (sin toast).
  - Error 404: "Esta reunión no existe o ya finalizó."
  - Error 403 externo: "Esta reunión solo admite participantes de la organización."
  - Error 403 ventana: "Disponible entre [inicio−15min] y [fin+30min]."
  - Error sala llena: "La reunión alcanzó el máximo de participantes."
  - Error red/5xx: "No pudimos conectar. Reintenta."
- **Navegación posterior:** Éxito → `MeetCallView` (in-call). Error → permanece en la misma pantalla mostrando `AccessErrorPanel` o banner.

### Reintentar (en `AccessErrorPanel`)
- **Texto:** "Reintentar".
- **Icono:** `refresh`.
- **Ubicación:** Panel de error (solo errores reintentables: red/5xx, sala llena, fuera de ventana).
- **Habilitado:** siempre que el error sea reintentable.
- **Deshabilitado:** durante el reintento en curso; oculto en errores terminales (404, deshabilitado, externo no permitido).
- **Acción al click:** repite `GET /api/meet/public/:slug` y/o `POST .../token`.
- **Confirmaciones:** ninguna.
- **Mensajes:** mismos mapeos de error.
- **Navegación posterior:** éxito → reanuda flujo de ingreso; error persiste in-place.

---

## Formularios

### Campo: "Tu nombre" (`displayName`)
- **Nombre:** `displayName`.
- **Tipo:** texto (input single-line).
- **Obligatorio:** Sí para externos; no aplica (oculto) para internos/host.
- **Default:** vacío para externos; para internos, prellenado con nombre de perfil / `UserPreferences.meet.displayName` (no editable o editable según preferencia).
- **Placeholder:** "Tu nombre" / "¿Cómo te llamas?".
- **Validaciones:** requerido (externo), `trim` no vacío, 1–60 caracteres, sin caracteres de control; se sanitiza para mostrar en etiquetas de tile. No se usa como identidad (la identidad es `guest-<random>` opaca, asignada por backend).
- **Longitud máx:** 60 caracteres.
- **Ayuda:** "Será visible para los demás participantes."
- **Formato:** texto plano; se aplica `maxlength` y saneo.
- **Comportamiento ante errores:** borde de error + mensaje "Ingresa tu nombre para unirte"; el botón Unirse permanece deshabilitado hasta corregir.

---

## UX / UI

- **Flujo normal:**
  1. El invitado abre el link → SPA carga `config.public` + `meet/public/:slug`.
  2. Se muestra preview de cámara/micrófono (tras conceder permisos) y selectores.
  3. (Externo) escribe su nombre; ajusta dispositivos y toggles mic/cam.
  4. Pulsa **Unirse** → backend emite token → transición a `MeetCallView`.
- **Flujos alternativos:**
  - **Interno/host:** no ve el campo nombre; puede unirse directamente. Grants superiores los aplica el backend (host: `roomAdmin`).
  - **Sin permiso de medios:** se une igual; activa cam/mic dentro de la llamada.
  - **Reingreso tras token expirado:** si llega desde un re-fetch fallido, se reabre esta pantalla o se reconecta (ver doc in-call).
- **Casos borde:**
  - Link compartido fuera de horario → 403 ventana con horario exacto (no se filtra existencia más allá del horario).
  - Slug huérfano (backlink Booking/CalendarEvent ausente o `cancelled`) → 404 idéntico.
  - Doble captura de cámara: se liberan tracks de preview **antes** de conectar a LiveKit.
  - Sala personal: sin ventana temporal (siempre disponible mientras `status:active`).
- **Estados vacíos:** sin dispositivos → placeholder; sin permisos → avatar con iniciales.
- **Skeletons:** recuadro de video con shimmer durante boot; placeholders en selectores.
- **Loading:** spinner de boot; botón Unirse con spinner "Conectando…".
- **Feedback visual:** medidor de nivel de micrófono activo; borde verde/acento al hablar (opcional); toggles con estado claro on/off.
- **Confirmaciones:** ninguna (acción directa de bajo riesgo).
- **Mensajes:** todos vía i18n namespace `meet:`; tono claro y no técnico.
- **Accesibilidad:** labels asociados a cada selector; botones con `aria-label`; foco inicial en campo nombre (externo) o en Unirse (interno); contraste según tokens de tema; `<video>` con texto alternativo descriptivo del estado.
- **Navegación:** sin breadcrumbs; salir = cerrar pestaña o volver atrás del navegador. Éxito → in-call.
- **Responsive:** dos columnas en ≥768px (preview | ingreso); una columna apilada en móvil (preview arriba, ingreso abajo); botón Unirse full-width.

---

## Reglas de negocio

- **Restricciones:**
  - El token **siempre** se emite en backend; el frontend nunca posee el secret de LiveKit.
  - La identidad del participante es **opaca y única** (`guest-<randomBytes(8)>`); el nombre es solo metadata visible.
  - 404 **idéntico** para sala inexistente vs cerrada (anti-enumeración); slug no enumerable.
- **Permisos:** ruta pública (`meta.guestOk`); el control real lo aplica el backend al emitir token.
- **Dependencias:**
  - `GET /api/config/public` debe devolver `meetEnabled=true` y `livekitWsUrl` para habilitar el flujo.
  - La fila `MeetRoom` debe existir y, para salas `booking|calendar`, tener backlink válido (Booking/CalendarEvent no `cancelled`).
- **Validaciones:** nombre externo requerido; `allowExternal` por-sala (las salas `booking` fuerzan `allowExternal=true` vía override); ventana temporal `startAt−15min ≤ now ≤ endAt+30min` para salas con evento.
- **Automatizaciones:** la sala LiveKit se auto-crea al primer join (grant `roomCreate`); `ensureRoom` (fuera de lock, backend) fija el cap de participantes.
- **Integraciones:** LiveKit (signaling `wss://meet.<dom>`), backend Fastify (`/api/meet/public/*`, `/api/config/public`).
- **Procesos automáticos:** rate-limit estricto fail-closed en el endpoint de token público (20/min por IP+slug); metadata pública 60/min.

---

## Casos de uso

- **Caso exitoso:** Invitado externo con link válido dentro de la ventana, escribe nombre, concede permisos, pulsa Unirse → token emitido → entra a la llamada.
- **Casos alternativos:**
  - Usuario interno autenticado se une sin campo nombre y con grants internos.
  - Host se une con grants `roomAdmin`.
  - Invitado se une sin cámara/micrófono (solo escucha) y los activa luego.
- **Casos de error:**
  - 404 idéntico (inexistente/cerrada/orphan slug).
  - 403 `allowExternal=false` para externo.
  - 403 fuera de ventana temporal.
  - Sala llena (cap `maxParticipants`).
  - Meet deshabilitado (`{disabled:true}`).
  - Error de red/5xx.
- **Cancelaciones:** el usuario cierra la pestaña o navega atrás antes de unirse → se liberan tracks de preview; no se crea sala ni se emite token.
- **Reintentos:** botón Reintentar para errores transitorios (red/5xx, sala llena, espera de ventana); el rate-limit fail-closed puede demorar reintentos abusivos.
- **Acciones no permitidas:** unirse con Meet deshabilitado; externo unirse a sala `allowExternal=false`; unirse fuera de ventana; enumerar salas por slug (no existe listado público).

---

## APIs

### `GET /api/config/public`
- **Endpoint:** `/api/config/public`.
- **Método:** GET.
- **Parámetros:** ninguno.
- **Respuesta esperada:** `{ meetEnabled: boolean, livekitWsUrl: string, meetPublicBaseUrl: string }`.
- **Manejo de errores:** si `meetEnabled=false` → la pantalla muestra "Meet no disponible". Error de red → estado de error reintentable.
- **Permisos:** público.

### `GET /api/meet/public/:slug`
- **Endpoint:** `/api/meet/public/:slug`.
- **Método:** GET.
- **Parámetros:** `slug` (path, opaco).
- **Respuesta esperada:** metadata mínima `{ name, ... }` (sin `userId` ni datos sensibles).
- **Manejo de errores:** **404 idéntico** si no existe o está `closed`; rate-limit IP+slug (60/min).
- **Permisos:** público.

### `POST /api/meet/public/:slug/token`
- **Endpoint:** `/api/meet/public/:slug/token`.
- **Método:** POST.
- **Parámetros:** `slug` (path); body `{ displayName }` (externo). Internos/host: token vía `POST /api/meet/rooms/:slug/token` (JWT).
- **Respuesta esperada:** `{ token: string, livekitWsUrl: string, identity: 'guest-xxxx', expiresAt }`. Grants de externo = `roomJoin + canPublish + canSubscribe + canPublishData` (sin `roomAdmin`), `roomCreate` en primer join.
- **Manejo de errores:**
  - 404: sala inexistente/cerrada o backlink Booking/CalendarEvent ausente/`cancelled` (idéntico).
  - 403: `allowExternal=false` (externo) o fuera de ventana temporal.
  - Sala llena: rechazo por cap `maxParticipants`.
  - Rate-limit fail-closed (20/min IP+slug).
- **Permisos:** público (gate por sala, ventana, `allowExternal`).

---

## Modelo de datos

- **Entidades:**
  - **`MeetRoom`** (`packages/api/src/models/MeetRoom.ts`): `slug` (unique global), `name`, `mode`, `status`, `source`, `maxParticipants`, `allowExternalOverride?`, `expiresAt?`, `bookingId?`, `calendarEventId?`, `userId`.
  - **`MeetSettings`** (singleton SystemConfig `meet`): `enabled`, `wsUrl`, `publicBaseUrl`, `maxParticipants`, `allowExternal`, `maxDurationMinutes`, `branding?`.
- **Relaciones:** `MeetRoom.bookingId → Booking`; `MeetRoom.calendarEventId → CalendarEvent`. Salas `booking|calendar` requieren backlink válido para emitir token.
- **Campos usados (lectura, esta pantalla):** `MeetRoom.slug`, `name`, `status`, `source`, `maxParticipants`, `allowExternal(Override)`, ventana derivada de `Booking/CalendarEvent`. `MeetSettings.enabled`, `wsUrl`, `publicBaseUrl`.
- **Reglas de persistencia:** esta pantalla **no escribe** en el modelo. La sala LiveKit se auto-crea al primer join (backend); `last_used`/auditoría se registran en backend al emitir token.

---

## Auditoría

- **Acciones registradas (backend, si `auditEnabled`):**
  - `token.issue`: al emitir AccessToken se loggea `{ slug, identity (guest-opaco), ip, rol (externo/interno/host), ts }`.
  - Rechazos relevantes (403/404/llena) se reflejan en logs/métricas (`meet_tokens_issued`, contadores de error).
- **No se auditan** los joins reales en MVP (requieren webhooks LiveKit — roadmap). Solo se registra la emisión del token, no el ingreso efectivo a la sala.
- **Privacidad:** nunca se registra el `displayName` como identidad; la identidad auditada es opaca.

---

## QA

- [ ] La ruta `/meet/:slug` carga sin sesión (público, `meta.guestOk`).
- [ ] `/meet/:userSlug` (perfil) redirige a `/u/:userSlug` (no colisiona con salas).
- [ ] Con `meetEnabled=false` se muestra "Meet no disponible" y no aparece Unirse.
- [ ] Slug inexistente y slug de sala `closed` muestran el **mismo** mensaje 404 (indistinguibles).
- [ ] Slug huérfano (backlink Booking/CalendarEvent ausente o `cancelled`) → 404 idéntico.
- [ ] Externo: campo "Tu nombre" requerido; Unirse deshabilitado hasta 1–60 chars válidos.
- [ ] Interno/host: campo nombre oculto; pueden unirse directamente.
- [ ] Preview de cámara/micrófono funciona y respeta el dispositivo seleccionado.
- [ ] Negar permisos de medios no bloquea Unirse (banner no bloqueante).
- [ ] Cambiar dispositivo re-inicializa el preview con el `deviceId` correcto.
- [ ] Al unirse se liberan los tracks de preview (sin doble captura de cámara).
- [ ] `allowExternal=false` + externo → 403 con mensaje correcto.
- [ ] Salas `booking` con override fuerzan `allowExternal=true` (el externo entra).
- [ ] Fuera de ventana (`< inicio−15min` o `> fin+30min`) → 403 con horario mostrado.
- [ ] Sala personal sin ventana → siempre disponible mientras `status:active`.
- [ ] Sala llena (cap `maxParticipants`) → mensaje de máximo alcanzado + Reintentar.
- [ ] Rate-limit del token público es fail-closed (no se relaja ante error).
- [ ] El token nunca aparece en frontend antes de la respuesta del backend; el secret nunca se expone.
- [ ] La identidad recibida es opaca (`guest-xxxx`), no el nombre.
- [ ] Éxito → transición a `MeetCallView` con `Room.connect(livekitWsUrl, token)`.
- [ ] Responsive: 2 columnas en desktop, apilado en móvil; Unirse full-width.
- [ ] Accesibilidad: labels en selectores, foco inicial correcto, `aria-label` en botones.
- [ ] Textos provienen del namespace i18n `meet:` (es/en).
