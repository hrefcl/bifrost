## 8. Módulo de Calendario

La integración de calendario no es un "nice-to-have" sino una necesidad competitiva. Gmail, Outlook y todo cliente de correo moderno integra invitaciones de calendario (.ics) directamente en el flujo de trabajo del email [^227^]. Webmail 6.0 implementa un módulo de calendario completo con sincronización CalDAV, UI basada en FullCalendar, detección automática de invitaciones en correos, y envío de invitaciones desde el compositor. El stack tecnológico seleccionado —tsdav + ical.js + FullCalendar— proporciona una solución completa con soporte TypeScript nativo [^190^][^197^][^130^].

### 8.1 Integración CalDAV

#### 8.1.1 tsdav: Cliente TypeScript para CalDAV/CardDAV

tsdav es la librería Node.js/TypeScript más moderna y completa para CalDAV/CardDAV: soporta WebDAV, CalDAV y CardDAV tanto en navegador como en Node.js, con autenticación OAuth2 y básica integrada, tipado TypeScript nativo, y está testeada con múltiples proveedores cloud (iCloud, Google, Fastmail, Nextcloud, Baikal). Registra aproximadamente 113,580 descargas semanales en npm y se mantiene activamente [^190^]. La librería histórica `dav` de Mozilla, que fue el pilar del ecosistema durante años, lleva 7 años sin actualizarse significativamente, posicionando a tsdav como el reemplazo de facto [^195^].

La integración de tsdav en Webmail 6.0 se realiza a través de un servicio dedicado `CalDAVService` que encapsula todas las operaciones del protocolo. Este servicio inicializa un cliente tsdav con las credenciales de la cuenta (básicas, digest u OAuth2 según el proveedor) y expone métodos para: descubrir calendarios, listar eventos, crear/actualizar/eliminar eventos, y sincronizar cambios. El soporte OAuth2 integrado de tsdav es esencial para proveedores como Google, que desde marzo de 2025 requieren OAuth2 para acceso a CalDAV [^190^][^193^].

La especificación RFC 4791 define los requisitos obligatorios para servidores CalDAV: soporte iCalendar como media type, WebDAV Class 1, WebDAV ACL (RFC 3744), transporte TLS, ETags para detección de cambios, todos los calendaring reports (`calendar-query`, `calendar-multiget`, `free-busy-query`), y advertising vía `DAV:supported-report-set` [^153^][^159^]. tsdav implementa client-side todos estos reportes, permitiendo a Webmail 6.0 operar con cualquier servidor conforme.

#### 8.1.2 ical.js (Mozilla) para RFC 5545

ical.js de Mozilla es la librería estándar para parsing y generación de iCalendar (RFC 5545) en JavaScript. Soporta jCal (RFC 7265), vCard (RFC 6350) y jCard (RFC 7095), y es la base sobre la que se construye todo el ecosistema de calendarios web [^197^]. ical.js no tiene dependencias externas, lo que reduce la superficie de ataque y simplifica el bundle.

Para casos de uso que requieren expansión robusta de reglas de recurrencia (RRULE), manejo de zonas horarias, `EXDATE` y `RECURRENCE-ID`, Webmail 6.0 complementa ical.js con `node-ical`, un fork que mejora específicamente el soporte para entornos Node.js [^189^]. Esta combinación permite parsear eventos recurrentes complejos, expandirlos a instancias individuales para visualización en el calendario, y reconstruir el iCalendar original para modificaciones.

El flujo de parsing funciona así: el servidor obtiene el iCalendar vía tsdav (`calendar-multiget`), lo parsea con ical.js extrayendo componentes `VEVENT`, `VTODO` y `VTIMEZONE`, y almacena los eventos normalizados en MongoDB con campos estructurados (`uid`, `summary`, `dtstart`, `dtend`, `rrule`, `organizer`, `attendees`, `location`, `description`, `status`). Los eventos recurrentes se expanden periódicamente mediante un job en BullMQ que genera las instancias concretas para las próximas 90 días, almacenándolas en una colección separada `calendar_instances` para consultas rápidas.

#### 8.1.3 Auto-discovery: DNS SRV + Well-Known + PROPFIND

El auto-discovery CalDAV implementa el flujo definido en RFC 6764 en tres etapas progresivas [^232^]:

**Etapa 1: DNS SRV/TXT.** El sistema consulta registros DNS `_caldavs._tcp.{dominio}` SRV para obtener el hostname y puerto del servidor CalDAV. Si existen registros TXT, estos proporcionan la ruta base del servicio.

**Etapa 2: Well-Known URLs.** Si el DNS no resuelve, el sistema intenta `GET /.well-known/caldav` en el dominio del servidor de correo, siguiendo redirecciones HTTP 301/308. Esta es la forma más común de auto-discovery en servidores modernos (Nextcloud, SOGo, Baikal).

**Etapa 3: PROPFIND manual.** Como último recurso, se ejecuta un `PROPFIND` en la URL raíz del servidor con profundidad 0, buscando la propiedad `{DAV:}current-user-principal`, que apunta a la URL del usuario actual. Desde allí, un segundo `PROPFIND` con `calendar-home-set` revela las colecciones de calendario disponibles.

El resultado del auto-discovery se cachea en Redis con TTL de 7 días para evitar latencia en conexiones subsiguientes. El usuario puede sobrescribir la URL descubierta mediante configuración manual en la interfaz de cuentas.

### 8.2 UI de Calendario

#### 8.2.1 FullCalendar: Vistas Día/Semana/Mes/Agenda

FullCalendar es el estándar de facto para componentes UI de calendario en JavaScript, con integración nativa para Vue.js vía `@fullcalendar/vue3`. Desde la versión 5.5 soporta feeds iCalendar directamente, y existe un plugin comunitario que añade soporte CalDAV como eventSource con autenticación OAuth2 [^130^][^133^][^238^][^242^].

La implementación en Webmail 6.0 utiliza FullCalendar con las siguientes configuraciones: plugin `dayGridPlugin` para vista de mes, `timeGridPlugin` para vistas de día y semana, `listPlugin` para vista de agenda, e `interactionPlugin` para selección de rangos y drag-and-drop de eventos. El header de herramientas muestra navegación (anterior/siguiente/hoy), selector de vista (mes/semana/día/agenda), y el título del período actual. El locale se adapta automáticamente según la preferencia del usuario.

Cada evento se renderiza con colores derivados del calendario padre (configurables por el usuario con selector de color de 18 tonos predefinidos). Los eventos de todo el día aparecen en la sección superior del día (all-day slot de 28px de altura). Los eventos temporales muestran su hora de inicio en formato 24h, título truncado a 2 líneas, e indicador de color del calendario como borde izquierdo de 3px. Los eventos con invitados pendientes muestran un pequeño badge de estado: amarillo `#F4B400` para "pendiente de respuesta", verde `#34A853` para "aceptado", rojo `#EA4335` para "declinado".

El calendario soporta las siguientes interacciones: clic en evento abre panel de detalle (título, horario, ubicación, descripción, lista de asistentes con estados), clic en celda vacía abre el composer de nuevo evento con la fecha/hora pre-llenada, drag-and-drop para mover eventos (con confirmación para eventos recurrentes: "¿Modificar solo esta instancia o toda la serie?"), y resize para ajustar duración de eventos temporales.

#### 8.2.2 Integración Email ↔ Calendario: Detección .ICS, Preview Aceptar/Declinar

Una de las funcionalidades diferenciadoras de Webmail 6.0 es la detección automática de invitaciones de calendario en los correos entrantes. Cuando el sistema parsea un email con PostalMime y detecta un adjunto con extensión `.ics` o tipo MIME `text/calendar`, extrae el componente `METHOD:REQUEST` o `METHOD:PUBLISH` del iCalendar y genera una tarjeta de preview in-line en el reading pane [^227^].

La tarjeta de invitación muestra: título del evento con icono de calendario, fecha y hora formateadas en el timezone local del usuario (ej: "Jueves 15 de mayo, 14:00 – 15:00 GMT-3"), ubicación con enlace a Google Maps si es una dirección física, organizador con avatar y nombre, lista de asistentes con sus estados de respuesta, y tres botones de acción primarios: "Aceptar" (verde), "Quizás" (amarillo), y "Declinar" (rojo).

Al presionar cualquiera de los botones, el sistema ejecuta el flujo iTip (RFC 5546): genera un iCalendar de respuesta con `METHOD:REPLY`, establece el `PARTSTAT` del asistente (`ACCEPTED`, `TENTATIVE`, o `DECLINED`), y envía la respuesta al organizador vía SMTP. Simultáneamente, el evento se añade/actualiza en el calendario CalDAV del usuario con el estado correspondiente. Si el usuario no tiene un calendario CalDAV configurado, el evento se almacena en un calendario local (MongoDB) con sincronización diferida cuando se configure CalDAV.

Para actualizaciones de eventos existentes (`METHOD:REQUEST` con secuencia mayor), la tarjeta muestra un badge "Actualizado" y resalta los cambios mediante diff visual: campos modificados aparecen con fondo amarillo `#FFF8E1` y un indicador de "cambio" junto al valor anterior tachado. El usuario puede aceptar la actualización o mantener la versión previa.

Para cancelaciones (`METHOD:CANCEL`), la tarjeta muestra un banner rojo `#EA4335` con texto "Este evento ha sido cancelado" y un botón "Eliminar del calendario" que remueve el evento vía CalDAV `DELETE`.

#### 8.2.3 Envío de Invitaciones: Composer + .ICS Multipart/Alternative

El envío de invitaciones desde Webmail 6.0 se integra directamente en el composer de correo. Un botón "Programar reunión" en la barra de herramientas del compositor abre un panel lateral con campos para: título del evento, fecha/hora de inicio y fin (pickers con selección de timezone del usuario), ubicación (con autocompletado de direcciones previas), y lista de asistentes (sincronizada con el módulo de contactos).

Al enviar, el sistema genera un email multipart con tres partes: `text/plain` con la descripción legible del evento, `text/html` con formato enriquecido generado desde el mismo Tiptap del composer, y `text/calendar; method=REQUEST` con el iCalendar RFC 5545 completo. El componente iCalendar incluye `UID` generado v4 UUID, `ORGANIZER` con el email de la cuenta activa, `ATTENDEE` para cada destinatario con `ROLE=REQ-PARTICIPANT;RSVP=TRUE`, y `VALARM` opcional si el usuario configuró recordatorio.

Los asistentes que usan Webmail 6.0 recibirán la tarjeta de preview con botones Aceptar/Declinar. Los que usan otros clientes (Outlook, Apple Mail, Thunderbird) recibirán la invitación estándar iCalendar que sus clientes procesarán nativamente.

### 8.3 Sincronización

#### 8.3.1 Sincronización Bidireccional: ETags + Sync-Tokens + Conflict Resolution

La sincronización bidireccional entre Webmail 6.0 y el servidor CalDAV implementa las mejores prácticas del protocolo: resolución a nivel de campo (no de ítem completo), uso de ETags para detección de cambios, sync-tokens para sincronización incremental, y establecimiento de dirección de sync por campo para minimizar conflictos [^226^].

El flujo de sincronización opera así: en cada ciclo de sync (disparado por cron cada 5 minutos o manualmente por el usuario), el backend obtiene el sync-token almacenado para el calendario y ejecuta un `sync-collection` REPORT con el token. El servidor responde con: (a) recursos modificados desde el último sync, (b) recursos eliminados, y (c) un nuevo sync-token. Para cada recurso modificado, Webmail 6.0 compara el ETag local con el remoto; si difieren, descarga el iCalendar actualizado y mergea con la versión local.

El sistema de resolución de conflictos sigue estas reglas en orden de prioridad: si el cambio es local no sincronizado aún, gana el local (dirección de sync por defecto: server → client para cambios del servidor, client → server para cambios locales). En caso de cambio simultáneo en ambos lados (doble modificación entre sincronizaciones), se aplica resolución a nivel de campo: `SUMMARY`, `DESCRIPTION` y `LOCATION` se mergean tomando el valor más reciente por timestamp; `DTSTART`, `DTEND` y `RRULE` se resuelven con estrategia "último escritor gana"; `ATTENDEES` se mergean la lista. Los conflictos no auto-resolvibles se notifican al usuario mediante un toast con opción de revisar manualmente.

Los eventos creados localmente se envían al servidor CalDAV vía `PUT` con header `If-None-Match: *` para prevenir sobrescritura. Los eventos eliminados localmente se eliminan en el servidor vía `DELETE` con el ETag correspondiente. Toda operación CalDAV se registra en un log de sync (`CalendarSyncLog`) con timestamp, dirección, operación, resultado, y ETag involucrado, facilitando debugging y auditoría.

#### 8.3.2 RRULE con ical.js

El manejo de eventos recurrentes es una de las fuentes principales de complejidad en calendarios. Webmail 6.0 utiliza ical.js para parsear las reglas `RRULE` (RFC 5545) y expandirlas a instancias individuales [^158^]. Las reglas soportadas incluyen: frecuencia (`FREQ=DAILY/WEEKLY/MONTHLY/YEARLY`), intervalo (`INTERVAL`), recuento máximo (`COUNT`), fecha de fin (`UNTIL`), días de la semana (`BYDAY`), día del mes (`BYMONTHDAY`), mes (`BYMONTH`), y posición (`BYSETPOS`).

La expansión de RRULE se ejecuta como un job en BullMQ cada noche (02:00 AM timezone del servidor), generando instancias concretas para los próximos 90 días. Este enfoque de pre-computación permite que FullCalendar cargue eventos rápidamente sin calcular recurrencias en tiempo real. Para eventos con excepciones (`EXDATE`), las instancias correspondientes se marcan como excluidas. Para modificaciones de instancias individuales (`RECURRENCE-ID`), se genera un evento override que reemplaza la instancia base en consultas.

Cuando un usuario modifica una instancia recurrente, el sistema presenta el diálogo: "¿Aplicar cambios solo a este evento o a toda la serie?". Si selecciona "solo este evento", se crea un componente `VEVENT` con `RECURRENCE-ID` apuntando a la instancia original. Si selecciona "toda la serie", se modifica la regla `RRULE` base. Esta distinción se preserva en el iCalendar sincronizado vía CalDAV.

#### 8.3.3 Timezones: IANA, Almacenamiento en UTC

El manejo de zonas horarias es uno de los mayores desafíos en calendarios: `VTIMEZONE` en ICS es notoriamente problemático entre clientes, especialmente Outlook [^155^][^156^]. Webmail 6.0 adopta la estrategia de almacenamiento en UTC con conversión a la zona horaria local del usuario para visualización.

Todos los eventos se almacenan internamente con `DTSTART` y `DTEND` en UTC (sufijo `Z`). La zona horaria del usuario se obtiene de la configuración de perfil (por defecto, la zona horaria del navegador detectada vía `Intl.DateTimeFormat().resolvedOptions().timeZone`). Para visualización, FullCalendar recibe los eventos en UTC y aplica la zona horaria local del usuario mediante el plugin `@fullcalendar/moment-timezone`.

Cuando un evento se crea o modifica, el composer de eventos muestra un selector de timezone que defaultea a la zona del usuario pero permite cambiar explícitamente. Al guardar, la fecha/hora seleccionada se convierte a UTC para almacenamiento. En el iCalendar exportado vía CalDAV o adjunto .ics, se incluye un bloque `VTIMEZONE` con la definición IANA completa para compatibilidad con clientes que requieren `VTIMEZONE` explícito (Outlook, Apple Calendar).

La base de datos de zonas horarias IANA se mantiene actualizada mediante el paquete `ical.timezones.js`, que proporciona definiciones `VTIMEZONE` para todas las zonas IANA. Este paquete se actualiza automáticamente con cada release que incorpora los cambios de la Olson TZ Database (actualizaciones por cambios de horario de verano en jurisdicciones mundiales).

| Componente | Librería / Tecnología | Versión | Función |
|------------|----------------------|---------|---------|
| Cliente CalDAV | tsdav | ^2.1.0 | Cliente TypeScript para CalDAV/CardDAV/WebDAV con OAuth2 [^190^] |
| Parser iCalendar | ical.js (Mozilla) | ^2.0.0 | Parsing/generación RFC 5545, jCal, sin dependencias [^197^] |
| Expansión RRULE | node-ical | ^0.18.0 | Fork de ical.js con expansión robusta de recurrencias [^189^] |
| UI Calendario | FullCalendar Vue 3 | ^6.1.0 | Componente calendario con vistas día/semana/mes/agenda [^130^] |
| Plugin iCal | @fullcalendar/icalendar | ^6.1.0 | Soporte nativo de feeds iCalendar en FullCalendar [^242^] |
| Timezones | ical.timezones.js | ^1.0.0 | Base de datos IANA para VTIMEZONE [^158^] |
| Auto-discovery | RFC 6764 | — | DNS SRV + well-known + PROPFIND [^232^] |
| Autenticación | OAuth 2.0 + Basic/Digest | RFC 6749 | OAuth2 para Google/iCloud, Basic para self-hosted [^152^] |
| Sync incremental | ETag + sync-token | RFC 6578 | Detección eficiente de cambios sin descarga completa [^226^] |
| Invitaciones | iTip (RFC 5546) | — | Flujo REQUEST/REPLY/CANCEL para invitaciones [^227^] |
| Colas de sync | BullMQ 5 | ^5.0.0 | Jobs de expansión RRULE y sync periódico en background |
