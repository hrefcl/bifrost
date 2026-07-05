import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();
// El store usa api.get/post + api.defaults.headers + api.interceptors al inicializar → mockear todo.
vi.mock('@/lib/http', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    defaults: { headers: {} as Record<string, string> },
    interceptors: { response: { use: vi.fn() } },
  },
}));

import { useAuthStore } from '../auth';

const PENDING = 'auth:pendingLogout';

describe('auth store — logout offline / MED-1', () => {
  beforeEach(() => {
    // Entorno de test = 'node' (sin localStorage): stub en memoria para ejercitar el flag de logout pendiente.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    });
    setActivePinia(createPinia());
    get.mockReset();
    post.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logout ONLINE: revoca en el server y NO deja logout pendiente', async () => {
    post.mockResolvedValueOnce({ data: {} }); // POST /auth/logout OK
    const s = useAuthStore();
    await s.logout();
    expect(localStorage.getItem(PENDING)).toBeNull();
    expect(s.isAuthenticated).toBe(false);
  });

  it('logout OFFLINE: limpia local pero deja el flag de logout pendiente', async () => {
    post.mockRejectedValueOnce(new Error('network')); // sin red
    const s = useAuthStore();
    await expect(s.logout()).resolves.toBeUndefined(); // nunca rechaza
    expect(localStorage.getItem(PENDING)).toBe('1');
    expect(s.isAuthenticated).toBe(false);
  });

  it('restore() con logout pendiente NO restaura y completa la revocación al reconectar', async () => {
    localStorage.setItem(PENDING, '1');
    post.mockResolvedValueOnce({ data: {} }); // /auth/logout ahora sí llega (online)
    const s = useAuthStore();
    const ok = await s.restore();
    expect(ok).toBe(false);
    // Revocó server-side (POST /auth/logout) y NO intentó refrescar la sesión.
    expect(post).toHaveBeenCalledWith('/auth/logout');
    expect(post).not.toHaveBeenCalledWith('/auth/refresh');
    expect(localStorage.getItem(PENDING)).toBeNull(); // confirmada la revocación → flag limpio
    expect(s.isAuthenticated).toBe(false);
  });

  it('restore() con logout pendiente aún OFFLINE mantiene el flag para reintentar', async () => {
    localStorage.setItem(PENDING, '1');
    post.mockRejectedValueOnce(new Error('network')); // sigue sin red
    const s = useAuthStore();
    const ok = await s.restore();
    expect(ok).toBe(false);
    expect(localStorage.getItem(PENDING)).toBe('1'); // persiste hasta confirmar la revocación
  });

  it('login exitoso limpia un logout pendiente previo', async () => {
    localStorage.setItem(PENDING, '1');
    post.mockResolvedValueOnce({ data: { accessToken: 'tok', user: { id: 'u1' } } });
    const s = useAuthStore();
    await s.login({ email: 'a@x.com', password: 'p' } as never);
    expect(localStorage.getItem(PENDING)).toBeNull();
    expect(s.isAuthenticated).toBe(true);
  });
});
