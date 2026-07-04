import type { Job } from 'bullmq';
import { sendBookingEmail, type EmailKind } from './email.js';
import { runReconcile } from './reconciler.js';
import { syncEventToGoogle } from '../google/sync.js';

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
    case 'gcal-sync': {
      // Sync de UN evento con Google Calendar (F-gcal). Idempotente: lee el evento fresco y converge.
      const data = job.data as { eventId?: string };
      if (!data.eventId) return Promise.reject(new Error('gcal-sync: eventId requerido'));
      return syncEventToGoogle(data.eventId);
    }
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
