import { randomBytes } from 'node:crypto';
import type mongoose from 'mongoose';
import type { StoredMeetSettings } from './settings.js';
import { MeetRoom, type IMeetRoom } from '../../models/MeetRoom.js';
import { closeLiveKitRoom, clampMaxParticipants } from './token-service.js';

/**
 * Integración Meet ↔ agenda (F3.2). Estas funciones SÓLO escriben Mongo — **cero RPC LiveKit** — para
 * poder correr DENTRO del lock de `createBooking` sin acoplar la reserva al video (review C-H2). La
 * sala LiveKit se auto-crea al primer join; `ensureRoom`/`closeLiveKitRoom` (RPC) corren fuera del lock.
 */

const GRACE_MS = 30 * 60 * 1000; // expiresAt = endAt + 30m (alineado a la gracia del token)
const PURGE_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // GC largo de la fila (TTL sobre purgeAt)

/** Slug global, no enumerable (128 bits). */
export function generateMeetSlug(): string {
  return randomBytes(16).toString('base64url');
}

/** ¿Colisión del índice único de `slug` (no de `bookingId`)? Sólo el slug se regenera. */
function isSlugCollision(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  if (e.code !== 11000) return false;
  // Driver normal expone keyPattern; fallback al mensaje por si alguna versión no lo trae (review D-007).
  if (e.keyPattern) return Object.prototype.hasOwnProperty.call(e.keyPattern, 'slug');
  return typeof e.message === 'string' && e.message.includes('slug');
}

export interface BookingMeetRoom {
  meetRoomId: mongoose.Types.ObjectId;
  slug: string;
  meetUrl: string;
}

/**
 * Crea la `MeetRoom` de una reserva (write REQUERIDO, idempotente por `bookingId`). Las salas de booking
 * FUERZAN `allowExternalOverride:true` (el invitado externo recibió el link de la reserva — review C-M5/D-006)
 * y setean `expiresAt`/`purgeAt`. Reintenta hasta 3× sólo ante colisión de `slug`. Idempotente: si ya
 * existe una sala para ese `bookingId` (replay), la reusa en vez de crear otra.
 *
 * LANZA si no logra crear (el caller en `createBooking` lo captura → modo degradado, NUNCA aborta la reserva).
 */
export async function createBookingMeetRoom(params: {
  bookingId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  name: string;
  endAt: Date;
  settings: StoredMeetSettings;
}): Promise<BookingMeetRoom> {
  const { bookingId, userId, name, endAt, settings } = params;

  // Idempotencia: ¿ya hay sala para este booking? (replay del POST). Reusar su slug/URL.
  const existing = await MeetRoom.findOne({ bookingId }).lean<Pick<
    IMeetRoom,
    '_id' | 'slug'
  > | null>();
  if (existing) {
    return {
      meetRoomId: existing._id,
      slug: existing.slug,
      meetUrl: meetUrlFor(settings, existing.slug),
    };
  }

  const expiresAt = new Date(endAt.getTime() + GRACE_MS);
  const purgeAt = new Date(endAt.getTime() + PURGE_DAYS_MS);
  const maxParticipants = clampMaxParticipants(settings.maxParticipants, settings);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = generateMeetSlug();
    try {
      const room = await MeetRoom.create({
        userId,
        slug,
        name,
        mode: 'per_event',
        status: 'active',
        source: 'booking',
        bookingId,
        maxParticipants,
        allowExternalOverride: true,
        expiresAt,
        purgeAt,
      });
      return { meetRoomId: room._id, slug, meetUrl: meetUrlFor(settings, slug) };
    } catch (err) {
      lastErr = err;
      if (isSlugCollision(err) && attempt < 2) continue; // sólo el slug colisiona → regenerar
      // Si chocó por {bookingId} (otra request creó la sala en paralelo), reusarla (idempotencia).
      const raced = await MeetRoom.findOne({ bookingId }).lean<Pick<
        IMeetRoom,
        '_id' | 'slug'
      > | null>();
      if (raced) {
        return {
          meetRoomId: raced._id,
          slug: raced.slug,
          meetUrl: meetUrlFor(settings, raced.slug),
        };
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('createBookingMeetRoom failed');
}

/** Borra la sala de una reserva (compensación cuando el insert de la Booking falla). Hard delete. */
export async function deleteMeetRoomById(meetRoomId: mongoose.Types.ObjectId): Promise<void> {
  await MeetRoom.deleteOne({ _id: meetRoomId });
}

/** id de la sala de una reserva (read-only), o null si no tiene. */
export async function getMeetRoomIdForBooking(
  bookingId: mongoose.Types.ObjectId
): Promise<mongoose.Types.ObjectId | null> {
  const r = await MeetRoom.findOne({ bookingId })
    .select('_id')
    .lean<{ _id: mongoose.Types.ObjectId } | null>();
  return r?._id ?? null;
}

/**
 * Migra la sala de un booking a otro (reschedule): el nuevo booking hereda el snapshot (mismo `meetUrl`),
 * así que sólo movemos el `bookingId` y recalculamos `expiresAt`/`purgeAt` con el nuevo fin. Idempotente.
 * Devuelve la sala migrada o null si el booking original no tenía sala.
 */
export async function migrateMeetRoomToBooking(params: {
  fromBookingId: mongoose.Types.ObjectId;
  toBookingId: mongoose.Types.ObjectId;
  newEndAt: Date;
}): Promise<{ meetRoomId: mongoose.Types.ObjectId; slug: string } | null> {
  const { fromBookingId, toBookingId, newEndAt } = params;
  // Idempotente (review B-LOW): matchea la sala SEA que esté en `from` (aún no migrada) o ya en `to`
  // (reintento tras migración exitosa) → un retry no devuelve null.
  const room = await MeetRoom.findOneAndUpdate(
    { bookingId: { $in: [fromBookingId, toBookingId] } },
    {
      $set: {
        bookingId: toBookingId,
        expiresAt: new Date(newEndAt.getTime() + GRACE_MS),
        purgeAt: new Date(newEndAt.getTime() + PURGE_DAYS_MS),
        status: 'active',
      },
    },
    { new: true }
  );
  return room ? { meetRoomId: room._id, slug: room.slug } : null;
}

/**
 * Cierra (soft) la sala de una reserva cancelada + deleteRoom best-effort en LiveKit (desconecta activos).
 * No-fatal. Idempotente (si ya está closed, el update no hace nada relevante).
 */
export async function closeMeetRoomForBooking(params: {
  bookingId: mongoose.Types.ObjectId;
  settings: StoredMeetSettings;
}): Promise<void> {
  const { bookingId, settings } = params;
  const room = await MeetRoom.findOneAndUpdate(
    { bookingId, status: 'active' },
    { $set: { status: 'closed' } },
    { new: false }
  ).lean<Pick<IMeetRoom, 'slug'> | null>();
  if (room) await closeLiveKitRoom(settings, room.slug);
}

function meetUrlFor(settings: StoredMeetSettings, slug: string): string {
  return `${settings.publicBaseUrl.replace(/\/+$/, '')}/meet/${slug}`;
}
