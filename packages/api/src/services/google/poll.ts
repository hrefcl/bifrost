import type { Types } from 'mongoose';
import { withLock } from '../../lib/withLock.js';
import { GoogleConnection } from '../../models/GoogleConnection.js';
import { CalendarEvent } from '../../models/CalendarEvent.js';
import { Account } from '../../models/Account.js';
import { listEvents, GoogleSyncTokenExpired } from './calendar-api.js';
import { OAuthError } from './oauth.js';
import { applyGoogleEvent, GOOGLE_CAL_ID } from './import.js';
import { googleEnabled } from './creds.js';
import { enqueue } from '../scheduling/queue.js';

/**
 * Poller bidireccional (Google → Bifrost, F-gcal BD3). Trae los cambios del Google Calendar del usuario y los
 * aplica vía `applyGoogleEvent`. Incremental con `syncToken`; ante 410 (o refresh diario) hace sync inicial
 * de la ventana rolling + reconcile. Serializado por usuario con `withLock`. Ver GOOGLE-CALENDAR-BIDIRECTIONAL.md.
 */
const WINDOW_PAST_MS = 30 * 24 * 60 * 60 * 1000; // 30 días atrás
const WINDOW_FUTURE_MS = 365 * 24 * 60 * 60 * 1000; // ~12 meses adelante
const POLL_JITTER_MS = 30_000; // dispersa los polls por usuario (evita thundering herd — review B/D)

/** Poll de UN usuario. `full` fuerza el sync inicial de ventana + reconcile (410 / refresh diario). */
export async function pollUserCalendar(
  userId: Types.ObjectId | string,
  opts: { full?: boolean } = {}
): Promise<void> {
  if (!(await googleEnabled())) return;
  // waitMs:0 → si otro poll del mismo usuario está en curso, este se saltea (el próximo ciclo lo retoma).
  await withLock(`gcal:poll:${String(userId)}`, () => doPoll(userId, opts), {
    ttlSeconds: 120,
    waitMs: 0,
  });
}

async function doPoll(userId: Types.ObjectId | string, opts: { full?: boolean }): Promise<void> {
  const conn = await GoogleConnection.findOne({ userId });
  if (conn?.status !== 'connected') return; // sólo conexiones usables (fail-closed, sin martilleo)
  const calId = conn.googleCalendarId || 'primary';
  const account = await Account.findOne({ userId, isPrimary: true }).select('_id');
  if (!account) return; // sin cuenta primaria no se puede proyectar el import
  const accountId = account._id;
  const connRev = conn.updatedAt; // CAS: sólo marcamos error si la conexión NO cambió bajo nuestros pies
  const genStart = conn.generation ?? 0; // epoch al iniciar: si cambia, este poll pertenece a una conexión severada

  try {
    if (conn.syncToken && !opts.full)
      await runIncremental(userId, accountId, calId, conn.syncToken);
    else await runFull(userId, accountId, calId);
  } catch (err) {
    // Espejo del push (sync.ts): un fallo PERMANENTE de auth (401 de la API / invalid_grant) marca la
    // CONEXIÓN en 'error' para cortar YA el martilleo — sin esto `enqueueGooglePolls` (que filtra por
    // status:'connected') seguiría encolando este usuario cada 5 min contra Google, y la UI nunca pediría
    // reconectar. Un transitorio (5xx/red) deja la conexión intacta y BullMQ reintenta. Self-healing:
    // al reconectar, el flujo OAuth vuelve a status 'connected'. Guardado por status:'connected' para no
    // pisar un 'revoked' explícito (auditoría de revocación/no-martilleo).
    // CAS por `updatedAt` (review B): si el usuario RECONECTÓ entre nuestro read y este update (mismo doc,
    // 1-por-usuario), `updatedAt` cambió → NO pisamos la conexión nueva y sana con un 'error' de un poll viejo.
    if (err instanceof OAuthError && err.permanent) {
      await GoogleConnection.updateOne(
        { userId, status: 'connected', updatedAt: connRev },
        { $set: { status: 'error', syncError: 'La conexión con Google fue rechazada. Reconectá.' } }
      );
    }
    throw err; // BullMQ reintenta (acotado: en el retry doPoll corta porque conn ya no es 'connected')
  }

  // POST-GUARD anti-carrera disconnect-vs-poll-en-vuelo (review B): si hubo un disconnect (± reconnect)
  // mientras este poll importaba, sus upserts pertenecen a un epoch YA cerrado. Comparamos la GENERACIÓN
  // (monotónica) contra la del inicio; si cambió, este poll es de una conexión severada → purgamos sus
  // imports. Es INDEPENDIENTE del lock/TTL y robusto ante reconnect rápido (status volvería a 'connected',
  // pero la generación NO retrocede). El serializado por-usuario (withLock waitMs:0) garantiza que el poll
  // del epoch nuevo aún no corrió, así que no pisamos imports legítimos suyos. 'error' NO cambia generation
  // → conserva el espejo. Tras purgar, el próximo poll del epoch vigente re-importa full (syncToken limpio).
  const after = await GoogleConnection.findOne({ userId }).select('generation');
  if ((after?.generation ?? 0) !== genStart) {
    await CalendarEvent.deleteMany({ userId, source: 'google' });
    // También limpiamos el syncToken que este poll pudo haber escrito en el epoch nuevo: si no, el próximo
    // incremental usaría un cursor viejo y NO re-importaría el set completo tras el purge. Seguro dentro del
    // lock (ningún poll del epoch nuevo corrió aún) → el próximo poll hará full. (idem disconnect: ya lo limpia).
    await GoogleConnection.updateOne({ userId }, { $unset: { syncToken: '' } });
  }
}

async function runIncremental(
  userId: Types.ObjectId | string,
  accountId: Types.ObjectId,
  calId: string,
  syncToken: string
): Promise<void> {
  try {
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    do {
      const page = await listEvents(userId, calId, { syncToken, pageToken });
      for (const ev of page.items) await applyGoogleEvent(userId, accountId, ev);
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    } while (pageToken);
    if (nextSyncToken)
      await GoogleConnection.updateOne({ userId }, { $set: { syncToken: nextSyncToken } });
  } catch (err) {
    if (err instanceof GoogleSyncTokenExpired) {
      await runFull(userId, accountId, calId); // 410 → purge + full re-sync
      return;
    }
    throw err;
  }
}

async function runFull(
  userId: Types.ObjectId | string,
  accountId: Types.ObjectId,
  calId: string
): Promise<void> {
  const now = Date.now();
  const winMin = new Date(now - WINDOW_PAST_MS);
  const winMax = new Date(now + WINDOW_FUTURE_MS);
  const timeMin = winMin.toISOString();
  const timeMax = winMax.toISOString();
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const page = await listEvents(userId, calId, { timeMin, timeMax, pageToken });
    for (const ev of page.items) {
      const outcome = await applyGoogleEvent(userId, accountId, ev);
      if (outcome === 'imported') seen.add(ev.id);
    }
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  // Reconcile: borra los source:'google' locales que YA NO están en el feed (borrados en Google sin token),
  // EXCEPTO los tombstones de borrado bidireccional pendientes (review B/D: no pisar un delete en curso).
  // ACOTADO A LA VENTANA (review B/D HIGH): el feed full sólo cubre [timeMin, timeMax]; la ausencia de un
  // evento FUERA de la ventana no prueba que se borró en Google → sólo purgamos los que intersectan la
  // ventana (start<=winMax && end>=winMin). Así los eventos legítimos fuera de rango no "desaparecen".
  const locals = await CalendarEvent.find({
    userId,
    source: 'google',
    calendarId: GOOGLE_CAL_ID,
    googleDeletePending: { $ne: true },
    startDate: { $lte: winMax },
    endDate: { $gte: winMin },
  }).select('googleEventId');
  for (const l of locals) {
    if (l.googleEventId && !seen.has(l.googleEventId))
      await CalendarEvent.deleteOne({ _id: l._id });
  }
  // Persistir el cursor nuevo — o LIMPIAR el viejo si no llegó ninguno. Sin el `$unset` (review): cuando
  // `runFull` se alcanza por el 410 (token vencido) y Google no devuelve `nextSyncToken`, el token EXPIRADO
  // quedaba en la DB → el próximo poll haría incremental con él → 410 otra vez → full otra vez → loop de
  // full-syncs cada 5 min. Limpiándolo, el próximo poll hace full limpio (converge) en vez de martillar 410.
  if (nextSyncToken)
    await GoogleConnection.updateOne({ userId }, { $set: { syncToken: nextSyncToken } });
  else await GoogleConnection.updateOne({ userId }, { $unset: { syncToken: '' } });
}

/** Encola un `gcal-poll` por cada usuario conectado (con jitter). Lo llama el job repetible `gcal-poll-all`. */
export async function enqueueGooglePolls(full = false): Promise<number> {
  if (!(await googleEnabled())) return 0;
  const userIds = await GoogleConnection.find({ status: 'connected' }).distinct('userId');
  // jobId idempotente bucketeado por minuto (review): si `gcal-poll-all` falla a mitad de camino y BullMQ
  // lo reintenta, re-encolaría polls para usuarios ya en cola. Con jobId `gcal-poll-<uid>-<inc|full>-<min>`
  // el reintento (mismo minuto) los dedupe. El próximo ciclo (5 min → otro minuto) encola fresco. Los
  // duplicados igual eran benignos (el `withLock waitMs:0` los saltea), pero esto evita el bloat de cola.
  const bucket = Math.floor(Date.now() / 60_000);
  const kind = full ? 'full' : 'inc';
  for (const uid of userIds) {
    await enqueue(
      'gcal-poll',
      { userId: String(uid), full },
      {
        delay: Math.floor(Math.random() * POLL_JITTER_MS),
        jobId: `gcal-poll-${String(uid)}-${kind}-${String(bucket)}`,
      }
    );
  }
  return userIds.length;
}
