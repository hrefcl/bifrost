import type { Job } from 'bullmq';

/**
 * Procesador de la cola de agenda — despacha por `job.name`. Los handlers reales (envío de email de
 * confirmación + ICS, reconciler de Booking/CalendarEvent) se implementan en Fase 3.4; aquí se cablea
 * el dispatch para cumplir el contrato de ciclo de vida (review B HIGH: el worker debe arrancar en boot).
 *
 * En Fase 3.0 NO se encola ningún job todavía (`enqueue` sólo se llama desde el booking de 3.4), así que
 * el worker queda IDLE. Un job de nombre desconocido lanza → BullMQ lo reintenta y, agotados los
 * intentos, queda en la DLQ (visible vía el listener `failed`), evitando un descarte silencioso.
 */
// No-async (devuelve Promise explícita): en Fase 3.0 los handlers son stubs que rechazan; los reales
// de Fase 3.4 (que sí harán await de SMTP/Mongo) reemplazan cada rama.
export function schedulingProcessor(job: Job): Promise<void> {
  switch (job.name) {
    case 'send-email':
      // TODO(Fase 3.4): enviar confirmación/cancelación + ICS por el SMTP del host (idempotente).
      return Promise.reject(
        new Error('scheduling job "send-email" not implemented until Fase 3.4')
      );
    case 'reconcile':
      // TODO(Fase 3.4): reparar Booking↔CalendarEvent y completar reschedules a medias.
      return Promise.reject(new Error('scheduling job "reconcile" not implemented until Fase 3.4'));
    default:
      return Promise.reject(new Error(`scheduling: unknown job name "${job.name}"`));
  }
}
