import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '@/lib/http';
import type { LoginRequest, LoginResponse, User } from '@webmail6/shared';

// Flag NO sensible (sólo un booleano, como `pwa:install-dismissed`) que marca un logout cuya revocación
// server-side quedó PENDIENTE (típico offline: el POST /auth/logout es NetworkOnly y no llega). Persiste en
// localStorage para sobrevivir al cierre de la app instalada y BLOQUEAR la auto-restauración en la próxima
// apertura hasta completar la revocación (dispositivo compartido/perdido — review MED-1).
const PENDING_LOGOUT_KEY = 'auth:pendingLogout';
function setPendingLogout(): void {
  try {
    localStorage.setItem(PENDING_LOGOUT_KEY, '1');
  } catch {
    /* storage no disponible (modo privado/deshabilitado): degradamos al comportamiento anterior */
  }
}
function clearPendingLogout(): void {
  try {
    localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch {
    /* no-op */
  }
}
function hasPendingLogout(): boolean {
  try {
    return localStorage.getItem(PENDING_LOGOUT_KEY) === '1';
  } catch {
    return false;
  }
}

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
    clearPendingLogout(); // un login exitoso supera cualquier logout pendiente previo
    setSession(data.accessToken, data.user);
    return data;
  }

  async function logout() {
    // Logout best-effort: la sesión LOCAL se limpia SIEMPRE y el método NUNCA rechaza, aunque el
    // POST falle (típico en PWA sin conexión: el endpoint es NetworkOnly y rechaza offline). Si
    // rechazara, los callers que hacen `await auth.logout(); router.push('/login')` sin `finally`
    // (p.ej. ComplianceGateView) no llegarían al redirect y la vista privada quedaría montada
    // (review B). Al no rechazar, todos redirigen. El access token muere en memoria al limpiar; la
    // revocación server-side de la cookie httpOnly ocurre cuando el POST sí llega (online).
    // Offline: marcamos el logout como PENDIENTE ANTES del POST. Si el POST no llega, el flag persiste y
    // `restore()` NO reabre la sesión en la próxima apertura (completa la revocación al reconectar). Sólo
    // limpiamos el flag cuando la revocación server-side se confirma (POST 2xx) — cierra MED-1.
    setPendingLogout();
    try {
      await api.post('/auth/logout');
      clearPendingLogout(); // cookie de refresh revocada en el server → ya no hay sesión que restaurar
    } catch {
      /* sin red: el flag queda; restore() completa la revocación al reconectar. El logout local procede. */
    } finally {
      clearSession();
    }
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
    // Logout PENDIENTE de una sesión anterior sin conexión: NO restaurar. Ahora que (posiblemente) hay red,
    // completamos la revocación server-side de la cookie de refresh y quedamos deslogueados. El flag sólo se
    // limpia si el POST confirma; si sigue offline, persiste para reintentar en la próxima apertura (MED-1).
    if (hasPendingLogout()) {
      clearSession();
      try {
        await api.post('/auth/logout');
        clearPendingLogout();
      } catch {
        /* aún sin red: el flag persiste → se reintenta la próxima apertura */
      }
      return false;
    }
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
