import type { Types } from 'mongoose';
import { enqueue } from '../scheduling/queue.js';
import { googleConfigured } from '../../config/env.js';

/**
 * Punto ÚNICO desde el que las escrituras de calendario piden un sync a Google (F-gcal G4). No-op si la
 * feature no está configurada. Idempotencia y "último gana" se garantizan en el motor (`sync.ts`): el
 * job lee el evento FRESCO, así que jobs duplicados convergen sin duplicar en Google. Es FAIL-SOFT: un
 * fallo de encolado NUNCA tumba la escritura local (el reconciler recupera los pendientes).
 */
export async function enqueueGoogleSync(eventId: Types.ObjectId | string): Promise<void> {
  if (!googleConfigured()) return;
  try {
    await enqueue('gcal-sync', { eventId: String(eventId) });
  } catch {
    /* fail-soft: la escritura local ya se hizo; el reconciler reintentará */
  }
}
