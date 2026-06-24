## 5. Modelo de Datos MongoDB

El diseño del esquema de datos de Webmail 6.0 sigue los principios de modelado orientado a documentos para cargas de trabajo read-heavy, donde la denormalización controlada y los índices compuestos bien diseñados prevalecen sobre la normalización relacional [^148^]. MongoDB resulta particularmente adecuado para el dominio de email porque: las consultas predominantes son lecturas (listar emails, buscar, navegar carpetas), la estructura de un email se mapea naturalmente a un documento JSON anidado, y los índices compuestos permiten resolver las queries más frecuentes en una sola operación index-covered [^204^].

La estrategia de modelado adopta un enfoque híbrido: se incrustan (embed) datos estables que se consultan conjuntamente con alta frecuencia — como los participantes de un thread o los headers de un email — y se referencian datos que cambian frecuentemente o tienen cardinalidad potencialmente ilimitada, como los adjuntos o los eventos de calendario [^141^]. El límite de 16MB por documento de MongoDB se toma como restricción de diseño activa: un email con sus headers y preview cabe cómodamente en un documento, mientras que los adjuntos se almacenan en SeaweedFS con solo su metadata en MongoDB.

El índice compuesto más crítico del sistema — `{accountId: 1, folderId: 1, date: -1, uid: 1}` — sigue la regla ESR (Equality → Sort → Range), garantizando que la query de listado de emails se resuelva mediante un index scan sin necesidad de in-memory sorts ni document fetches adicionales [^204^].

### 5.1 Colección `users` — Configuración Global

La colección `users` almacena el perfil de configuración global de cada persona que accede al sistema. Un documento por usuario físico, independientemente de cuántas cuentas de correo gestione.

```typescript
interface IUser {
  _id: ObjectId;

  /** Email principal usado para identificación en el sistema */
  primaryEmail: string;

  /** Nombre de visualización para el usuario */
  displayName: string;

  /** URL del avatar (generado por Gravatar o subido por el usuario) */
  avatarUrl?: string;

  /** Preferencias de interfaz de usuario */
  preferences: {
    /** Idioma de la interfaz (ISO 639-1) */
    language: string;           // default: 'es'

    /** Zona horaria para fechas (IANA tz database) */
    timezone: string;           // default: 'America/Mexico_City'

    /** Formato de hora: 12h o 24h */
    timeFormat: '12h' | '24h';  // default: '24h'

    /** Tema visual */
    theme: 'light' | 'dark' | 'system';  // default: 'system'

    /** Densidad de la lista de emails */
    density: 'compact' | 'comfortable' | 'spacious';  // default: 'comfortable'

    /** Número de emails por página */
    pageSize: number;           // default: 50, min: 10, max: 200

    /** Layout preferido: three-pane o list-only */
    layout: 'three-pane' | 'list-only';  // default: 'three-pane'

    /** Si agrupar emails por conversación (threading) */
    enableThreading: boolean;   // default: true

    /** Si mostrar preview del email en la lista */
    showPreview: boolean;       // default: true

    /** Atajo de teclado preferido: gmail o outlook */
    keyboardShortcutSet: 'gmail' | 'outlook';  // default: 'gmail'

    /** Si el compositor usa formato HTML o texto plano */
    composeFormat: 'html' | 'text';  // default: 'html'

    /** Firma por defecto para emails salientes (puede contener HTML) */
    defaultSignature?: string;

    /** Si incluir firma por defecto */
    autoIncludeSignature: boolean;  // default: true

    /** Configuración de notificaciones */
    notifications: {
      /** Habilitar notificaciones push del navegador */
      desktopEnabled: boolean;   // default: true

      /** Sonido al recibir nuevo email */
      soundEnabled: boolean;     // default: false

      /** Notificar solo para emails de contactos conocidos */
      notifyOnlyContacts: boolean;  // default: false
    };

    /** Configuración de seguridad */
    security: {
      /** Si requiere confirmación antes de abrir links externos */
      confirmExternalLinks: boolean;  // default: true

      /** Si mostrar imágenes automáticamente (false = pedir confirmación) */
      autoLoadImages: boolean;   // default: false

      /** Si bloquear contenido de remitentes no en contactos */
      blockRemoteContentUnknown: boolean;  // default: true
    };
  };

  /** Fecha de creación del usuario en el sistema */
  createdAt: Date;

  /** Fecha de última modificación del perfil */
  updatedAt: Date;

  /** Fecha del último acceso exitoso */
  lastLoginAt?: Date;
}
```

El campo `preferences` se almacena como documento embebido porque todas las preferencias se cargan simultáneamente al iniciar sesión y rara vez cambian individualmente. No justifica una colección separada ni joins en runtime [^141^].

| Campo | Tipo | Índice | Descripción |
|-------|------|--------|-------------|
| `_id` | ObjectId | Primary | Identificador único del usuario |
| `primaryEmail` | string | Unique | Email principal para identificación |
| `displayName` | string | - | Nombre visible en la interfaz |
| `preferences.language` | string | - | Idioma de la UI (ISO 639-1) |
| `preferences.timezone` | string | - | Zona horaria IANA |
| `preferences.theme` | string | - | Tema: light, dark, system |
| `preferences.pageSize` | number | - | Emails por página (10-200) |
| `preferences.enableThreading` | boolean | - | Agrupar por conversación |
| `preferences.defaultSignature` | string | - | Firma HTML por defecto |
| `createdAt` | Date | TTL (2 años) | Fecha de creación |

**Índices:**
- `{primaryEmail: 1}` — unique, para lookup por email principal.
- `{createdAt: 1}` — TTL index de 2 años para cleanup de cuentas inactivas.

### 5.2 Colección `accounts` — Multi-Cuenta IMAP/SMTP

La colección `accounts` almacena la configuración de cada cuenta de correo vinculada a un usuario. El diseño soporta multi-cuenta desde el origen: un usuario puede tener múltiples accounts (Gmail personal, Exchange corporativo, IMAP propio), cada una con su propia configuración de servidor y credenciales encriptadas.

```typescript
interface IAccount {
  _id: ObjectId;

  /** Referencia al usuario propietario */
  userId: ObjectId;

  /** Nombre descriptivo de la cuenta (editable por el usuario) */
  name: string;

  /** Dirección de email completa */
  email: string;

  /** Si es la cuenta principal (por defecto para envío) */
  isPrimary: boolean;

  /** Configuración del servidor IMAP */
  imap: {
    /** Hostname del servidor IMAP */
    host: string;

    /** Puerto del servidor (143 o 993) */
    port: number;

    /** Si usar TLS desde el inicio (true para 993) */
    secure: boolean;

    /** Método de autenticación */
    authMethod: 'password' | 'oauth2';

    /** Username para autenticación IMAP */
    authUser: string;

    /**
     * Password encriptado con AES-256-GCM o token de acceso OAuth2.
     * El plugin mongoose-aes-encryption maneja encriptación transparente
     * a nivel de campo [^154^].
     */
    authCredentials: string;  // encrypted

    /** Si usar compresión IMAP (COMPRESS=DEFLATE) */
    compress: boolean;

    /** Extensiones soportadas por el servidor (detectadas en conexión) */
    capabilities?: string[];

    /** Si el servidor soporta CONDSTORE para sync incremental */
    hasCondstore?: boolean;

    /** Si el servidor soporta QRESYNC para re-sincronización rápida [^39^] */
    hasQresync?: boolean;

    /** Si el servidor soporta IMAP IDLE para notificaciones push [^63^] */
    hasIdle?: boolean;

    /** Protocolo preferido: imap o jmap (auto-detectado) */
    preferredProtocol: 'imap' | 'jmap';
  };

  /** Configuración del servidor SMTP para envío */
  smtp: {
    /** Hostname del servidor SMTP */
    host: string;

    /** Puerto (25, 587 con STARTTLS, o 465 con TLS) */
    port: number;

    /** Si usar TLS desde el inicio */
    secure: boolean;

    /** Método de autenticación */
    authMethod: 'password' | 'oauth2';

    /** Username para autenticación SMTP */
    authUser: string;

    /** Password encriptado o token OAuth2 */
    authCredentials: string;  // encrypted [^154^]
  };

  /** Configuración del servidor CalDAV (opcional) */
  caldav?: {
    /** URL base del servidor CalDAV */
    baseUrl: string;

    /** Username */
    username: string;

    /** Password encriptado */
    password: string;  // encrypted [^154^]
  };

  /** Estado de la cuenta */
  status: 'active' | 'syncing' | 'error' | 'disabled';

  /** Mensaje de error si status === 'error' */
  lastError?: string;

  /** Fecha de la última sincronización exitosa */
  lastSyncedAt?: Date;

  /** Fecha de creación de la cuenta */
  createdAt: Date;

  /** Fecha de última modificación */
  updatedAt: Date;
}
```

El campo `authCredentials` se encripta con AES-256-GCM usando el plugin mongoose-aes-encryption, que proporciona encriptación transparente: la aplicación lee y escribe valores en texto plano mientras solo ciphertext toca la base de datos [^154^]. Esta decisión es crítica para webmail, donde las credenciales de acceso a servidores de correo externo constituyen el activo más sensible del sistema. Incluso en caso de compromiso completo de la base de datos MongoDB, las credenciales permanecen protegadas siempre que la clave maestra `ENCRYPTION_KEY` (almacenada como variable de entorno del servidor) no se vea expuesta.

| Campo | Tipo | Índice | Descripción |
|-------|------|--------|-------------|
| `_id` | ObjectId | Primary | Identificador único de la cuenta |
| `userId` | ObjectId | Compound | FK a users._id |
| `email` | string | Unique | Dirección de email de la cuenta |
| `isPrimary` | boolean | - | Cuenta por defecto para envío |
| `imap.host` | string | - | Servidor IMAP |
| `imap.port` | number | - | Puerto IMAP |
| `imap.authMethod` | string | - | password u oauth2 |
| `imap.authCredentials` | string | Encrypted | Password/token encriptado [^154^] |
| `smtp.host` | string | - | Servidor SMTP |
| `status` | string | - | active, syncing, error, disabled |
| `lastSyncedAt` | Date | - | Última sincronización exitosa |

**Índices:**
- `{userId: 1, isPrimary: -1}` — para listar cuentas de un usuario con la primaria primero.
- `{email: 1}` — unique, para prevenir duplicados.
- `{status: 1, lastSyncedAt: 1}` — para queries de monitoreo de sincronización.

### 5.3 Colección `folders` — Cache Local IMAP

La colección `folders` mantiene un espejo de la jerarquía de carpetas IMAP para cada cuenta, permitiendo que el frontend muestre la estructura de buzones sin consultar el servidor IMAP en cada carga de página.

```typescript
interface IFolder {
  _id: ObjectId;

  /** Referencia a la cuenta */
  accountId: ObjectId;

  /** Nombre completo de la carpeta en el servidor IMAP */
  name: string;

  /** Delimitador de jerarquía (típicamente '.' o '/') */
  delimiter: string;

  /** Nombre para mostrar (último componente del path) */
  displayName: string;

  /** Path de la carpeta padre (vacío para root) */
  parentPath?: string;

  /** Flags especiales de IMAP */
  flags: string[];  // e.g., ['\\HasNoChildren', '\\Sent']

  /** Flag funcional especial (si aplica) */
  specialUse?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

  /** UIDVALIDITY del servidor IMAP para esta carpeta */
  uidValidity: number;

  /** UIDNEXT esperado (para detectar mensajes nuevos) */
  uidNext: number;

  /** Número total de mensajes */
  totalMessages: number;

  /** Número de mensajes no leídos */
  unseenMessages: number;

  /** Si la carpeta está suscrita */
  subscribed: boolean;

  /** Orden de visualización configurable por el usuario */
  sortOrder: number;

  /** Si la carpeta está expandida en la UI */
  expanded: boolean;

  /** Fecha de última sincronización */
  syncedAt: Date;

  /** Fecha de creación del registro */
  createdAt: Date;

  /** Fecha de última modificación */
  updatedAt: Date;
}
```

Los campos `uidValidity` y `uidNext` son fundamentales para detectar condiciones de sincronización: si el `uidValidity` del servidor difiere del almacenado, todos los UIDs locales son inválidos y se requiere una sincronización completa. El campo `unseenMessages` se mantiene actualizado tanto por sincronización incremental como por notificaciones IDLE en tiempo real, permitiendo que el badge de "no leídos" en el sidebar se actualice sin recargar la página [^39^].

**Índices:**
- `{accountId: 1, sortOrder: 1}` — para listar carpetas ordenadas por usuario.
- `{accountId: 1, specialUse: 1}` — unique sparse, una carpeta especial por tipo por cuenta.

### 5.4 Colección `emails` — Cache Headers + Preview

La colección `emails` es el núcleo del sistema: almacena los headers, preview y metadata de cada mensaje, actuando como índice local que permite listar y buscar emails sin consultar el servidor IMAP. Los cuerpos completos **no** se almacenan aquí; se obtienen bajo demanda vía IMAP y se cachean en Redis [^70^][^75^].

```typescript
interface IEmail {
  _id: ObjectId;

  /** Referencia a la cuenta */
  accountId: ObjectId;

  /** Referencia a la carpeta */
  folderId: ObjectId;

  /** UID IMAP del mensaje (único dentro de la carpeta) */
  uid: number;

  /** Message-ID del RFC 822 (usado para threading) */
  messageId: string;

  /** Message-ID al que responde (para construir threads) */
  inReplyTo?: string;

  /** Array de Message-IDs referenciados (algoritmo JWZ) [^56^] */
  references?: string[];

  /** ID del thread (hash del Message-ID raíz, calculado por JWZ) */
  threadId?: string;

  /** Remitente parseado */
  from: {
    name?: string;
    address: string;
  };

  /** Destinatarios principales */
  to: {
    name?: string;
    address: string;
  }[];

  /** Destinatarios en copia */
  cc?: {
    name?: string;
    address: string;
  }[];

  /** Destinatarios en copia oculta (solo disponible para mensajes enviados) */
  bcc?: {
    name?: string;
    address: string;
  }[];

  /** Asunto del mensaje (decodificado RFC 2047) */
  subject: string;

  /** Fecha del mensaje (desde header Date) */
  date: Date;

  /** Fecha de recepción en el servidor IMAP */
  internalDate: Date;

  /** Tamaño total del mensaje en bytes */
  size: number;

  /** Preview de texto (primeros 200 caracteres del body plain) */
  preview?: string;

  /** Flags IMAP del mensaje */
  flags: {
    seen: boolean;      // \\Seen
    answered: boolean;  // \\Answered
    flagged: boolean;   // \\Flagged
    deleted: boolean;   // \\Deleted
    draft: boolean;     // \\Draft
  };

  /** Keywords personalizadas (Gmail labels, flags de usuario) */
  keywords?: string[];

  /** Si tiene adjuntos */
  hasAttachments: boolean;

  /** Número de adjuntos */
  attachmentCount: number;

  /** Modsequence para sync CONDSTORE */
  modseq?: number;

  /** Si el body ya fue cacheado en Redis */
  bodyCached: boolean;

  /** Fecha de cacheo del body */
  bodyCachedAt?: Date;

  /** Timestamp de creación del registro */
  createdAt: Date;

  /** Timestamp de última modificación */
  updatedAt: Date;
}
```

El diseño del índice compuesto principal sigue estrictamente la regla ESR (Equality → Sort → Range): los campos de igualdad (`accountId`, `folderId`) preceden al campo de ordenamiento (`date: -1`), que a su vez precede al campo de rango (`uid`) [^204^]. Esta estructura garantiza que la query más frecuente del sistema — "dame los emails de esta carpeta ordenados por fecha descendente" — se resuelva con un index scan monodireccional sin necesidad de in-memory sort ni fetch de documentos adicionales.

| Campo | Tipo | Índice | Descripción |
|-------|------|--------|-------------|
| `_id` | ObjectId | Primary | Identificador único |
| `accountId` | ObjectId | Compound (ESR) | FK a accounts._id |
| `folderId` | ObjectId | Compound (ESR) | FK a folders._id |
| `uid` | number | Compound (ESR) | UID IMAP |
| `messageId` | string | - | Message-ID RFC 822 |
| `threadId` | string | Compound | Hash del thread (JWZ) [^56^] |
| `from.address` | string | - | Email del remitente |
| `subject` | string | Atlas Search | Asunto decodificado |
| `date` | Date | Compound (ESR) | Fecha del header |
| `flags.seen` | boolean | Compound | Estado de lectura |
| `hasAttachments` | boolean | - | Tiene adjuntos |
| `modseq` | number | - | Para CONDSTORE sync |

**Índices:**
- `{accountId: 1, folderId: 1, date: -1, uid: 1}` — índice compuesto principal para listado [^204^].
- `{accountId: 1, threadId: 1, date: -1}` — para agrupar conversaciones.
- `{accountId: 1, flags.seen: 1, folderId: 1}` — para contar no leídos por carpeta.
- `{accountId: 1, "from.address": 1, date: -1}` — para listar emails por remitente.

Para búsqueda full-text sobre `subject`, `from.address` y `preview`, se utiliza MongoDB Atlas Search (basado en Apache Lucene), que ofrece sincronización automática de datos, highlighting, fuzzy search y autocomplete sin requerir infraestructura adicional [^132^]. Atlas Search cubre el 90% de los casos de uso de búsqueda en webmail y elimina la complejidad operacional de mantener un cluster Elasticsearch separado [^129^].

### 5.5 Colección `attachments` — Metadata

Los archivos adjuntos se almacenan físicamente en SeaweedFS (object storage S3-compatible con licencia Apache 2.0, optimizado para archivos pequeños y alto I/O) [^177^]. La colección `attachments` mantiene únicamente la metadata necesaria para localizar, nombrar y presentar los adjuntos en la interfaz.

```typescript
interface IAttachment {
  _id: ObjectId;

  /** Referencia al email que contiene el adjunto */
  emailId: ObjectId;

  /** Referencia a la cuenta */
  accountId: ObjectId;

  /** Nombre original del archivo */
  filename: string;

  /** MIME type (ej: application/pdf, image/png) */
  contentType: string;

  /** Tamaño en bytes */
  size: number;

  /** CID para adjuntos inline (Content-ID) */
  contentId?: string;

  /** Si es un adjunto inline (mostrado dentro del cuerpo HTML) */
  inline: boolean;

  /**
   * Clave de almacenamiento en SeaweedFS.
   * Formato: {accountId}/{emailUid}/{hash_filename}
   */
  storageKey: string;

  /** Checksum SHA-256 para verificación de integridad */
  checksum: string;

  /** Si está disponible para descarga/preview */
  available: boolean;

  /** Metadata de imágenes (si aplica) */
  imageMeta?: {
    width: number;
    height: number;
    thumbnailStorageKey?: string;
  };

  /** Timestamp de creación */
  createdAt: Date;
}
```

El `storageKey` sigue una convención jerárquica que facilita el listado y la limpieza: `{accountId}/{emailUid}/{hash}`. Cuando un email se elimina permanentemente, todos los adjuntos con su `emailId` se eliminan en cascada de SeaweedFS mediante un job de background en BullMQ [^203^].

**Índices:**
- `{emailId: 1}` — para listar adjuntos de un email.
- `{accountId: 1, createdAt: -1}` — para listar adjuntos recientes por cuenta.
- `{storageKey: 1}` — unique, para prevenir duplicados de almacenamiento.

### 5.6 Colección `contacts` — Agenda Básica

La colección `contacts` implementa una agenda de contactos integrada que puede sincronizarse bidireccionalmente con servidores CardDAV vía tsdav, la librería TypeScript más moderna y activa para CalDAV/CardDAV con ~113,580 descargas semanales en npm [^190^].

```typescript
interface IContact {
  _id: ObjectId;

  /** Referencia al usuario propietario */
  userId: ObjectId;

  /** Nombre completo del contacto */
  fullName: string;

  /** Nombre para ordenar (apellido, nombre) */
  sortName: string;

  /** Email principal */
  email: string;

  /** Emails adicionales */
  emails?: {
    label: string;      // 'work', 'home', 'other'
    address: string;
  }[];

  /** Teléfonos */
  phones?: {
    label: string;      // 'mobile', 'work', 'home', 'fax'
    number: string;
  }[];

  /** Organización */
  organization?: string;

  /** Cargo / título */
  jobTitle?: string;

  /** Notas */
  notes?: string;

  /** Dirección postal */
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };

  /** URL del sitio web */
  website?: string;

  /** Fecha de cumpleaños */
  birthday?: Date;

  /** URL del avatar o foto */
  photoUrl?: string;

  /** Si es un contacto frecuente (usado para autocomplete) */
  isFrequent: boolean;

  /** Contador de usos (emails enviados a este contacto) */
  usageCount: number;

  /** Origen del contacto: local, imported, carddav */
  source: 'local' | 'imported' | 'carddav';

  /** Si sincronizado con CardDAV: URL del recurso y ETag */
  carddavSync?: {
    resourceUrl: string;
    etag: string;
    lastSyncedAt: Date;
  };

  /** Fecha de creación */
  createdAt: Date;

  /** Fecha de última modificación */
  updatedAt: Date;
}
```

El campo `usageCount` se incrementa cada vez que el usuario envía un email al contacto, y se utiliza para ordenar las sugerencias de autocomplete en el compositor. Los contactos con `isFrequent: true` se cachean en Redis para respuestas de autocomplete sub-50ms.

**Índices:**
- `{userId: 1, sortName: 1}` — para listar contactos ordenados alfabéticamente.
- `{userId: 1, email: 1}` — unique sparse, para evitar duplicados por email.
- `{userId: 1, isFrequent: -1, usageCount: -1}` — para autocomplete de contactos frecuentes.
- `{userId: 1, "carddavSync.etag": 1}` — para sincronización incremental CardDAV.

### 5.7 Colección `drafts` — Auto-Save Local

Los borradores se almacenan exclusivamente en MongoDB sin sincronización con el servidor IMAP, facilitando un auto-guardado rápido y la gestión de múltiples borradores simultáneos.

```typescript
interface IDraft {
  _id: ObjectId;

  /** Referencia a la cuenta desde la que se enviará */
  accountId: ObjectId;

  /** Referencia al usuario */
  userId: ObjectId;

  /** Destinatarios principales */
  to: {
    name?: string;
    address: string;
  }[];

  /** Destinatarios en copia */
  cc?: {
    name?: string;
    address: string;
  }[];

  /** Destinatarios en copia oculta */
  bcc?: {
    name?: string;
    address: string;
  }[];

  /** Asunto */
  subject: string;

  /** Cuerpo del mensaje en HTML */
  bodyHtml?: string;

  /** Cuerpo del mensaje en texto plano */
  bodyText?: string;

  /** IDs de adjuntos temporales */
  attachments?: {
    filename: string;
    contentType: string;
    size: number;
    storageKey: string;
  }[];

  /** Headers In-Reply-To y References (si es respuesta) */
  replyTo?: {
    emailId: ObjectId;
    messageId: string;
    references: string[];
  };

  /** Si usar firma */
  includeSignature: boolean;

  /** Estado del borrador */
  status: 'editing' | 'sending' | 'sent' | 'failed';

  /** Fecha de última modificación (para auto-save) */
  lastModifiedAt: Date;

  /** Fecha de creación */
  createdAt: Date;
}
```

El campo `lastModifiedAt` tiene un índice TTL de 30 días: los drafts no modificados durante ese período se eliminan automáticamente por MongoDB, evitando acumulación de borradores abandonados.

**Índices:**
- `{accountId: 1, lastModifiedAt: -1}` — para listar drafts recientes.
- `{lastModifiedAt: 1}` — TTL index (30 días), expireAfterSeconds: 2592000.

### 5.8 Colección `events` — Calendario CalDAV

La colección `events` almacena los eventos de calendario sincronizados vía CalDAV (RFC 4791) usando tsdav como cliente [^190^]. El soporte de calendario es un requisito competitivo: los usuarios esperan aceptar o declinar invitaciones de reunión directamente desde su cliente de email, una funcionalidad que Roundcube solo logra mediante plugins descritos como "painful" de instalar [^131^][^225^].

```typescript
interface ICalendarEvent {
  _id: ObjectId;

  /** Referencia al usuario */
  userId: ObjectId;

  /** Referencia a la cuenta (puede diferir del userId para calendarios compartidos) */
  accountId: ObjectId;

  /** ID del calendario (colección CalDAV) */
  calendarId: string;

  /** Nombre del calendario */
  calendarName: string;

  /** Color asignado al calendario (hex) */
  calendarColor?: string;

  /** UID del evento iCalendar (RFC 5545) */
  uid: string;

  /** Título del evento */
  summary: string;

  /** Descripción */
  description?: string;

  /** Ubicación */
  location?: string;

  /** Sala de reuniones (campo específico de sistemas enterprise) */
  room?: string;

  /** Tipo de evento */
  eventType: 'event' | 'meeting' | 'reminder' | 'task';

  /** Fecha y hora de inicio */
  startDate: Date;

  /** Zona horaria de inicio (IANA tz database) */
  startTimezone: string;

  /** Fecha y hora de fin */
  endDate: Date;

  /** Zona horaria de fin */
  endTimezone: string;

  /** Si es un evento de día completo */
  allDay: boolean;

  /** Regla de recurrencia (RRULE en formato iCalendar) [^158^] */
  recurrenceRule?: string;

  /** Fechas excluidas de la recurrencia */
  recurrenceExceptions?: Date[];

  /** Organizador del evento */
  organizer?: {
    name?: string;
    email: string;
  };

  /** Asistentes invitados */
  attendees?: {
    name?: string;
    email: string;
    status: 'needs-action' | 'accepted' | 'declined' | 'tentative';
    role: 'chair' | 'required' | 'optional';
  }[];

  /** Estado de la invitación (si el usuario es asistente) */
  inviteStatus?: 'needs-action' | 'accepted' | 'declined' | 'tentative';

  /** Alarma / recordatorio */
  alarm?: {
    triggerMinutes: number;
    method: 'display' | 'email';
  };

  /** Si el evento proviene de un adjunto .ics en un email */
  sourceEmailId?: ObjectId;

  /** Datos de sincronización CalDAV */
  caldavSync?: {
    resourceUrl: string;
    etag: string;
    syncToken?: string;
    lastSyncedAt: Date;
  };

  /** Visibilidad del evento */
  visibility: 'default' | 'public' | 'private' | 'confidential';

  /** Estado del evento */
  status: 'confirmed' | 'tentative' | 'cancelled';

  /** Timestamp de creación local */
  createdAt: Date;

  /** Timestamp de última modificación local */
  updatedAt: Date;
}
```

El manejo de timezones es uno de los mayores desafíos en la integración de calendarios: las definiciones VTIMEZONE en archivos ICS son notoriamente problemáticas entre clientes, especialmente Outlook [^155^][^156^]. Webmail 6.0 adopta la recomendación de usar timezones de la base de datos IANA (tz database) y convertir a UTC cuando sea posible para almacenamiento interno, aplicando la zona horaria del usuario solo en el momento de renderizado [^155^].

La sincronización bidireccional con servidores CalDAV requiere manejo de conflictos mediante ETags para detección de cambios concurrentes, sync-tokens para sincronización incremental, y resolución a nivel de campo para minimizar pérdida de datos [^226^]. tsdav proporciona soporte integrado para estos mecanismos [^190^].

**Índices:**
- `{userId: 1, startDate: -1}` — para listar eventos próximos.
- `{accountId: 1, calendarId: 1, startDate: 1}` — para listar eventos por calendario en un rango.
- `{uid: 1}` — unique sparse, para evitar duplicados de evento.
- `{sourceEmailId: 1}` — para vincular eventos con emails de invitación.

### 5.9 Resumen de Estrategia de Indexado

La performance del webmail depende críticamente de que las queries más frecuentes se resuelvan como index-covered scans. La siguiente tabla consolida la estrategia de indexado por colección:

| Colección | Índice Principal | Campos Cubiertos | Complejidad de Query |
|-----------|-----------------|-----------------|---------------------|
| `users` | `{primaryEmail: 1}` | Login, lookup de perfil | O(1) |
| `accounts` | `{userId: 1, isPrimary: -1}` | Listar cuentas multi-inbox | O(n accounts) |
| `folders` | `{accountId: 1, sortOrder: 1}` | Sidebar de carpetas | O(n folders) |
| `emails` | `{accountId: 1, folderId: 1, date: -1, uid: 1}` | Listado de inbox [^204^] | O(log n) index scan |
| `emails` | `{accountId: 1, threadId: 1, date: -1}` | Conversaciones (JWZ) [^56^] | O(log n) index scan |
| `attachments` | `{emailId: 1}` | Listar adjuntos de un email | O(1) |
| `contacts` | `{userId: 1, isFrequent: -1, usageCount: -1}` | Autocomplete en compositor | O(log n) |
| `drafts` | `{accountId: 1, lastModifiedAt: -1}` | Listar borradores recientes | O(log n) |
| `events` | `{userId: 1, startDate: -1}` | Eventos próximos | O(log n) |

Para búsquedas full-text complejas — aquellas que escapan a los índices compuestos — MongoDB Atlas Search proporciona un motor basado en Apache Lucene integrado directamente en la base de datos, eliminando la necesidad de un cluster Elasticsearch separado y reduciendo el time-to-market en un 30-50% para proyectos greenfield [^132^]. Las capacidades de Atlas Search utilizadas por Webmail 6.0 incluyen: búsqueda de texto sobre `subject`, `from.address`, `to.address` y `preview`; filtrado por rango de fechas; highlighting de términos coincidentes; y fuzzy matching para corrección de typos en términos de búsqueda [^129^].
