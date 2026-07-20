import type { Job } from 'bullmq';
import { sendBookingEmail, type EmailKind } from './email.js';
import { sendEventInvite } from './event-email.js';
import { runReconcile } from './reconciler.js';
import { syncEventToGoogle } from '../google/sync.js';
import { pollUserCalendar, enqueueGooglePolls } from '../google/poll.js';
import { runMeetJanitor } from '../meet/janitor.js';

/**
 * Procesador de la cola de agenda — despacha por `job.name` (review B HIGH de Fase 3.0: el worker debe
 * arrancar en boot). Handlers reales de Fase 3.4:
 *  - `send-email`: confirmación / cancelación / reprogramación + ICS por el SMTP del host (idempotente
 *    vía jobId determinista). Un fallo transitorio reintenta (attempts/backoff); agotado → DLQ.
 *  - `reconcile`: repara estados parciales Booking↔CalendarEvent y reprogramaciones a medias.
 */
export function schedulingProcessor(job: Job): Promise<void> {
  switch (job.name) {
    case 'send-email': {
      const data = job.data as { bookingId?: string; kind?: EmailKind };
      if (!data.bookingId || !data.kind) {
        return Promise.reject(new Error('send-email: bookingId y kind requeridos'));
      }
      return sendBookingEmail(data.bookingId, data.kind);
    }
    case 'send-event-invite': {
      // Invitación de un evento de calendario a UN attendee (idempotente por jobId).
      const data = job.data as { eventId?: string; email?: string };
      if (!data.eventId || !data.email) {
        return Promise.reject(new Error('send-event-invite: eventId y email requeridos'));
      }
      return sendEventInvite(data.eventId, data.email);
    }
    case 'gcal-sync': {
      // Sync de UN evento con Google Calendar (F-gcal). Idempotente: lee el evento fresco y converge.
      const data = job.data as { eventId?: string };
      if (!data.eventId) return Promise.reject(new Error('gcal-sync: eventId requerido'));
      return syncEventToGoogle(data.eventId);
    }
    case 'gcal-poll': {
      // Poll bidireccional de UN usuario (import Google→Bifrost). `full` = sync de ventana + reconcile.
      const data = job.data as { userId?: string; full?: boolean };
      if (!data.userId) return Promise.reject(new Error('gcal-poll: userId requerido'));
      return pollUserCalendar(data.userId, { full: data.full });
    }
    case 'gcal-poll-all':
      // Fan-out repetible: encola un gcal-poll por usuario conectado (incremental).
      return enqueueGooglePolls(false).then(() => undefined);
    case 'gcal-window-refresh':
      // Fan-out repetible diario: gcal-poll FULL por usuario (renueva la ventana rolling).
      return enqueueGooglePolls(true).then(() => undefined);
    case 'meet-janitor':
      // Red de seguridad de las videollamadas: cierra salas con un solo participante colgado (pestaña
      // olvidada). Se loguea sólo si cerró algo — es señal operativa, no ruido de cada barrido.
      return runMeetJanitor().then((r) => {
        if (r.closed > 0) {
          console.warn(
            `[meet] janitor cerró ${String(r.closed)} sala(s) inactiva(s) de ${String(r.seen)} viva(s)`
          );
        }
      });
    case 'reconcile':
      // Observabilidad (auto-auditoría): el reconciler descartaba sus conteos. Si reparó algo, es señal
      // operativa de crashes/races entre Booking↔CalendarEvent — se loguea para no dejarlo invisible.
      return runReconcile().then((r) => {
        if (r.linked || r.reschedules || r.orphanCe || r.gcalRequeued) {
          console.warn(
            `[scheduling] reconcile reparó: linked=${String(r.linked)} reschedules=${String(r.reschedules)} orphanCe=${String(r.orphanCe)} gcalRequeued=${String(r.gcalRequeued)}`
          );
        }
      });
    default:
      return Promise.reject(new Error(`scheduling: unknown job name "${job.name}"`));
  }
}
