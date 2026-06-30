import type { Job } from 'bullmq';
import { sendBookingEmail, type EmailKind } from './email.js';
import { runReconcile } from './reconciler.js';

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
    case 'reconcile':
      return runReconcile().then(() => undefined);
    default:
      return Promise.reject(new Error(`scheduling: unknown job name "${job.name}"`));
  }
}
