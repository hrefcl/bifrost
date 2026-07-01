import { ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/lib/http';
import type {
  EventType,
  AvailabilitySchedule,
  Booking,
  WeeklyRule,
  AvailabilityOverride,
  MeetingLocation,
  CustomQuestion,
} from '@webmail6/shared';

/** Payloads de creación/edición (lo que la UI manda; el server completa el resto). */
export type EventTypeInput = Omit<EventType, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;
export interface AvailabilityInput {
  name: string;
  timezone: string;
  weeklyRules: WeeklyRule[];
  overrides: AvailabilityOverride[];
  isDefault?: boolean;
}

/**
 * Store de la agenda (host) — wrapea las rutas autenticadas /api/schedule (Fase 3.3). Mantiene en
 * memoria los tipos de reunión, los horarios y las reservas del usuario, y el username público.
 */
export const useSchedulingStore = defineStore('scheduling', () => {
  const eventTypes = ref<EventType[]>([]);
  const schedules = ref<AvailabilitySchedule[]>([]);
  const bookings = ref<Booking[]>([]);
  const username = ref<string | null>(null);

  // ── event types ──
  async function fetchEventTypes() {
    const { data } = await api.get<EventType[]>('/schedule/event-types');
    eventTypes.value = data;
  }
  async function createEventType(input: EventTypeInput) {
    const { data } = await api.post<EventType>('/schedule/event-types', input);
    eventTypes.value.push(data);
    return data;
  }
  async function updateEventType(id: string, patch: Partial<EventTypeInput>) {
    const { data } = await api.patch<EventType>(`/schedule/event-types/${id}`, patch);
    const i = eventTypes.value.findIndex((e) => e.id === id);
    if (i >= 0) eventTypes.value[i] = data;
    return data;
  }
  /** DELETE = soft (active:false). Refresca para reflejar el estado. */
  async function deleteEventType(id: string) {
    await api.delete(`/schedule/event-types/${id}`);
    const ev = eventTypes.value.find((e) => e.id === id);
    if (ev) ev.active = false;
  }

  // ── availability ──
  async function fetchSchedules() {
    const { data } = await api.get<AvailabilitySchedule[]>('/schedule/availability');
    schedules.value = data;
  }
  async function createSchedule(input: AvailabilityInput) {
    const { data } = await api.post<AvailabilitySchedule>('/schedule/availability', input);
    await fetchSchedules();
    return data;
  }
  /**
   * `expectedUpdatedAt` (opcional): control de concurrencia optimista. Si se pasa, el backend hace un
   * CAS atómico y responde 409 si el horario cambió desde ese `updatedAt` (review B-HIGH).
   */
  async function updateSchedule(
    id: string,
    patch: Partial<AvailabilityInput> & { expectedUpdatedAt?: string }
  ) {
    const { data } = await api.patch<AvailabilitySchedule>(`/schedule/availability/${id}`, patch);
    await fetchSchedules();
    return data;
  }
  async function deleteSchedule(id: string) {
    await api.delete(`/schedule/availability/${id}`);
    await fetchSchedules();
  }

  /** Firma estable de un set de overrides (orden-independiente) para detectar cambios concurrentes. */
  function overridesSignature(list: AvailabilityOverride[]): string {
    return JSON.stringify(
      [...list]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((o) => ({
          d: o.date,
          n: o.note ?? '',
          i: o.intervals.map((iv) => `${iv.start}-${iv.end}`),
        }))
    );
  }

  /**
   * Guarda excepciones (overrides) de forma segura ante concurrencia (review C-MUST-1 / B-HIGH):
   *  1. RE-FETCH fresco del schedule (no confiar en el estado en memoria, posiblemente stale),
   *  2. PRE-CHEQUEO en cliente (UX/early-exit): si `baseline` (lo que el usuario tenía al abrir el
   *     editor) ya no coincide con el array fresco, otra sesión lo cambió → se aborta antes de la red,
   *  3. aplicar la mutación puntual SOBRE el array recién traído (clonado),
   *  4. PATCH enviando SOLO `{ overrides }` + `expectedUpdatedAt` → el backend hace un CAS ATÓMICO
   *     (filtro por `updatedAt`); si otra escritura ganó la carrera, responde 409 → 'overrides-conflict'.
   *     El `$set` parcial NO pisa `weeklyRules`/`timezone` (availabilityBody.partial()). El guard real es
   *     el CAS del backend; el pre-chequeo en cliente sólo evita un round-trip en el caso común.
   * `baseline=null` omite el pre-chequeo en cliente (el CAS atómico sigue activo).
   */
  async function saveOverrides(
    scheduleId: string,
    baseline: AvailabilityOverride[] | null,
    mutate: (current: AvailabilityOverride[]) => AvailabilityOverride[]
  ) {
    await fetchSchedules();
    const fresh = schedules.value.find((s) => s.id === scheduleId);
    if (!fresh) throw new Error('schedule-not-found');
    // Pre-chequeo en cliente (UX/early-exit): si el array fresco difiere del baseline, otra sesión lo
    // cambió → conflicto antes de la red.
    if (baseline !== null && overridesSignature(baseline) !== overridesSignature(fresh.overrides)) {
      throw new Error('overrides-conflict');
    }
    const cloned: AvailabilityOverride[] = fresh.overrides.map((o) => ({
      date: o.date,
      note: o.note,
      intervals: o.intervals.map((iv) => ({ start: iv.start, end: iv.end })),
    }));
    const next = mutate(cloned);
    // CAS ATÓMICO autoritativo (review B-HIGH): `expectedUpdatedAt` = updatedAt del doc fresco; si otra
    // escritura ganó la carrera entre el fetch y este PATCH, el backend responde 409 → 'overrides-conflict'.
    try {
      return await updateSchedule(scheduleId, {
        overrides: next,
        expectedUpdatedAt: fresh.updatedAt,
      });
    } catch (e) {
      if ((e as { response?: { status?: number } }).response?.status === 409) {
        await fetchSchedules(); // refrescar para que la UI muestre el estado real al reintentar
        throw new Error('overrides-conflict');
      }
      throw e;
    }
  }

  // ── profile (username) ──
  async function fetchProfile() {
    const { data } = await api.get<{ username: string | null }>('/schedule/profile');
    username.value = data.username;
  }
  async function setUsername(value: string | null) {
    const { data } = await api.patch<{ username: string | null }>('/schedule/profile', {
      username: value,
    });
    username.value = data.username;
    return data.username;
  }

  // ── bookings ──
  async function fetchBookings(params?: { from?: string; to?: string; status?: string }) {
    const { data } = await api.get<Booking[]>('/schedule/bookings', { params });
    bookings.value = data;
  }
  async function cancelBooking(id: string, reason?: string) {
    const { data } = await api.post<Booking>(`/schedule/bookings/${id}/cancel`, { reason });
    const i = bookings.value.findIndex((b) => b.id === id);
    if (i >= 0) bookings.value[i] = data;
    return data;
  }

  return {
    eventTypes,
    schedules,
    bookings,
    username,
    fetchEventTypes,
    createEventType,
    updateEventType,
    deleteEventType,
    fetchSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    saveOverrides,
    fetchProfile,
    setUsername,
    fetchBookings,
    cancelBooking,
  };
});

export type { EventType, AvailabilitySchedule, Booking, MeetingLocation, CustomQuestion };
