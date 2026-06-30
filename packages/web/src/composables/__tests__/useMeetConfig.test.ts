import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del cliente http: contamos cuántas veces se llama GET /config/public.
const get = vi.fn();
vi.mock('@/lib/http', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

const CONFIG = {
  meetEnabled: true,
  livekitWsUrl: 'wss://meet.test',
  meetPublicBaseUrl: 'https://webmail.test',
};

describe('useMeetConfig', () => {
  beforeEach(() => {
    // Resetear módulos → cada test arranca con el caché de módulo limpio (el composable cachea a nivel
    // de módulo, así que sin esto los tests se contaminarían entre sí — review D-007/C-L6).
    vi.resetModules();
    get.mockReset();
  });

  it('carga la config y la cachea (1 sola fetch en llamadas posteriores)', async () => {
    get.mockResolvedValue({ data: CONFIG });
    const { useMeetConfig } = await import('../useMeetConfig');
    const { load, config } = useMeetConfig();
    const c1 = await load();
    expect(c1).toEqual(CONFIG);
    expect(config.value?.meetPublicBaseUrl).toBe('https://webmail.test');
    const c2 = await load();
    expect(c2).toEqual(c1);
    expect(get).toHaveBeenCalledTimes(1); // cacheado
    expect(get).toHaveBeenCalledWith('/config/public');
  });

  it('single-flight REAL: dos load() concurrentes (pre-caché) comparten UNA sola fetch', async () => {
    // Deferred: la fetch no resuelve hasta que la disparamos → las dos llamadas ocurren EN VUELO.
    let resolveGet: (v: { data: typeof CONFIG }) => void = () => undefined;
    get.mockReturnValue(
      new Promise((res) => {
        resolveGet = res;
      })
    );
    const { useMeetConfig } = await import('../useMeetConfig');
    const { load } = useMeetConfig();

    const p1 = load();
    const p2 = load(); // concurrente, ANTES de que la primera resuelva
    expect(get).toHaveBeenCalledTimes(1); // ← la clave: una sola fetch para ambas

    resolveGet({ data: CONFIG });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(CONFIG);
    expect(b).toEqual(a);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
