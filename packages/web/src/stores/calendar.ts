import { ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/lib/http';
import type { CalendarEvent } from '@webmail6/shared';

/** Invitado de ENTRADA: sólo email (+ nombre opcional); el backend añade status/role. */
interface AttendeeInput {
  name?: string;
  email: string;
}
type EventCreateInput = Omit<
  CalendarEvent,
  'id' | 'createdAt' | 'updatedAt' | 'userId' | 'attendees' | 'meetUrl' | 'meetRoomId'
> & { withMeet?: boolean; attendees?: AttendeeInput[] };
type EventPatchInput = Partial<Omit<CalendarEvent, 'attendees'>> & { attendees?: AttendeeInput[] };

export const useCalendarStore = defineStore('calendar', () => {
  const events = ref<CalendarEvent[]>([]);

  // Token de cancelación: al navegar rápido entre rangos, una respuesta vieja no debe
  // sobreescribir el rango actual con datos stale (review B). Además, CADA mutación lo incrementa:
  // así un fetchEvents en vuelo que responda DESPUÉS de un create/update/delete queda invalidado y
  // no pisa el estado local recién mutado (race store, review B+D).
  let fetchToken = 0;
  async function fetchEvents(start: string, end: string) {
    const token = ++fetchToken;
    const { data } = await api.get<CalendarEvent[]>('/calendar', { params: { start, end } });
    if (token === fetchToken) events.value = data;
  }

  async function createEvent(event: EventCreateInput) {
    const { data } = await api.post<CalendarEvent>('/calendar', event);
    fetchToken++; // invalida cualquier fetch en vuelo que pisaría esta inserción.
    events.value.push(data);
    return data;
  }

  /** Actualiza un evento (drag/resize o modal de edición → PATCH parcial) y refleja el resultado. */
  async function updateEvent(id: string, patch: EventPatchInput) {
    const { data } = await api.patch<CalendarEvent>(`/calendar/${id}`, patch);
    fetchToken++; // invalida cualquier fetch en vuelo que pisaría esta edición.
    const i = events.value.findIndex((e) => e.id === id);
    if (i >= 0) events.value[i] = data;
    else events.value.push(data); // si no estaba cargado, mostrarlo igual (review D).
    return data;
  }

  async function deleteEvent(id: string) {
    await api.delete(`/calendar/${id}`);
    fetchToken++; // invalida cualquier fetch en vuelo que reviviría el evento borrado.
    events.value = events.value.filter((e) => e.id !== id);
  }

  return { events, fetchEvents, createEvent, updateEvent, deleteEvent };
});
