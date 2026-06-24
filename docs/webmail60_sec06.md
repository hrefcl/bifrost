## 6. API REST Fastify

El API de Webmail 6.0 se implementa sobre Fastify 4, seleccionado por su rendimiento 2-3x superior a Express en benchmarks controlados (14,460 req/s vs 6,150 req/s bajo 100 conexiones concurrentes) y su sistema de plugins con encapsulación nativa que permite estructurar el webmail como módulos independientes sin filtración de middlewares entre rutas [^130^][^128^]. Cada dominio funcional — autenticación, cuentas IMAP, emails, carpetas, composición, adjuntos, contactos y calendario — se implementa como un plugin Fastify con su propio prefix, decorators, hooks y handlers, siguiendo la guía oficial de plugins de Fastify que promueve la composición de aplicaciones complejas a partir de módulos encapsulados [^149^].

La serialización de respuestas utiliza `fast-json-stringify`, que puede ser hasta 2x más rápido que `JSON.stringify` nativo gracias a la compilación de schemas de validación en funciones de serialización optimizadas [^130^]. El router `find-my-way` (trie-based) ofrece aproximadamente 3x el rendimiento del router de Express, lo que resulta crítico para endpoints de alta frecuencia como el listado de emails y las operaciones de auto-save de drafts [^130^].

Todas las rutas protegidas requieren un access token JWT válido en el header `Authorization: Bearer <token>`, con excepción de los endpoints de autenticación. El sistema implementa rate limiting mediante el algoritmo Sliding Window con Redis Sorted Sets (ZSET), que ofrece la mejor precisión para APIs de producción al eliminar el "burst effect" de los límites de ventana fija [^156^][^158^].

### 6.1 Autenticación

El módulo de autenticación implementa el patrón BFF (Backend-for-Frontend) con token rotation, donde el access token se almacena en memoria del frontend y el refresh token se entrega como cookie HTTP-only con atributos `Secure` y `SameSite: Strict` [^157^][^160^]. Redis actúa como store para los refresh tokens, aprovechando su soporte nativo de expiración (SETEX con TTL) para invalidación automática [^157^].

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `POST` | `/api/auth/login` | Valida credenciales IMAP y emite tokens JWT | `email: string`, `password: string`, `imapHost?: string`, `imapPort?: number`, `imapSecure?: boolean` | — |
| `POST` | `/api/auth/logout` | Revoca el refresh token y cierra conexiones IMAP | — | — |
| `GET` | `/api/auth/me` | Devuelve el usuario autenticado y sus cuentas vinculadas | — | — |
| `POST` | `/api/auth/refresh` | Emite un nuevo access token usando el refresh token (cookie) | — | — |
| `POST` | `/api/auth/oauth/init` | Inicia flujo OAuth2 para Gmail/Microsoft | `provider: 'gmail' \| 'microsoft'` | — |
| `POST` | `/api/auth/oauth/callback` | Completa flujo OAuth2 e intercambia code por token | `code: string`, `provider: 'gmail' \| 'microsoft'` | — |

**Ejemplo de request/response para login:**

```typescript
// Request POST /api/auth/login
{
  "email": "usuario@ejemplo.com",
  "password": "contraseña_segura",
  "imapHost": "imap.ejemplo.com",
  "imapPort": 993,
  "imapSecure": true
}

// Response 200 OK
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 900,
  "user": {
    "id": "507f1f77bcf86cd799439011",
    "primaryEmail": "usuario@ejemplo.com",
    "displayName": "Usuario Ejemplo"
  },
  "accounts": [
    {
      "id": "507f1f77bcf86cd799439012",
      "email": "usuario@ejemplo.com",
      "name": "Principal",
      "isPrimary": true,
      "status": "active"
    }
  ]
}
```

El endpoint `POST /api/auth/login` ejecuta una conexión IMAP transitoria mediante imapflow para validar las credenciales contra el servidor real antes de emitir tokens. Esta decisión elimina la necesidad de mantener una tabla de passwords local y garantiza que el usuario tiene acceso activo a su cuenta de correo en el momento del login [^1^].

La rotación de refresh tokens implementa un `tokenRegistry` en Redis que trackea el estado de cada token (Token ID, Family ID, Previous Token hash, Revocation Status). Si se detecta reúso de un token revocado, se revoca toda la familia de tokens y se fuerza re-autenticación [^157^].

### 6.2 Cuentas

El módulo de cuentas gestiona la configuración multi-inbox, permitiendo a un usuario vincular múltiples servidores de correo (Gmail personal, Exchange corporativo, IMAP propio) con sincronización independiente por cuenta.

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/accounts` | Lista todas las cuentas del usuario autenticado | — | — |
| `GET` | `/api/accounts/:id` | Obtiene detalle de una cuenta específica | — | — |
| `POST` | `/api/accounts` | Añade una nueva cuenta IMAP/SMTP | `name: string`, `email: string`, `imap: ImapConfig`, `smtp: SmtpConfig`, `isPrimary?: boolean` | — |
| `PATCH` | `/api/accounts/:id` | Actualiza configuración de una cuenta | `name?: string`, `imap?: Partial<ImapConfig>`, `smtp?: Partial<SmtpConfig>` | — |
| `DELETE` | `/api/accounts/:id` | Elimina una cuenta y todos sus datos locales | — | — |
| `POST` | `/api/accounts/:id/sync` | Fuerza sincronización completa de la cuenta | — | `full?: boolean` (default: false) |
| `GET` | `/api/accounts/:id/status` | Devuelve estado de sincronización y health check | — | — |
| `POST` | `/api/accounts/:id/test` | Verifica conectividad IMAP/SMTP sin guardar | `imap: ImapConfig`, `smtp: SmtpConfig` | — |

**Ejemplo de schemas TypeScript para configuración:**

```typescript
interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  authMethod: 'password' | 'oauth2';
  authUser: string;
  authCredentials: string;  // se encripta antes de almacenar [^154^]
  compress?: boolean;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  authMethod: 'password' | 'oauth2';
  authUser: string;
  authCredentials: string;  // se encripta antes de almacenar [^154^]
}
```

El endpoint `POST /api/accounts/:id/sync` encola un job de sincronización en BullMQ para procesamiento en background. Cuando `full=true`, se invalida el `uidValidity` cacheado y se ejecuta una sincronización completa desde cero; cuando `full=false` (default), se utiliza CONDSTORE o QRESYNC para una sincronización incremental que solo descarga mensajes nuevos o modificados desde la última sync [^39^]. BullMQ gestiona retries con exponential backoff ante fallos transitorios de red y dead letter queues para mensajes que no pueden procesarse tras múltiples intentos [^203^].

### 6.3 Emails

El módulo de emails implementa el patrón *headers-first, body-on-demand*: el listado opera contra MongoDB local mientras que los cuerpos se obtienen vía IMAP bajo demanda y se cachean en Redis con TTL de 1 hora [^70^][^75^].

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/accounts/:accountId/emails` | Lista emails de una carpeta (desde MongoDB) | — | `folderId: string`, `page?: number`, `limit?: number` (default: 50), `sort?: 'date' \| 'subject' \| 'from'` (default: 'date'), `order?: 'asc' \| 'desc'` (default: 'desc'), `query?: string` (búsqueda Atlas Search) |
| `GET` | `/api/accounts/:accountId/emails/:id` | Obtiene headers y metadata de un email | — | — |
| `GET` | `/api/accounts/:accountId/emails/:id/body` | Obtiene cuerpo HTML/texto (IMAP on-demand → Redis cache) | — | `format?: 'html' \| 'text' \| 'both'` (default: 'both') |
| `GET` | `/api/accounts/:accountId/emails/:id/raw` | Descarga el mensaje completo en formato RFC 822 (.eml) | — | — |
| `PATCH` | `/api/accounts/:accountId/emails/:id/flags` | Actualiza flags IMAP (\\Seen, \\Flagged, etc.) | `flags: { seen?: boolean, answered?: boolean, flagged?: boolean, deleted?: boolean }` | — |
| `POST` | `/api/accounts/:accountId/emails/:id/move` | Mueve email a otra carpeta | `targetFolderId: string` | — |
| `POST` | `/api/accounts/:accountId/emails/:id/copy` | Copia email a otra carpeta | `targetFolderId: string` | — |
| `DELETE` | `/api/accounts/:accountId/emails/:id` | Elimina email (mueve a Trash o expurga) | — | `permanent?: boolean` (default: false) |
| `POST` | `/api/accounts/:accountId/emails/batch` | Operaciones batch sobre múltiples emails | `operation: 'move' \| 'delete' \| 'setFlags'`, `emailIds: string[]`, `targetFolderId?: string`, `flags?: Partial<EmailFlags>` | — |
| `GET` | `/api/accounts/:accountId/emails/:id/thread` | Obtiene todos los emails del mismo hilo/conversación | — | — |

**Ejemplo de response para listado de emails:**

```typescript
// Response GET /api/accounts/:accountId/emails?folderId=xxx&limit=50
{
  "emails": [
    {
      "id": "507f1f77bcf86cd799439020",
      "uid": 15432,
      "messageId": "<abc123@ejemplo.com>",
      "threadId": "hash_thread_abc",
      "from": { "name": "Remitente", "address": "remitente@ejemplo.com" },
      "to": [{ "name": "Destinatario", "address": "dest@ejemplo.com" }],
      "subject": "Reunión de seguimiento",
      "date": "2026-01-15T10:30:00Z",
      "preview": "Hola, te escribo para confirmar la reunión...",
      "flags": { "seen": true, "answered": false, "flagged": false, "deleted": false, "draft": false },
      "hasAttachments": true,
      "attachmentCount": 2,
      "size": 24580
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1247,
    "hasMore": true
  }
}
```

El endpoint `GET /api/emails/:id/body` implementa el patrón cache-aside: primero consulta Redis, y en miss ejecuta `UID FETCH` con `BODY.PEEK[]` vía imapflow para obtener el mensaje completo, lo parsea con PostalMime para extraer HTML y texto plano, sanitiza el HTML con DOMPurify, y almacena el resultado en Redis con TTL de 3600 segundos [^152^][^99^]. El uso de `BODY.PEEK` evita marcar implícitamente el mensaje como `\Seen`, preservando el estado de lectura hasta que el usuario interactúa explícitamente [^70^][^78^].

El endpoint `GET /api/emails/:id/thread` implementa el algoritmo JWZ (Jamie Zawinski, 1997) para reconstruir conversaciones: busca todos los emails con el mismo `threadId` (un hash determinista del Message-ID raíz del hilo) ordenados por fecha, construyendo el árbol de parent-child mediante los headers `In-Reply-To` y `References` [^56^].

### 6.4 Carpetas

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/accounts/:accountId/folders` | Lista carpetas de la cuenta | — | `subscribedOnly?: boolean` (default: false) |
| `POST` | `/api/accounts/:accountId/folders` | Crea nueva carpeta en el servidor IMAP | `name: string`, `parentPath?: string` | — |
| `PATCH` | `/api/accounts/:accountId/folders/:id` | Renombra carpeta o actualiza orden | `name?: string`, `sortOrder?: number`, `subscribed?: boolean` | — |
| `DELETE` | `/api/accounts/:accountId/folders/:id` | Elimina carpeta (y su contenido si está vacía) | — | `force?: boolean` (default: false) |
| `POST` | `/api/accounts/:accountId/folders/:id/empty` | Vacía carpeta (elimina todos los mensajes) | — | — |

Las operaciones de creación, renombrado y eliminación de carpetas se ejecutan directamente contra el servidor IMAP mediante los comandos IMAP CREATE, RENAME y DELETE, respectivamente. Tras una operación exitosa, se invalida el cache local de folders y se ejecuta una sincronización de la jerarquía [^1^].

### 6.5 Composición y Envío

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/drafts` | Lista borradores del usuario | — | `accountId?: string` |
| `GET` | `/api/drafts/:id` | Obtiene un borrador específico | — | — |
| `POST` | `/api/drafts` | Crea un nuevo borrador | `accountId: string`, `to?: Address[]`, `cc?: Address[]`, `bcc?: Address[]`, `subject?: string`, `bodyHtml?: string`, `bodyText?: string` | — |
| `PATCH` | `/api/drafts/:id` | Actualiza borrador (auto-save) | `to?: Address[]`, `cc?: Address[]`, `bcc?: Address[]`, `subject?: string`, `bodyHtml?: string`, `bodyText?: string`, `attachments?: DraftAttachment[]` | — |
| `DELETE` | `/api/drafts/:id` | Elimina borrador | — | — |
| `POST` | `/api/drafts/:id/send` | Envía borrador (SMTP → copia en Sent → borra draft) | `includeSignature?: boolean` | — |
| `POST` | `/api/send` | Envío directo sin crear borrador previo | `accountId: string`, `to: Address[]`, `cc?: Address[]`, `bcc?: Address[]`, `subject: string`, `bodyHtml?: string`, `bodyText?: string`, `attachments?: string[]` (storageKeys), `replyTo?: ReplyToConfig`, `includeSignature?: boolean` | — |

**Ejemplo de envío directo:**

```typescript
// Request POST /api/send
{
  "accountId": "507f1f77bcf86cd799439012",
  "to": [{ "name": "Destinatario", "address": "dest@empresa.com" }],
  "cc": [{ "address": "copia@empresa.com" }],
  "subject": "Propuesta de colaboración",
  "bodyHtml": "<p>Estimado equipo,</p><p>Adjunto nuestra propuesta...</p>",
  "bodyText": "Estimado equipo, Adjunto nuestra propuesta...",
  "attachments": ["sw://accounts/123/attachments/file.pdf"],
  "replyTo": {
    "emailId": "507f1f77bcf86cd799439020",
    "messageId": "<original@email.com>",
    "references": ["<root@thread.com>", "<original@email.com>"]
  },
  "includeSignature": true
}
```

El pipeline de envío implementa una transacción distribuida con compensación: (1) Nodemailer transmite el mensaje vía SMTP con pooling de conexiones y STARTTLS [^68^]; (2) tras confirmación `250 OK`, se copia en la carpeta Sent vía IMAP APPEND con los flags apropiados [^60^]; (3) se elimina el draft de MongoDB; (4) se encola un job para indexar el mensaje enviado. Si el paso 2 falla, se encola un retry en BullMQ con exponential backoff; si el paso 1 falla, se marca el draft como `status: 'failed'` y se notifica al usuario [^203^].

Para cuentas Gmail, el envío SMTP requiere autenticación OAuth2 (XOAUTH2) ya que Google eliminó completamente la autenticación básica en marzo de 2025 [^58^]. Microsoft depreca Basic Authentication para Exchange Online con deadline de abril de 2026 [^59^]. imapflow y Nodemailer soportan autenticación vía `accessToken` como alternativa a password [^41^].

### 6.6 Adjuntos

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `POST` | `/api/attachments/upload` | Sube archivo adjunto temporal | `file: multipart/form-data` | `draftId?: string` |
| `GET` | `/api/attachments/:storageKey` | Descarga archivo adjunto | — | `download?: boolean` (force download vs inline) |
| `GET` | `/api/attachments/:storageKey/preview` | Obtiene preview del adjunto (imágenes, PDFs) | — | `width?: number`, `height?: number` |
| `DELETE` | `/api/attachments/:storageKey` | Elimina archivo adjunto | — | — |

Los archivos adjuntos se almacenan en SeaweedFS, seleccionado como alternativa a MinIO tras el archivo de su edición comunitaria en febrero de 2026. SeaweedFS ofrece licencia Apache 2.0 y está especialmente optimizado para escenarios de alto I/O con muchos archivos pequeños — el patrón típico de attachments de email [^177^]. La metadata de cada adjunto (nombre, MIME type, tamaño, storageKey) se registra en la colección MongoDB `attachments` mientras el contenido binario reside en SeaweedFS.

El endpoint de upload acepta archivos mediante `multipart/form-data` con un límite de 25MB por archivo. Los archivos se validan contra una lista de tipos MIME permitidos y se escanean con ClamAV antes del almacenamiento definitivo. El `storageKey` generado sigue la convención `{userId}/{timestamp}_{hash}.{ext}` para evitar colisiones.

### 6.7 Contactos

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/contacts` | Lista contactos del usuario | — | `query?: string` (búsqueda), `limit?: number` (default: 50), `offset?: number`, `sort?: 'name' \| 'recent' \| 'frequent'` (default: 'name') |
| `GET` | `/api/contacts/autocomplete` | Autocomplete para compositor (sub-50ms) | — | `q: string` (mínimo 2 caracteres), `limit?: number` (default: 5) |
| `GET` | `/api/contacts/:id` | Obtiene contacto por ID | — | — |
| `POST` | `/api/contacts` | Crea nuevo contacto | `fullName: string`, `email: string`, `phones?: Phone[]`, `organization?: string`, `jobTitle?: string`, `notes?: string`, `birthday?: string` | — |
| `PATCH` | `/api/contacts/:id` | Actualiza contacto | Campos parciales de contacto | — |
| `DELETE` | `/api/contacts/:id` | Elimina contacto | — | — |
| `POST` | `/api/contacts/import` | Importa contactos desde vCard (.vcf) | `file: multipart/form-data` | — |
| `GET` | `/api/contacts/export` | Exporta contactos a vCard (.vcf) | — | — |
| `POST` | `/api/contacts/sync` | Sincroniza contactos con servidor CardDAV | — | `force?: boolean` (default: false) |

El endpoint `GET /api/contacts/autocomplete` está optimizado para latencia sub-50ms: consulta únicamente contactos con `isFrequent: true` ordenados por `usageCount` descendente, utilizando el índice compuesto `{userId: 1, isFrequent: -1, usageCount: -1}`. Si no hay suficientes resultados entre los contactos frecuentes, expande la búsqueda al resto de contactos ordenados alfabéticamente. Los resultados se cachean en Redis con TTL de 5 minutos por prefijo de búsqueda.

La sincronización CardDAV vía tsdav utiliza ETags para detección de cambios concurrentes y sync-tokens para sincronización incremental, resolviendo conflictos a nivel de campo para minimizar pérdida de datos [^226^][^190^].

### 6.8 Calendario

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/calendars` | Lista calendarios disponibles | — | `accountId?: string` |
| `GET` | `/api/calendars/:calendarId/events` | Lista eventos de un calendario | — | `start: string` (ISO 8601), `end: string` (ISO 8601), `includeRecurring?: boolean` (default: true) |
| `GET` | `/api/calendars/events/:id` | Obtiene detalle de un evento | — | — |
| `POST` | `/api/calendars/:calendarId/events` | Crea nuevo evento | `summary: string`, `startDate: string`, `endDate: string`, `startTimezone: string`, `description?: string`, `location?: string`, `allDay?: boolean`, `recurrenceRule?: string`, `attendees?: Attendee[]`, `alarm?: AlarmConfig` | — |
| `PATCH` | `/api/calendars/events/:id` | Actualiza evento | Campos parciales de evento | — |
| `DELETE` | `/api/calendars/events/:id` | Elimina evento | — | `cancel?: boolean` (envía cancelación iTip) |
| `POST` | `/api/calendars/events/:id/respond` | Responde a invitación (aceptar/declinar/tentativo) | `status: 'accepted' \| 'declined' \| 'tentative'`, `comment?: string` | — |
| `POST` | `/api/calendars/sync` | Sincroniza calendarios vía CalDAV | — | `accountId?: string`, `force?: boolean` (default: false) |
| `GET` | `/api/calendars/events/:id/ics` | Descarga evento como archivo .ics | — | — |
| `POST` | `/api/emails/:emailId/ics/import` | Importa evento desde adjunto .ics de email | — | — |

**Ejemplo de response para eventos de calendario:**

```typescript
// Response GET /api/calendars/:calendarId/events?start=2026-01-01&end=2026-01-31
{
  "events": [
    {
      "id": "507f1f77bcf86cd799439050",
      "uid": "event-uid-123@ejemplo.com",
      "summary": "Reunión de planificación Q1",
      "description": "Revisión de objetivos trimestrales",
      "location": "Sala de conferencias A",
      "startDate": "2026-01-20T14:00:00Z",
      "startTimezone": "America/Mexico_City",
      "endDate": "2026-01-20T15:30:00Z",
      "endTimezone": "America/Mexico_City",
      "allDay": false,
      "organizer": { "name": "Organizador", "email": "org@empresa.com" },
      "attendees": [
        { "name": "Participante 1", "email": "p1@empresa.com", "status": "accepted", "role": "required" },
        { "name": "Participante 2", "email": "p2@empresa.com", "status": "needs-action", "role": "required" }
      ],
      "alarm": { "triggerMinutes": 15, "method": "display" },
      "status": "confirmed",
      "calendarName": "Trabajo",
      "calendarColor": "#4285f4"
    }
  ]
}
```

El endpoint `POST /api/emails/:emailId/ics/import` parsea el adjunto .ics del email usando ical.js, la librería estándar de Mozilla para parsing/generación de iCalendar (RFC 5545), y crea un evento en la colección `events` vinculado al email fuente [^197^]. El usuario puede aceptar o declinar la invitación directamente desde la vista del email, y el sistema envía la respuesta iTip (RFC 5546) al organizador vía el servidor CalDAV usando tsdav [^190^].

El manejo de timezones utiliza la base de datos IANA para conversiones, almacenando las fechas en UTC internamente y aplicando la zona horaria del usuario solo en el momento de renderizado. Esta estrategia evita los bugs recurrentes causados por definiciones VTIMEZONE inconsistentes entre clientes, especialmente Outlook [^155^][^156^].

### 6.9 Notificaciones en Tiempo Real

Aunque la mayoría de las operaciones siguen el modelo request/response REST, las notificaciones push de nuevos emails utilizan WebSocket sobre Socket.IO para entrega en tiempo real.

| Evento WS | Dirección | Payload | Descripción |
|-----------|-----------|---------|-------------|
| `email:new` | Server → Client | `{accountId, folderId, email: EmailHeader, unseenCount}` | Nuevo email recibido |
| `email:flagChanged` | Server → Client | `{accountId, emailId, flags: EmailFlags}` | Flags modificados (leído, destacado) |
| `folder:countChanged` | Server → Client | `{accountId, folderId, totalMessages, unseenMessages}` | Contadores actualizados |
| `draft:saved` | Server → Client | `{draftId, savedAt}` | Confirmación de auto-save |
| `sync:completed` | Server → Client | `{accountId, folderId, added, updated, deleted}` | Sincronización completada |
| `sync:error` | Server → Client | `{accountId, error: string}` | Error en sincronización |
| `calendar:eventUpdated` | Server → Client | `{calendarId, eventId, type: 'created' \| 'updated' \| 'deleted'}` | Cambio en calendario |

El pipeline de notificaciones sigue la arquitectura: IMAP IDLE detecta cambio → IMAP Manager publica evento a Redis Pub/Sub en canal `notifications:{userId}` → Socket.IO server (suscrito al canal) recibe evento y retransmite a la room del usuario [^138^][^139^][^162^]. Si WebSocket no está disponible, el frontend transita transparentemente a polling adaptativo de 30-60 segundos usando el comando IMAP STATUS para comparar `UIDNEXT` y `UNSEEN` con valores cacheados [^41^].

### 6.10 Rate Limiting y Seguridad

Todos los endpoints están protegidos por rate limiting basado en el algoritmo Sliding Window implementado con Redis Sorted Sets (ZSET) [^156^][^158^]. La configuración por endpoint varía según su sensibilidad y costo computacional:

| Endpoint | Ventana | Límite | Justificación |
|----------|---------|--------|---------------|
| `POST /api/auth/login` | 15 min | 5 intentos | Prevenir fuerza bruta contra credenciales |
| `POST /api/auth/refresh` | 15 min | 10 intentos | Limitar rotación de tokens |
| `POST /api/accounts` | 1 hora | 10 creaciones | Prevenir spam de cuentas |
| `POST /api/accounts/:id/sync` | 5 min | 3 sincronizaciones | Evitar sobrecarga de servidores IMAP |
| `POST /api/send` | 1 min | 10 envíos | Limitar spam saliente |
| `POST /api/attachments/upload` | 1 hora | 50 uploads (1GB) | Control de uso de storage |
| `GET /api/accounts/*/emails` | 1 min | 120 requests | Proteger listados frecuentes |
| `PATCH /api/drafts/*` | 1 min | 30 requests | Auto-save frecuente pero limitado |

El rate limiting se implementa mediante `ZREMRANGEBYSCORE` para eliminar timestamps viejos seguido de `ZCARD` para contar requests en la ventana actual, ofreciendo precisión de nivel de request sin el "burst effect" de los límites de ventana fija [^156^].

La validación de inputs en todos los endpoints utiliza los JSON Schema nativos de Fastify, que compilan los schemas en funciones de validación optimizadas en tiempo de arranque. Los schemas de request definen: tipos de datos, rangos numéricos, patrones regex para emails (RFC 5322), y campos requeridos. Los schemas de response garantizan que solo los campos definidos se serializan, previniendo filtración accidental de datos sensibles (como `authCredentials` en las responses de accounts, que se excluye explícitamente mediante el schema de response) [^130^].

Los headers de seguridad se configuran globalmente en Fastify: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, y una Content Security Policy estricta que bloquea scripts inline, eval, y contenido de orígenes no whitelisteados. Estas cabeceras complementan la sanitización HTML de DOMPurify y el iframe sandbox para renderizado de emails, formando una estrategia defense-in-depth contra vectores XSS [^154^].
