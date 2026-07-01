/**
 * Tipos compartidos entre frontend y backend.
 * Fuente de verdad del dominio de Webmail 6.0.
 */

export interface Address {
  name?: string;
  address: string;
}

export type Theme = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type AccountStatus = 'active' | 'syncing' | 'error' | 'disabled';
export type AuthMethod = 'password' | 'oauth2';
export type Protocol = 'imap' | 'jmap';

export interface UserPreferences {
  language: string;
  timezone: string;
  timeFormat: '12h' | '24h';
  theme: Theme;
  density: Density;
  pageSize: number;
  layout: 'three-pane' | 'list-only';
  enableThreading: boolean;
  showPreview: boolean;
  keyboardShortcutSet: 'gmail' | 'outlook';
  composeFormat: 'html' | 'text';
  defaultSignature?: string;
  autoIncludeSignature: boolean;
  notifications: {
    desktopEnabled: boolean;
    soundEnabled: boolean;
    notifyOnlyContacts: boolean;
  };
  security: {
    confirmExternalLinks: boolean;
    autoLoadImages: boolean;
    blockRemoteContentUnknown: boolean;
  };
  /** Preferencias de Bifrost Meet (opcional; ausente = defaults). */
  meet?: MeetUserPreferences;
}

export interface User {
  id: string;
  primaryEmail: string;
  displayName: string;
  role: 'user' | 'admin';
  avatarUrl?: string;
  /** Slug público para la agenda (`/u/:username`). Opcional; el usuario lo define en Ajustes. */
  username?: string;
  preferences: UserPreferences;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  authMethod: AuthMethod;
  authUser: string;
  authCredentials: string;
  compress: boolean;
  capabilities?: string[];
  hasCondstore?: boolean;
  hasQresync?: boolean;
  hasIdle?: boolean;
  preferredProtocol: Protocol;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  authMethod: AuthMethod;
  authUser: string;
  authCredentials: string;
}

export interface CaldavConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export interface Account {
  id: string;
  userId: string;
  name: string;
  email: string;
  isPrimary: boolean;
  imap: ImapConfig;
  smtp: SmtpConfig;
  caldav?: CaldavConfig;
  status: AccountStatus;
  lastError?: string;
  lastSyncedAt?: string;
  /** Cuota de almacenamiento de adjuntos subidos, en bytes. 0/ausente = sin límite. */
  quotaBytes?: number;
  createdAt: string;
  updatedAt: string;
}

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

export interface Folder {
  id: string;
  accountId: string;
  name: string;
  delimiter: string;
  displayName: string;
  parentPath?: string;
  flags: string[];
  specialUse?: SpecialUse;
  uidValidity: number;
  uidNext: number;
  totalMessages: number;
  unseenMessages: number;
  subscribed: boolean;
  sortOrder: number;
  expanded: boolean;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailFlags {
  seen: boolean;
  answered: boolean;
  flagged: boolean;
  deleted: boolean;
  draft: boolean;
}

export interface Email {
  id: string;
  accountId: string;
  folderId: string;
  uid: number;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  from: Address;
  /** Header Reply-To (RFC 5322): dónde deben ir las respuestas si difiere de `from`. */
  replyTo?: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  date: string;
  internalDate: string;
  size: number;
  preview?: string;
  flags: EmailFlags;
  keywords?: string[];
  hasAttachments: boolean;
  attachmentCount: number;
  modseq?: number;
  bodyCached: boolean;
  bodyCachedAt?: string;
  /** Pospuesto (snooze): ISO de cuándo reaparece; ausente = no pospuesto. */
  snoozedUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailAttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  contentId?: string;
}

export interface EmailBody {
  html?: string;
  text?: string;
  sanitizedHtml?: string;
  attachments?: EmailAttachmentMeta[];
}

export interface Attachment {
  id: string;
  emailId: string;
  accountId: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  inline: boolean;
  storageKey: string;
  checksum: string;
  available: boolean;
  createdAt: string;
}

/**
 * Vista PÚBLICA de un adjunto del draft. Referencia el blob por `blobId` (para que el cliente
 * pueda quitarlo/reconstruir attachmentIds al recargar). NO expone localizadores internos de
 * storage (storageKey/providerType) — esos viven sólo server-side.
 */
export interface DraftAttachment {
  blobId: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface Draft {
  id: string;
  userId: string;
  accountId: string;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  attachments: DraftAttachment[];
  replyTo?: {
    emailId?: string;
    messageId?: string;
    references?: string[];
  };
  includeSignature: boolean;
  status: 'editing' | 'sending' | 'sent' | 'failed';
  lastModifiedAt: string;
  createdAt: string;
}

export interface CalendarEvent {
  id: string;
  userId: string;
  accountId: string;
  calendarId: string;
  calendarName: string;
  calendarColor?: string;
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  startDate: string;
  startTimezone: string;
  endDate: string;
  endTimezone: string;
  allDay: boolean;
  recurrenceRule?: string;
  recurrenceExceptions?: string[];
  organizer?: Address;
  attendees?: {
    name?: string;
    email: string;
    status: 'needs-action' | 'accepted' | 'declined' | 'tentative';
    role: 'chair' | 'required' | 'optional';
  }[];
  inviteStatus?: 'needs-action' | 'accepted' | 'declined' | 'tentative';
  status: 'confirmed' | 'tentative' | 'cancelled';
  sourceEmailId?: string;
  /** Origen del evento. 'booking' = bloque creado por una reserva de la agenda (proyección). */
  source?: 'manual' | 'booking';
  /** Si `source==='booking'`: id de la Booking que lo originó (para reconciler/cancelación). */
  bookingId?: string;
  /** Si el evento tiene una sala Bifrost Meet asociada: id de la `MeetRoom`. */
  meetRoomId?: string;
  /** URL pública de unión a la sala Meet (`${publicBaseUrl}/meet/<slug>`); no es secreto. */
  meetUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  userId: string;
  fullName: string;
  sortName: string;
  email: string;
  emails?: { label: string; address: string }[];
  phones?: { label: string; number: string }[];
  organization?: string;
  jobTitle?: string;
  notes?: string;
  isFrequent: boolean;
  usageCount: number;
  source: 'local' | 'imported' | 'carddav' | 'auto';
  createdAt: string;
  updatedAt: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: User;
  accounts: Pick<Account, 'id' | 'email' | 'name' | 'isPrimary' | 'status'>[];
}

export interface LoginRequest {
  email: string;
  password: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

export interface Paginated<T> {
  data: T[];
  pagination: {
    /** Sólo en paginación por offset; ausente en cursor/keyset. */
    page?: number;
    limit: number;
    /** Conteo total; sólo en la primera página (evita un countDocuments por "cargar más"). */
    total?: number;
    hasMore: boolean;
  };
}

// ===================================================================================
// Agenda inteligente (scheduling tipo Calendly nativo) — DTOs públicos del contrato.
// Diseño aprobado B9/D9: docs/agenda-inteligente-propuesta.md + docs/agenda-ui-funcional.md.
// Los campos server-only (managementToken hash, idempotencyKeyHash, icsUid, pendingReschedule)
// viven SÓLO en el modelo Mongoose, nunca en estos DTOs.
// ===================================================================================

export type MeetingLocationType = 'in_person' | 'phone' | 'video' | 'custom';
export interface MeetingLocation {
  type: MeetingLocationType;
  /** Dirección / teléfono / URL de videollamada según `type`. */
  value?: string;
}

export interface CustomQuestion {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'phone';
  required: boolean;
}

/** Tipo de reunión publicable (event type, plantilla con su propio enlace). */
export interface EventType {
  id: string;
  userId: string;
  /** Único por usuario; segmento del enlace público `/u/:username/:slug`. */
  slug: string;
  title: string;
  description?: string;
  durationMinutes: number;
  color?: string;
  location: MeetingLocation;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minimumNoticeMin: number;
  dateRangeDays: number;
  /** Paso de la grilla de slots; default = durationMinutes. */
  slotIncrementMin?: number;
  /** Máx reservas/día (cuenta por día del anfitrión, sólo confirmadas). 0/ausente = sin límite. */
  dailyLimit?: number;
  availabilityScheduleId: string;
  cancellationPolicyText?: string;
  reschedulePolicyText?: string;
  /** Anticipación mínima (min) para cancelar/reagendar. */
  cancelMinNoticeMin?: number;
  customQuestions: CustomQuestion[];
  active: boolean;
  /** Si las reservas de este tipo generan una sala Bifrost Meet automáticamente (default false). */
  meetEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Intervalo de disponibilidad en hora de pared del anfitrión, "HH:MM" (mismo día, end>start). */
export interface AvailabilityInterval {
  start: string;
  end: string;
}
/** Regla semanal. `weekday`: 0=Domingo … 6=Sábado (convención JS Date.getDay). */
export interface WeeklyRule {
  weekday: number;
  intervals: AvailabilityInterval[];
}
/** Excepción de fecha ("YYYY-MM-DD"). REEMPLAZA la regla del día: `intervals:[]` = no disponible. */
export interface AvailabilityOverride {
  date: string;
  intervals: AvailabilityInterval[];
  note?: string;
}
export interface AvailabilitySchedule {
  id: string;
  userId: string;
  name: string;
  /** IANA, p.ej. "America/Santiago". */
  timezone: string;
  weeklyRules: WeeklyRule[];
  overrides: AvailabilityOverride[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type BookingStatus = 'confirmed' | 'cancelled' | 'rescheduled';
export interface BookingInvitee {
  name: string;
  email: string;
  timezone: string;
  phone?: string;
}
export interface BookingAnswer {
  questionId: string;
  label: string;
  answer: string;
}
/** Parámetros congelados al reservar — para que editar/borrar el EventType no altere reservas hechas. */
export interface BookingSnapshot {
  timezone: string;
  durationMinutes: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minimumNoticeMin: number;
  title: string;
  location: MeetingLocation;
}
export interface Booking {
  id: string;
  eventTypeId: string;
  userId: string;
  snapshot: BookingSnapshot;
  /** Instantes UTC (ISO). */
  startAt: string;
  endAt: string;
  invitee: BookingInvitee;
  answers: BookingAnswer[];
  status: BookingStatus;
  cancelReason?: string;
  cancelledBy?: 'invitee' | 'host';
  calendarEventId?: string;
  rescheduledFromId?: string;
  rescheduledToId?: string;
  source: 'public' | 'host' | 'api';
  createdAt: string;
  updatedAt: string;
}

/** Config de empresa (singleton en SystemConfig key='scheduling'). */
export interface SchedulingSettings {
  enabled: boolean;
  publicLinksEnabled: boolean;
  defaults: { timezone: string; durationMinutes: number; dateRangeDays: number };
  maxEventTypesPerUser?: number;
  auditEnabled: boolean;
}

/** Defaults de calendario a nivel instancia (admin). Singleton en SystemConfig key='calendarDefaults'. */
export interface CalendarSettings {
  /** IANA, p.ej. "America/Santiago". */
  timezone: string;
  /** 0=Domingo, 1=Lunes (primer día de la semana en la grilla). */
  weekStart: 0 | 1;
  /** Inicio/fin de jornada visible "HH:MM" (end > start). */
  dayStart: string;
  dayEnd: string;
  /** Duración por defecto de un evento nuevo (min). */
  defaultDurationMin: number;
  /** Vista inicial del calendario. */
  defaultView: 'day' | 'week' | 'month';
  showWeekends: boolean;
  /** Enviar invitación automática al crear un evento con asistentes. */
  autoInvite: boolean;
  /** Las reservas de Agenda bloquean el calendario. */
  syncAgenda: boolean;
}

// --- DTOs de la página PÚBLICA (sin datos privados del host) ---
export interface PublicEventType {
  slug: string;
  title: string;
  description?: string;
  durationMinutes: number;
  color?: string;
  location: MeetingLocation;
  customQuestions: CustomQuestion[];
}
export interface PublicSchedulingProfile {
  username: string;
  displayName: string;
  avatarUrl?: string;
  eventTypes: PublicEventType[];
}
/** Slot disponible devuelto al invitado (inicio en UTC ISO; la UI lo muestra en su tz). */
export interface AvailableSlot {
  start: string;
}

// --- Bifrost Meet (videollamadas LiveKit self-hosted) ---
export type MeetRoomMode = 'per_event' | 'personal';
export type MeetRoomStatus = 'active' | 'closed';
export type MeetRoomSource = 'manual' | 'calendar' | 'booking';

/** Sala de reunión. `slug` es ÚNICO GLOBAL (no enumerable). DTO no expone secretos. */
export interface MeetRoomDto {
  id: string;
  userId: string;
  slug: string;
  name: string;
  mode: MeetRoomMode;
  status: MeetRoomStatus;
  source: MeetRoomSource;
  calendarEventId?: string;
  bookingId?: string;
  maxParticipants: number;
  allowExternalOverride?: boolean;
  expiresAt?: string;
  /** URL pública de unión (`${publicBaseUrl}/meet/${slug}`); no es secreto. */
  meetUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** Respuesta del endpoint de token: AccessToken efímero + datos para que el cliente conecte. */
export interface MeetTokenResponse {
  token: string;
  /** URL de signaling del SDK (`wss://meet.<dom>`). */
  wsUrl: string;
  /** Nombre de la sala (== slug). */
  room: string;
  /** Identidad opaca del participante (`guest-<rand>` / `host-<rand>`). */
  identity: string;
  /** Rol con el que se emitió el token. */
  role: 'host' | 'internal' | 'external';
  /** Segundos de vida del token (para que el cliente re-fetchee antes del expiry). */
  expiresInSeconds: number;
}

/** Config singleton de Meet (SystemConfig key='meet'). `enabled=false` apaga toda la feature. */
export interface MeetSettings {
  enabled: boolean;
  /** Signaling SDK (`wss://meet.<dom>`). */
  wsUrl: string;
  /** Base pública de los links de unión (`https://webmail.<dom>`). */
  publicBaseUrl: string;
  /** Dominio TURN (`turn.meet.<dom>`); informativo. */
  turnDomain?: string;
  /** Techo de participantes por sala (heredado por salas auto-creadas vía livekit.yaml). */
  maxParticipants: number;
  /** Tope duro de duración de un token (minutos). */
  maxDurationMinutes: number;
  /** Si los invitados externos pueden unirse a salas manuales/personales (las de booking fuerzan true). */
  allowExternal: boolean;
  branding?: { displayName?: string };
  auditEnabled: boolean;
  recordingPolicy: 'disabled';
  // --- LiveKit externo/Cloud (F3.7) — configurable desde el admin ---
  /** API key de LiveKit (id público; el secret va aparte, cifrado, NUNCA en este DTO). */
  livekitApiKey?: string;
  /** URL HTTP server-to-server de la API LiveKit (bundled=http://livekit:7880, Cloud=su URL). */
  livekitApiUrl?: string;
  /** Región (metadato de LiveKit Cloud; informativo). */
  region?: string;
  /** Resolución máxima sugerida ('720p'|'1080p'); informativo. */
  maxResolution?: '720p' | '1080p';
  /** Intención de grabación automática. NO-OP en self-hosted (requiere Cloud/Egress) — ver `livekitSource`. */
  autoRecord?: boolean;
  /** Crear salas bajo demanda al primer participante (ya es el comportamiento via grant roomCreate). */
  onDemand?: boolean;
  /** ¿Hay un API secret guardado? (el secreto JAMÁS se devuelve; solo su presencia). */
  hasApiSecret: boolean;
  /**
   * De dónde salen las credenciales EFECTIVAS de LiveKit:
   * 'db' = par admin (DB) válido · 'env' = fallback de entorno (par DB ausente/parcial) ·
   * 'error' = par DB presente pero NO desencriptable (ENCRYPTION_KEY rotada → Meet falla cerrado, el admin debe re-pegar) ·
   * 'none' = sin credenciales en ningún lado.
   */
  livekitSource: 'db' | 'env' | 'error' | 'none';
}

/** Config pública leída por la SPA en el boot (sin auth, sin secretos). */
export interface PublicConfig {
  meetEnabled: boolean;
  livekitWsUrl: string;
  meetPublicBaseUrl: string;
}

/** Preferencias de Meet por usuario (anidadas en UserPreferences.meet, opcional). */
export interface MeetUserPreferences {
  autoCreateOnEvent: boolean;
  displayName?: string;
  roomMode: MeetRoomMode;
  defaultInviteMessage?: string;
}
