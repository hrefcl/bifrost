import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '@/lib/http';
import type { LoginRequest, LoginResponse, User } from '@webmail6/shared';

export const useAuthStore = defineStore('auth', () => {
  // Token SÓLO en memoria (no localStorage): evita exfiltración por XSS al renderizar
  // HTML de emails. La sesión sobrevive al reload vía la cookie httpOnly de refresh.
  const accessToken = ref<string | null>(null);
  const user = ref<User | null>(null);
  const isAuthenticated = computed(() => Boolean(accessToken.value));

  function setSession(token: string, userData: User) {
    accessToken.value = token;
    user.value = userData;
    api.defaults.headers.Authorization = `Bearer ${token}`;
  }

  function clearSession() {
    accessToken.value = null;
    user.value = null;
    delete api.defaults.headers.Authorization;
  }

  async function login(payload: LoginRequest) {
    const { data } = await api.post<LoginResponse>('/auth/login', payload);
    setSession(data.accessToken, data.user);
    return data;
  }

  async function logout() {
    await api.post('/auth/logout');
    clearSession();
  }

  // Single-flight: si ya hay un refresh en vuelo, todas las llamadas comparten la
  // MISMA promesa. Sin esto, dos refresh concurrentes mandarían la misma cookie dos
  // veces → el 2º dispara la detección de reuse en el server → mata la sesión sola.
  let inflight: Promise<string> | null = null;
  async function refresh(): Promise<string> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { data } = await api.post<{ accessToken: string }>('/auth/refresh');
        accessToken.value = data.accessToken;
        api.defaults.headers.Authorization = `Bearer ${data.accessToken}`;
        return data.accessToken;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** Restaura la sesión al cargar la página usando la cookie httpOnly de refresh. */
  async function restore(): Promise<boolean> {
    try {
      await refresh();
      const { data } = await api.get<User>('/auth/me');
      user.value = data;
      return true;
    } catch {
      clearSession();
      return false;
    }
  }

  // Interceptor: si una request da 401 (access token vencido a los 15min), renueva con
  // refresh() (single-flight) y reintenta UNA vez. Sin esto la sesión moría a los 15min
  // pese a tener la cookie de refresh viva.
  api.interceptors.response.use(
    (r) => r,
    async (err: AxiosError) => {
      const original = err.config as
        | (InternalAxiosRequestConfig & { _retried?: boolean })
        | undefined;
      if (
        err.response?.status === 401 &&
        original &&
        !original._retried &&
        !original.url?.includes('/auth/refresh') &&
        !original.url?.includes('/auth/login')
      ) {
        original._retried = true;
        let token: string;
        try {
          token = await refresh();
        } catch {
          clearSession();
          return Promise.reject(err);
        }
        original.headers.Authorization = `Bearer ${token}`;
        return api(original); // el retry propaga su propio resultado/rechazo
      }
      return Promise.reject(err);
    }
  );

  return {
    accessToken,
    user,
    isAuthenticated,
    login,
    logout,
    refresh,
    restore,
    setSession,
    clearSession,
  };
});
