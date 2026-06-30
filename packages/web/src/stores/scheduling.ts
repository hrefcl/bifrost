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
  async function updateSchedule(id: string, patch: Partial<AvailabilityInput>) {
    const { data } = await api.patch<AvailabilitySchedule>(`/schedule/availability/${id}`, patch);
    await fetchSchedules();
    return data;
  }
  async function deleteSchedule(id: string) {
    await api.delete(`/schedule/availability/${id}`);
    await fetchSchedules();
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
    fetchProfile,
    setUsername,
    fetchBookings,
    cancelBooking,
  };
});

export type { EventType, AvailabilitySchedule, Booking, MeetingLocation, CustomQuestion };
