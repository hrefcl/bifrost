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
}

export interface User {
  id: string;
  primaryEmail: string;
  displayName: string;
  role: 'user' | 'admin';
  avatarUrl?: string;
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
