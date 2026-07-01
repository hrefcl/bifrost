# Funcional · Pantalla En-llamada (Meet Call) — estilo Google Meet

> **Fase 0 — Contrato pre-implementación.** Fuente de verdad: `docs/meet/DESIGN.md` (v2.3). Pantalla de videollamada activa con UX **estilo Google Meet**. Componente: `packages/web/src/views/public/MeetCallView.vue`. **Screen sharing está en el MVP.**

---

## Información general

- **Nombre:** Pantalla En-llamada (Meet Call / "Sala de videollamada").
- **Objetivo:** Conectar al participante a la sala LiveKit y ofrecer la experiencia de videollamada: grilla de tiles de video con spotlight de orador activo, compartir pantalla, controles de micrófono/cámara, copiar link, ver número de participantes y salir.
- **Descripción funcional:** Se monta tras la pantalla de pre-ingreso (`MeetJoinView.vue`) una vez que el backend emite el AccessToken. Usa `livekit-client` (`Room.connect(livekitWsUrl, token)`) para conectarse vía `wss://meet.<dom>`. Renderiza tiles de video por participante (cámara y/o pantalla compartida), promueve al **orador activo** o al **track de pantalla compartida** al spotlight, y expone una barra de control inferior. Maneja el ciclo de vida de la conexión, la expiración del token (re-fetch + reconexión breve) y la desconexión.
- **Tipo de usuario:** Invitado externo, usuario interno o host. La UI es idéntica; los grants los aplicó el backend al emitir el token (todos los roles tienen `canPublish` → cámara, micrófono **y pantalla compartida**).
- **Permisos requeridos:** Token válido emitido por backend (no hay control de permisos adicional en frontend). Permisos de navegador: cámara/micrófono (`getUserMedia`) y pantalla (`getDisplayMedia`) bajo demanda.
- **Ruta:** `/meet/:slug` (la misma ruta; la vista in-call se monta dentro/después del pre-join, no hay cambio de URL). `meta.guestOk`, pública.
- **Breadcrumbs:** No aplica (experiencia full-screen inmersiva, fuera de `PublicLayout`: dark mode propio a pantalla completa).
- **Relación con otras pantallas:**
  - **Origen:** `MeetJoinView.vue` (doc `01-meet-join.md`) tras token exitoso.
  - **Destino al salir:** pantalla de "Has salido de la reunión" con opción de volver a unirse (re-renderiza pre-join) o cerrar.
  - **Re-autenticación:** ante expiración de token, re-fetch al mismo endpoint de token + reconexión breve.

---

## Diseño funcional

- **Layout:** **Tema oscuro full-screen** (no usa `PublicLayout`; ocupa todo el viewport). Tres zonas:
  1. **Spotlight principal:** tile grande del orador activo o de la pantalla compartida.
  2. **Grilla/film-strip de miniaturas:** resto de participantes en tiles pequeños (arriba o a un lado según viewport).
  3. **Barra de control inferior:** mic, cámara, compartir pantalla, copiar link, salir, contador de participantes.
- **Secciones:**
  - **Grilla de video:** tiles por participante; cada tile = `<video>` del track de cámara o pantalla, con **etiqueta de nombre** (metadata del participante) e **indicador de mute** (icono `micOff` cuando el participante está silenciado).
  - **Spotlight / active-speaker:** el participante que habla pasa al tile principal; si hay una pantalla compartida, su track `screen_share` (de cualquier participante) tiene **prioridad** sobre el orador activo.
  - **Barra de control:** acciones de la llamada (ver Botones).
  - **Indicador de estado de conexión:** chip de "Conectando…/Reconectando…/Conectado" (transitorio).
- **Paneles:** No hay paneles laterales en MVP (chat, participantes detallados y moderación son roadmap). Solo grilla + barra.
- **Estados vacíos:**
  - **Solo tú en la sala:** spotlight con tu propio tile + mensaje "Esperando a que se unan otros participantes" y botón sugerido "Copiar link".
  - **Nadie con cámara:** tiles con avatar/iniciales en lugar de video.
- **Estados de carga:**
  - **Conectando:** overlay oscuro con spinner "Conectando a la reunión…" mientras `Room.connect` resuelve.
  - **Reconectando:** banner discreto "Reconectando…" si la conexión cae o el token se renueva.
  - **Cargando track:** placeholder/shimmer en un tile hasta que su video se suscribe.
- **Estados de error:**
  - **Token expirado:** re-fetch automático del token + reconexión breve; si falla → "Tu sesión expiró. Vuelve a unirte."
  - **Conexión perdida (no recuperable):** "Se perdió la conexión con la reunión." + botón Reintentar.
  - **Permiso de pantalla denegado:** toast "No se pudo compartir la pantalla (permiso denegado)." (la llamada continúa).
  - **Permiso cámara/micrófono denegado al activar:** toast "No se pudo acceder a la cámara/micrófono."
  - **Sala cerrada por el host / fin de ventana:** "La reunión finalizó." → pantalla de salida.
  - **Sala llena al reconectar:** "La reunión está llena." → pantalla de salida.

---

## Componentes

### 1. `VideoGrid`
- **Nombre:** Grilla de tiles de video.
- **Descripción:** Renderiza un tile por participante (incluye el local). Cada tile muestra el track de cámara o de pantalla, etiqueta de nombre e indicador de mute. Layout responsive (grid/film-strip).
- **Visibilidad:** Visible mientras conectado.
- **Permisos:** N/A (token ya validado).
- **Validaciones:** suscribe/desuscribe tracks según `TrackSubscribed`/`TrackUnsubscribed`; sanea el nombre mostrado.
- **Estados:** vacío (solo local), poblado, con pantalla compartida activa.
- **Eventos:** reacciona a `ParticipantConnected/Disconnected`, `TrackSubscribed`, `ActiveSpeakersChanged`.
- **Acciones:** promueve al spotlight el orador activo o la pantalla compartida.

### 2. `SpotlightTile`
- **Nombre:** Tile principal (spotlight).
- **Descripción:** Tile grande para el orador activo. Si existe un track `screen_share` (de cualquier participante), **éste toma prioridad** y ocupa el spotlight.
- **Visibilidad:** Siempre que haya ≥1 participante.
- **Permisos:** N/A.
- **Validaciones:** prioridad pantalla > orador activo > primer participante.
- **Estados:** orador activo, pantalla compartida promovida, sin actividad (muestra al local o último orador).
- **Eventos:** `ActiveSpeakersChanged`, `TrackPublished(screen_share)`/`TrackUnpublished`.
- **Acciones:** intercambia la fuente del tile principal dinámicamente.

### 3. `ParticipantTile`
- **Nombre:** Tile de participante.
- **Descripción:** Miniatura con video o avatar (iniciales), etiqueta de nombre e indicador de mute.
- **Visibilidad:** Por cada participante remoto y el local.
- **Permisos:** N/A.
- **Validaciones:** nombre saneado; indicador de mute refleja `isMicrophoneEnabled` del participante.
- **Estados:** cámara on, cámara off (avatar), hablando (borde acento), silenciado (icono `micOff`).
- **Eventos:** `IsSpeakingChanged`, `TrackMuted/Unmuted`.
- **Acciones:** click → (opcional) promover manualmente al spotlight (roadmap; en MVP, automático).

### 4. `ControlBar`
- **Nombre:** Barra de control inferior. (Botones detallados abajo.)
- **Descripción:** Contiene mic, cámara, compartir pantalla, copiar link, salir y contador de participantes.
- **Visibilidad:** Siempre visible (auto-hide opcional tras inactividad).
- **Permisos:** N/A (todos los roles tienen `canPublish`).
- **Validaciones:** deshabilita compartir pantalla si el navegador no soporta `getDisplayMedia`.
- **Estados:** mic on/off, cam on/off, compartiendo/no, reconectando (controles atenuados).
- **Eventos:** clicks de cada botón.
- **Acciones:** ver sección Botones.

### 5. `ConnectionStatus`
- **Nombre:** Indicador de estado de conexión.
- **Descripción:** Chip/banner transitorio: Conectando / Conectado / Reconectando.
- **Visibilidad:** Visible en transiciones; oculto en estado estable.
- **Permisos:** N/A.
- **Validaciones:** refleja `RoomEvent.ConnectionStateChanged`/`Reconnecting`/`Reconnected`.
- **Estados:** conectando, conectado, reconectando, desconectado.
- **Eventos:** eventos de conexión de LiveKit.
- **Acciones:** ninguna interactiva.

### 6. `ParticipantCounter`
- **Nombre:** Contador de participantes.
- **Descripción:** Muestra el número total de participantes conectados (icono `users` + número).
- **Visibilidad:** En la barra de control.
- **Permisos:** N/A.
- **Validaciones:** cuenta = participantes remotos + local.
- **Estados:** actualiza en `ParticipantConnected/Disconnected`.
- **Eventos:** eventos de participantes de LiveKit.
- **Acciones:** ninguna (en MVP no abre lista; roadmap).

### 7. `LeftCallScreen`
- **Nombre:** Pantalla de salida.
- **Descripción:** Tras salir o ser desconectado, vista "Has salido de la reunión" con botones "Volver a unirte" y "Cerrar".
- **Visibilidad:** Solo tras desconexión.
- **Permisos:** Público.
- **Validaciones:** "Volver a unirte" re-renderiza pre-join (nuevo token requerido).
- **Estados:** salida voluntaria, expulsado/sala cerrada, error de conexión.
- **Eventos:** clicks de los botones.
- **Acciones:** re-unirse o cerrar pestaña.

---

## Botones

### Micrófono (toggle)
- **Texto:** "Micrófono" (tooltip; el botón es icónico).
- **Icono:** `mic` (activo) / `micOff` (silenciado).
- **Ubicación:** Barra de control inferior.
- **Habilitado:** mientras conectado.
- **Deshabilitado:** durante reconexión o si no hay dispositivo de audio.
- **Acción al click:** `localParticipant.setMicrophoneEnabled(!enabled)`.
- **Confirmaciones:** ninguna.
- **Mensajes éxito/error:** error de permiso → toast "No se pudo acceder al micrófono."
- **Navegación posterior:** ninguna (permanece en llamada).

### Cámara (toggle)
- **Texto:** "Cámara" (tooltip).
- **Icono:** `video` (activa) / `video` atenuado/tachado (apagada).
- **Ubicación:** Barra de control inferior.
- **Habilitado:** mientras conectado.
- **Deshabilitado:** durante reconexión o si no hay dispositivo de video.
- **Acción al click:** `localParticipant.setCameraEnabled(!enabled)`.
- **Confirmaciones:** ninguna.
- **Mensajes éxito/error:** error de permiso → toast "No se pudo acceder a la cámara."
- **Navegación posterior:** ninguna.

### Compartir pantalla
- **Texto:** "Compartir pantalla" (tooltip).
- **Icono:** `grid` o icono de monitor (compartir) / estado activo destacado al compartir.
- **Ubicación:** Barra de control inferior (centro).
- **Habilitado:** mientras conectado y el navegador soporta `getDisplayMedia`.
- **Deshabilitado:** navegador sin `getDisplayMedia`; durante reconexión.
- **Acción al click:** `localParticipant.setScreenShareEnabled(true)` → dispara `getDisplayMedia` (selector nativo del SO). Al activarse, el track `screen_share` se promueve al spotlight **para todos**. Segundo click → `setScreenShareEnabled(false)` detiene la compartición. (`canPublish` ya habilita el track `screen_share`/`screen_share_audio`; sin permiso backend extra.)
- **Confirmaciones:** el selector nativo del SO actúa como confirmación.
- **Mensajes éxito/error:** permiso denegado/cancelado → toast "No se pudo compartir la pantalla (permiso denegado)."; éxito → indicador "Compartiendo pantalla".
- **Navegación posterior:** ninguna (sigue en llamada; spotlight muestra la pantalla).

### Copiar link
- **Texto:** "Copiar link" (tooltip).
- **Icono:** `paperclip` o `mail` (link).
- **Ubicación:** Barra de control inferior.
- **Habilitado:** siempre.
- **Deshabilitado:** nunca (acción local).
- **Acción al click:** copia `${meetPublicBaseUrl}/meet/<slug>` al portapapeles (`navigator.clipboard`).
- **Confirmaciones:** ninguna.
- **Mensajes éxito/error:** toast "Link copiado" / "No se pudo copiar".
- **Navegación posterior:** ninguna.

### Salir (hangup)
- **Texto:** "Salir".
- **Icono:** hangup (teléfono rojo).
- **Ubicación:** Barra de control inferior, destacado en **rojo** (`--danger`).
- **Habilitado:** siempre que esté conectado.
- **Deshabilitado:** nunca.
- **Acción al click:** `room.disconnect()`; libera tracks locales; muestra `LeftCallScreen`.
- **Confirmaciones:** opcional para host (no obligatorio en MVP). Para participantes normales: salida directa.
- **Mensajes éxito/error:** transición a pantalla de salida.
- **Navegación posterior:** `LeftCallScreen` ("Has salido de la reunión").

### Volver a unirte (en `LeftCallScreen`)
- **Texto:** "Volver a unirte".
- **Icono:** `video`.
- **Ubicación:** Pantalla de salida.
- **Habilitado:** si la sala sigue activa/dentro de ventana.
- **Deshabilitado:** si la sala cerró o fuera de ventana (muestra mensaje).
- **Acción al click:** re-renderiza pre-join → solicita **nuevo token** → reconecta.
- **Confirmaciones:** ninguna.
- **Mensajes:** si falla → mismos errores del pre-join (404/llena/ventana).
- **Navegación posterior:** pre-join → in-call.

---

## Formularios

- **No hay formularios** en esta pantalla. La identidad y el nombre se definieron en el pre-ingreso. Las únicas entradas son las acciones de la barra de control y los selectores nativos del navegador/SO (`getDisplayMedia`, permisos de medios). El cambio de dispositivo en-llamada (roadmap/opcional) reusaría los selectores del pre-join.

---

## UX / UI

- **Flujo normal:**
  1. Tras el token, overlay "Conectando…" mientras `Room.connect(livekitWsUrl, token)`.
  2. Conectado → grilla de tiles; spotlight sigue al orador activo.
  3. El usuario alterna mic/cam, comparte pantalla, copia el link.
  4. Pulsa Salir → `room.disconnect()` → pantalla de salida.
- **Flujos alternativos:**
  - **Compartir pantalla:** click → selector del SO → track `screen_share` al spotlight para todos; segundo click detiene.
  - **Otro participante comparte:** su `screen_share` toma el spotlight automáticamente (prioridad sobre orador).
  - **Token por expirar:** re-fetch del token (mismo endpoint) + reconexión breve transparente; banner "Reconectando…".
  - **Reconexión de red:** LiveKit intenta reconectar; banner transitorio.
- **Casos borde:**
  - Solo un participante → estado vacío con "Esperando…" + sugerir copiar link.
  - Múltiples pantallas compartidas simultáneas: MVP promueve una (multi-share simultáneo = roadmap).
  - Participante sin cámara → avatar con iniciales.
  - Host cierra la sala (`DELETE room` → `deleteRoom`) → todos desconectados con "La reunión finalizó."
  - Fin de ventana / `expiresAt` (`empty_timeout` + janitor) → sala se cierra; reconexión rechazada.
- **Estados vacíos:** spotlight con tu tile + mensaje de espera.
- **Skeletons:** shimmer en tiles mientras se suscriben los tracks.
- **Loading:** overlay "Conectando…"; banner "Reconectando…".
- **Feedback visual:** borde acento en el tile del orador activo; icono `micOff` en silenciados; indicador "Compartiendo pantalla"; toasts para copiar link y errores de permiso.
- **Confirmaciones:** mínimas (salida directa; opcional para host).
- **Mensajes:** i18n namespace `meet:`; claros y no técnicos.
- **Accesibilidad:** botones con `aria-label` y estado (`aria-pressed` en toggles); foco gestionado; contraste alto sobre fondo oscuro; tooltips; soporte teclado para acciones de la barra; `<video>` con descripción.
- **Navegación:** sin breadcrumbs; salir → pantalla de salida; volver a unirse re-emite token.
- **Responsive:** desktop = spotlight grande + film-strip lateral/superior; móvil = spotlight a pantalla completa con miniaturas reducidas y barra de control compacta (iconos). Auto-hide de la barra en móvil tras inactividad.

---

## Reglas de negocio

- **Restricciones:**
  - La conexión usa **solo** el AccessToken efímero recibido del backend; el frontend nunca conoce el secret de LiveKit.
  - Identidad opaca (`guest-<random>`); el nombre es metadata visible.
  - El token tiene **TTL acotado**; reuniones largas requieren re-fetch + reconexión breve (LiveKit no refresca un token en vuelo).
- **Permisos:** todos los roles tienen `canPublish` (cámara, micrófono, pantalla). Externos **sin** `roomAdmin`; host **con** `roomAdmin`. No se solicita permiso backend extra para compartir pantalla.
- **Dependencias:** LiveKit alcanzable vía `wss://meet.<dom>` (CSP `connect-src` debe permitir el origen wss/https de meet). `livekitWsUrl` proviene de `GET /api/config/public`.
- **Validaciones:** cap de participantes (`maxParticipants`, fijado por `ensureRoom` en backend); la reconexión a sala llena se rechaza.
- **Automatizaciones:** spotlight automático por orador activo / pantalla compartida; cierre pasivo de sala (`empty_timeout` + janitor `status:closed`).
- **Integraciones:** `livekit-client` (cliente), backend Fastify (token), navegador (`getUserMedia`/`getDisplayMedia`/clipboard).
- **Procesos automáticos:** re-fetch de token antes del expiry; reconexión de LiveKit; cierre de sala vacía/expirada.

---

## Casos de uso

- **Caso exitoso:** Participante conecta, ve la grilla, alterna mic/cam, comparte pantalla, y sale limpiamente a la pantalla de salida.
- **Casos alternativos:**
  - Host comparte pantalla → spotlight para todos; luego la detiene y vuelve al orador activo.
  - Reunión larga supera el TTL del token → re-fetch + reconexión breve sin acción del usuario.
  - Otro participante comparte pantalla → toma el spotlight automáticamente.
- **Casos de error:**
  - Token expirado y re-fetch falla → "Tu sesión expiró. Vuelve a unirte."
  - Conexión perdida no recuperable → "Se perdió la conexión." + Reintentar.
  - Permiso de pantalla/cámara/micrófono denegado → toast; la llamada continúa.
  - Sala cerrada por host o por `expiresAt` → "La reunión finalizó."
  - Reconexión a sala llena → "La reunión está llena."
- **Cancelaciones:** cancelar el selector de `getDisplayMedia` → no comparte; sin error duro (toast informativo opcional).
- **Reintentos:** Reintentar conexión; Volver a unirte (nuevo token).
- **Acciones no permitidas:** externos no pueden administrar la sala (sin `roomAdmin`); no hay grabación/chat/moderación en MVP; no se listan otras salas.

---

## APIs

### `POST /api/meet/public/:slug/token` (re-fetch externo)
- **Endpoint:** `/api/meet/public/:slug/token`.
- **Método:** POST.
- **Parámetros:** `slug` (path), body `{ displayName }` (mismo del pre-join).
- **Respuesta esperada:** `{ token, livekitWsUrl, identity: 'guest-xxxx', expiresAt }`. Reusado para **re-autenticación** antes del expiry → reconexión breve.
- **Manejo de errores:** 404 idéntico, 403 ventana/externo, sala llena, rate-limit fail-closed (20/min IP+slug). Falla → "Vuelve a unirte".
- **Permisos:** público (gate por sala/ventana/`allowExternal`).

### `POST /api/meet/rooms/:slug/token` (re-fetch interno/host)
- **Endpoint:** `/api/meet/rooms/:slug/token`.
- **Método:** POST.
- **Parámetros:** `slug` (path); auth JWT.
- **Respuesta esperada:** token con grants internos (interno) o `roomAdmin` (host).
- **Manejo de errores:** 401/403 si la sesión no es válida; demás como arriba.
- **Permisos:** JWT (interno/host).

### `GET /api/config/public`
- **Endpoint:** `/api/config/public`.
- **Método:** GET.
- **Parámetros:** ninguno.
- **Respuesta esperada:** `{ meetEnabled, livekitWsUrl, meetPublicBaseUrl }` (provee `livekitWsUrl` para `Room.connect` y `meetPublicBaseUrl` para copiar link).
- **Manejo de errores:** si no disponible, la sesión no puede iniciar/copiar link; error de red reintentable.
- **Permisos:** público.

### Conexión LiveKit (no es REST)
- **Endpoint:** `wss://meet.<dom>` (signaling LiveKit), vía `Room.connect(livekitWsUrl, token)` de `livekit-client`.
- **Método:** WebSocket (no HTTP REST).
- **Parámetros:** `livekitWsUrl`, `token` (AccessToken backend).
- **Respuesta esperada:** establecimiento de sesión RTC; media por UDP 7882 / TCP 7881 / TURN 3478.
- **Manejo de errores:** `ConnectionError`/timeout → reconexión o pantalla de error. Hueco conocido: redes solo-443/TCP pueden fallar media (sin TURN/TLS:443 en MVP).
- **Permisos:** validados por el token (grants embebidos).

---

## Modelo de datos

- **Entidades:**
  - **`MeetRoom`**: `slug`, `name`, `status` (`active`/`closed`), `maxParticipants`, `expiresAt?`, `mode`, `source`. La sala LiveKit se auto-crea al primer join.
  - **`MeetSettings`**: `wsUrl`, `publicBaseUrl`, `maxParticipants`, `maxDurationMinutes` (TTL/duración), `allowExternal`, `branding?`.
- **Relaciones:** `MeetRoom.bookingId/calendarEventId` (backlink que el token valida; no se consulta directamente en esta vista).
- **Campos usados (lectura indirecta vía token/config):** `slug` (copiar link), `maxParticipants` (cap), `expiresAt`/`maxDurationMinutes` (TTL del token → re-fetch). `MeetSettings.wsUrl`/`publicBaseUrl` vía `config.public`.
- **Reglas de persistencia:** esta pantalla **no escribe** en Mongo. El estado de la sala lo gestiona LiveKit + backend (`status:closed` por janitor/host/`empty_timeout`). El cliente solo consume el token y el estado RTC en vivo.

---

## Auditoría

- **Acciones registradas (backend, si `auditEnabled`):**
  - `token.issue`: cada emisión/re-emisión de token (incluye re-fetch por expiry) → `{ slug, identity (guest-opaco), ip, rol, ts }` + contador `meet_tokens_issued`.
  - `room.create`: primera creación efectiva de la sala (auto-creación al primer join) → `meet_rooms_created`.
- **No auditados en MVP:** joins/leaves reales, mute/unmute, inicio/fin de screen share (requieren **webhooks LiveKit** — roadmap). La barra de control no genera auditoría server-side.
- **Métricas:** in-memory single-node (`lib/metrics.ts`), se reinician al reiniciar el proceso.

---

## QA

- [ ] `Room.connect(livekitWsUrl, token)` conecta con token válido; overlay "Conectando…" se muestra y desaparece.
- [ ] Tema oscuro full-screen ocupa todo el viewport (no usa `PublicLayout`).
- [ ] Cada tile muestra etiqueta de nombre e indicador de mute correctos.
- [ ] El spotlight sigue al **orador activo** (`ActiveSpeakersChanged`).
- [ ] La **pantalla compartida** (de cualquier participante) toma prioridad en el spotlight sobre el orador.
- [ ] Toggle micrófono ejecuta `setMicrophoneEnabled` y actualiza el indicador en todos los clientes.
- [ ] Toggle cámara ejecuta `setCameraEnabled`; cámara off muestra avatar/iniciales.
- [ ] Compartir pantalla ejecuta `setScreenShareEnabled(true)` → `getDisplayMedia`; el track aparece en el spotlight de todos.
- [ ] Segundo click en compartir detiene la compartición (`setScreenShareEnabled(false)`).
- [ ] Cancelar/denegar `getDisplayMedia` → toast no bloqueante; la llamada continúa.
- [ ] Copiar link copia `${meetPublicBaseUrl}/meet/<slug>` y muestra "Link copiado".
- [ ] Botón Salir (rojo) ejecuta `room.disconnect()`, libera tracks y muestra pantalla de salida.
- [ ] Contador de participantes refleja altas/bajas en tiempo real.
- [ ] Token por expirar → re-fetch automático + reconexión breve (banner "Reconectando…").
- [ ] Re-fetch fallido → "Tu sesión expiró. Vuelve a unirte."
- [ ] Pérdida de conexión no recuperable → mensaje + Reintentar.
- [ ] Host cierra la sala → todos reciben "La reunión finalizó."
- [ ] Reconexión a sala llena → "La reunión está llena."
- [ ] Estado vacío (solo tú) → "Esperando…" + sugerir copiar link.
- [ ] El token nunca expone el secret; la identidad es opaca (`guest-xxxx`).
- [ ] CSP permite el handshake `wss://meet.<dom>` (con Meet ON).
- [ ] Externos no tienen capacidades de administración (sin `roomAdmin`).
- [ ] Responsive: spotlight + film-strip en desktop; spotlight full + barra compacta en móvil.
- [ ] Accesibilidad: `aria-pressed` en toggles, `aria-label` en botones, contraste sobre fondo oscuro, navegación por teclado.
- [ ] Textos vía i18n `meet:` (es/en).
- [ ] Limitación documentada verificada: en red solo-443/TCP la media puede fallar (sin TURN/TLS:443 en MVP).
