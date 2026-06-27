import { ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/lib/http';
import type { CalendarEvent } from '@webmail6/shared';

export const useCalendarStore = defineStore('calendar', () => {
  const events = ref<CalendarEvent[]>([]);

  async function fetchEvents(start: string, end: string) {
    const { data } = await api.get<CalendarEvent[]>('/calendar', { params: { start, end } });
    events.value = data;
  }

  async function createEvent(
    event: Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt' | 'userId'>
  ) {
    const { data } = await api.post<CalendarEvent>('/calendar', event);
    events.value.push(data);
    return data;
  }

  /** Actualiza un evento (drag/resize en el calendario → PATCH parcial) y refleja el resultado. */
  async function updateEvent(id: string, patch: Partial<CalendarEvent>) {
    const { data } = await api.patch<CalendarEvent>(`/calendar/${id}`, patch);
    const i = events.value.findIndex((e) => e.id === id);
    if (i >= 0) events.value[i] = data;
    return data;
  }

  async function deleteEvent(id: string) {
    await api.delete(`/calendar/${id}`);
    events.value = events.value.filter((e) => e.id !== id);
  }

  return { events, fetchEvents, createEvent, updateEvent, deleteEvent };
});
