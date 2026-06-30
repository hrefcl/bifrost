import { Booking, type IBooking } from '../../models/Booking.js';
import { CalendarEvent } from '../../models/CalendarEvent.js';
import { Account } from '../../models/Account.js';
import { EventType } from '../../models/EventType.js';
import { hostCalendarDay } from '../../lib/scheduling/time.js';
import { buildBusy, confirmedCountByDay, overlapsAny, BUSY_PAD_MS } from './booking-service.js';

/**
 * Reconciler (job repetible BullMQ) — repara estados parciales dejados por un CRASH entre las escrituras
 * no-transaccionales del booking (Mongo single-node). Idempotente. Review B-HIGH/C-H2/H3, D-076/078/079.
 *
 *  (1) Booking confirmada sin `calendarEventId` (más antigua que GRACE, para no competir con un create en
 *      vuelo): si existe un CE con su `icsUid` → LINKEA; si no → lo crea (con campos completos; E11000 → relink).
 *  (2) Booking con `pendingReschedule`: RE-VALIDA el slot de la nueva (excluyendo nueva y vieja). Si sigue
 *      válido → completa (retira la vieja). Si ya NO es válido (otra reserva la solapó en la ventana de
 *      crash) → cancela la nueva y deja la vieja intacta (review D-076 / diseño v3.3).
 *  (3) CalendarEvent `source:'booking'` cuya Booking ya no está `confirmed` (o fue borrada) → se marca cancelled.
 */
const BATCH = 200;
const GRACE_MS = 60_000;

export async function runReconcile(): Promise<{
  linked: number;
  reschedules: number;
  orphanCe: number;
}> {
  let linked = 0;
  let reschedules = 0;
  let orphanCe = 0;
  const cutoff = new Date(Date.now() - GRACE_MS);

  // (1) Bookings confirmadas sin CalendarEvent (con grace para no pisar un create en vuelo).
  const missing = await Booking.find({
    status: 'confirmed',
    calendarEventId: { $exists: false },
    createdAt: { $lt: cutoff },
  }).limit(BATCH);
  for (const b of missing) {
    const existing = await CalendarEvent.findOne({ uid: b.icsUid, source: 'booking' });
    if (existing) {
      await Booking.updateOne({ _id: b._id }, { $set: { calendarEventId: existing._id } });
    } else {
      const account = await Account.findOne({ userId: b.userId, isPrimary: true }).select('_id');
      if (!account) continue; // sin cuenta no se puede proyectar; se reintenta en el próximo ciclo
      try {
        const ce = await CalendarEvent.create({
          userId: b.userId,
          accountId: account._id,
          calendarId: 'bifrost-scheduling',
          calendarName: 'Reuniones',
          uid: b.icsUid,
          summary: `${b.snapshot.title} · ${b.invitee.name}`,
          description: `Invitado: ${b.invitee.name} <${b.invitee.email}>`,
          location: b.snapshot.location.value,
          startDate: b.startAt,
          endDate: b.endAt,
          startTimezone: b.snapshot.timezone,
          endTimezone: b.snapshot.timezone,
          status: 'confirmed',
          source: 'booking',
          bookingId: b._id,
        });
        await Booking.updateOne({ _id: b._id }, { $set: { calendarEventId: ce._id } });
      } catch {
        // Race con el flujo principal (creó el CE entre medio): re-linkear por uid.
        const ce = await CalendarEvent.findOne({ uid: b.icsUid, source: 'booking' });
        if (ce) await Booking.updateOne({ _id: b._id }, { $set: { calendarEventId: ce._id } });
        else continue;
      }
    }
    linked++;
  }

  // (2) Reprogramaciones a medias (review B). Se LEE primero la vieja y se ramifica para no dejar al
  // invitado sin ninguna confirmada:
  //   - vieja ya 'rescheduled' hacia neo (crash POST-retire/PRE-unset): sólo completar limpieza, conservar neo.
  //   - vieja aún 'confirmed' (crash PRE-retire): decidir por si el slot de neo SIGUE LIBRE (overlap+límite).
  //   - vieja inexistente/otro estado: limpiar el flag conservadoramente (neo queda confirmada).
  const pending = await Booking.find({ pendingReschedule: true, createdAt: { $lt: cutoff } }).limit(
    BATCH
  );
  for (const neo of pending) {
    const old = neo.rescheduledFromId ? await Booking.findById(neo.rescheduledFromId) : null;
    if (old?.status === 'rescheduled' && old.rescheduledToId?.toString() === neo._id.toString()) {
      if (old.calendarEventId) {
        await CalendarEvent.updateOne(
          { _id: old.calendarEventId },
          { $set: { status: 'cancelled' } }
        );
      }
      await Booking.updateOne({ _id: neo._id }, { $unset: { pendingReschedule: 1 } });
    } else if (old?.status === 'confirmed') {
      if (await isRescheduleSlotFree(neo)) {
        // CAS atómico: retirar la vieja SÓLO si sigue confirmed. Si un retry concurrente la cambió entre
        // el read y aquí (modifiedCount=0), NO se limpia pendingReschedule → el PRÓXIMO ciclo re-evalúa y
        // cae en la rama 'old rescheduled→OTRA' que cancela esta neo fantasma (review B). Idempotente.
        const retired = await Booking.updateOne(
          { _id: old._id, status: 'confirmed' },
          { $set: { status: 'rescheduled', rescheduledToId: neo._id } }
        );
        if (retired.modifiedCount === 1) {
          if (old.calendarEventId) {
            await CalendarEvent.updateOne(
              { _id: old.calendarEventId },
              { $set: { status: 'cancelled' } }
            );
          }
          await Booking.updateOne({ _id: neo._id }, { $unset: { pendingReschedule: 1 } });
        }
      } else {
        // otro tomó el slot de neo durante el crash → cancelar neo; la vieja queda intacta (sin pérdida).
        await Booking.updateOne(
          { _id: neo._id },
          { $set: { status: 'cancelled', cancelledBy: 'host' }, $unset: { pendingReschedule: 1 } }
        );
        if (neo.calendarEventId) {
          await CalendarEvent.updateOne(
            { _id: neo.calendarEventId },
            { $set: { status: 'cancelled' } }
          );
        }
      }
    } else if (old?.status === 'rescheduled') {
      // La vieja fue reagendada a OTRA nueva (el invitado reintentó con el token viejo y ganó otra) →
      // ESTA neo quedó SUPERSEDED → cancelarla para no dejar una reserva/CE fantasma (review B-HIGH).
      await Booking.updateOne(
        { _id: neo._id },
        { $set: { status: 'cancelled', cancelledBy: 'host' }, $unset: { pendingReschedule: 1 } }
      );
      if (neo.calendarEventId) {
        await CalendarEvent.updateOne(
          { _id: neo.calendarEventId },
          { $set: { status: 'cancelled' } }
        );
      }
    } else {
      // vieja inexistente/cancelada → limpiar el flag (neo queda como reserva confirmada independiente).
      await Booking.updateOne({ _id: neo._id }, { $unset: { pendingReschedule: 1 } });
    }
    reschedules++;
  }

  // (3) CalendarEvents de booking cuya reserva ya no está confirmed (o fue borrada) → cancelar el bloque.
  const ces = await CalendarEvent.find({ source: 'booking', status: 'confirmed' })
    .select('bookingId')
    .limit(BATCH);
  for (const ce of ces) {
    if (!ce.bookingId) continue;
    const b = await Booking.findById(ce.bookingId).select('status');
    if (b?.status !== 'confirmed') {
      await CalendarEvent.updateOne({ _id: ce._id }, { $set: { status: 'cancelled' } });
      orphanCe++;
    }
  }

  return { linked, reschedules, orphanCe };
}

/**
 * ¿El slot de la nueva reserva SIGUE LIBRE? El reconcile sólo verifica que NADIE haya tomado el slot
 * durante la ventana de crash: OVERLAP (con buffers del SNAPSHOT de neo) + dailyLimit. NO re-aplica
 * minimumNotice/dateRange/grilla (ya se validaron al reagendar; re-aplicarlos rechazaría falsamente una
 * recuperación legítima, p.ej. con minNotice>0 — review B-HIGH). Excluye neo y la vieja del busy/conteo.
 */
async function isRescheduleSlotFree(neo: IBooking): Promise<boolean> {
  const userId = neo.userId.toString();
  const tz = neo.snapshot.timezone;
  const from = new Date(neo.startAt.getTime() - BUSY_PAD_MS);
  const to = new Date(neo.endAt.getTime() + BUSY_PAD_MS);
  const exclude = [neo._id.toString()];
  if (neo.rescheduledFromId) exclude.push(neo.rescheduledFromId.toString());
  const busy = await buildBusy(userId, from, to, exclude);
  if (
    overlapsAny(
      neo.startAt,
      neo.endAt,
      neo.snapshot.bufferBeforeMin,
      neo.snapshot.bufferAfterMin,
      busy
    )
  ) {
    return false;
  }
  const ev = await EventType.findById(neo.eventTypeId).select('dailyLimit');
  if (ev?.dailyLimit && ev.dailyLimit > 0) {
    const counts = await confirmedCountByDay(userId, from, to, tz, exclude);
    if ((counts.get(hostCalendarDay(neo.startAt, tz)) ?? 0) >= ev.dailyLimit) return false;
  }
  return true;
}
