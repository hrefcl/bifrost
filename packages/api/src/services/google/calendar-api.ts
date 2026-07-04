import { getValidAccessToken } from './connection.js';
import { OAuthError } from './oauth.js';
import type { Types } from 'mongoose';

/**
 * Cliente REST mínimo de Google Calendar (F-gcal G3), vía `fetch`. Sólo lo que usa el sync v1
 * (unidireccional Bifrost→Google): upsert idempotente y delete de UN evento en el calendario del
 * usuario. Toma el access token del usuario dueño (aislamiento: nunca cruza cuentas).
 */
const API = 'https://www.googleapis.com/calendar/v3';

/** Fecha/hora de Google: `date` para all-day (YYYY-MM-DD), `dateTime`+`timeZone` para el resto. */
export interface GoogleEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
export interface GoogleEventResource {
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  status?: 'confirmed' | 'tentative' | 'cancelled';
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

async function call(
  userId: Types.ObjectId | string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const token = await getValidAccessToken(userId);
  return fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Upsert idempotente: intenta actualizar (PUT) el evento por su id determinista; si no existe (404),
 * lo inserta (POST) con ese mismo id. Así, reintentos o ediciones repetidas NUNCA duplican el evento
 * en Google. `calendarId` suele ser 'primary'.
 */
export async function upsertEvent(
  userId: Types.ObjectId | string,
  calendarId: string,
  resource: GoogleEventResource
): Promise<void> {
  const id = resource.id;
  if (!id) throw new GoogleApiError('upsert sin id', 400);
  const enc = encodeURIComponent(calendarId);
  const put = await call(userId, 'PUT', `/calendars/${enc}/events/${id}`, resource);
  if (put.ok) return;
  if (put.status === 404) {
    const post = await call(userId, 'POST', `/calendars/${enc}/events`, resource);
    // 409 = ya existe (un sync concurrente lo insertó entre nuestro PUT-404 y este POST): idempotente,
    // el evento está en Google con el id determinista → éxito, no error que reintente en loop.
    if (post.ok || post.status === 409) return;
    throw await toError(post);
  }
  throw await toError(put);
}

/** Borra un evento de Google. Un 404/410 = ya no existe → se considera ÉXITO (idempotente). */
export async function deleteEvent(
  userId: Types.ObjectId | string,
  calendarId: string,
  googleEventId: string
): Promise<void> {
  const enc = encodeURIComponent(calendarId);
  const res = await call(userId, 'DELETE', `/calendars/${enc}/events/${googleEventId}`);
  if (res.ok || res.status === 404 || res.status === 410) return;
  throw await toError(res);
}

async function toError(res: Response): Promise<Error> {
  // Un 401 tras un refresh reciente ⇒ credencial inservible de forma PERMANENTE: se envuelve como
  // OAuthError permanente para que el caller marque la conexión en error (y corte reintentos), no como
  // error transitorio de API.
  if (res.status === 401) return new OAuthError('Google rechazó el token (401)', true);
  const text = await res.text().catch(() => '');
  return new GoogleApiError(`Google API ${String(res.status)}: ${text.slice(0, 300)}`, res.status);
}
