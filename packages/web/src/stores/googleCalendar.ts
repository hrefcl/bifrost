import { ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/lib/http';

/** Estado PÚBLICO de la conexión con Google (sin tokens; lo expone GET /calendar/google/status). */
export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email?: string | null;
  status?: 'connected' | 'error' | 'revoked';
  error?: string | null;
  lastSyncedAt?: string | null;
}

/**
 * Store de la integración con Google Calendar (F-gcal G5). Sólo estado de conexión + acciones
 * connect/disconnect. NUNCA maneja tokens: viven cifrados en el backend y jamás llegan al frontend.
 */
export const useGoogleCalendarStore = defineStore('googleCalendar', () => {
  const status = ref<GoogleStatus>({ configured: false, connected: false });
  const loading = ref(false);
  const connecting = ref(false);

  async function fetchStatus(): Promise<void> {
    loading.value = true;
    try {
      const { data } = await api.get<GoogleStatus>('/calendar/google/status');
      status.value = data;
    } finally {
      loading.value = false;
    }
  }

  /** Pide la URL de consentimiento y navega a Google (top-level → vuelve al callback del backend). */
  async function connect(): Promise<void> {
    connecting.value = true;
    try {
      const { data } = await api.get<{ url: string }>('/calendar/google/connect');
      window.location.href = data.url;
    } catch {
      connecting.value = false; // si falló pedir la URL, se libera el botón
    }
  }

  async function disconnect(): Promise<void> {
    await api.post('/calendar/google/disconnect');
    await fetchStatus();
  }

  return { status, loading, connecting, fetchStatus, connect, disconnect };
});
