import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkForUpdate, __resetUpdateCache } from '../update-check.js';

// BUILD_INFO en test no tiene ENV → build='dev' (no numérico). Para probar la comparación numérica
// seteamos los ENV ANTES de importar; como el módulo lee BUILD_INFO una vez, mockeamos el fetch y
// validamos la lógica con el build actual ('dev' → updateAvailable=false aunque haya latest).
function mockRuns(runNumber: number) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        workflow_runs: [
          {
            run_number: runNumber,
            head_sha: 'abcdef1234567890',
            created_at: '2026-06-29T00:00:00Z',
          },
        ],
      }),
  } as Response;
}

describe('update-check', () => {
  beforeEach(() => {
    __resetUpdateCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('consulta el último run y arma el estado (con build dev no hay update numérico)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockRuns(95));
    const st = await checkForUpdate(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(st.latest?.build).toBe(95);
    expect(st.latest?.sha).toBe('abcdef1'); // truncado a 7
    // build instalado = 'dev' (no numérico) → no se afirma update (evita falsos positivos en dev).
    expect(st.updateAvailable).toBe(false);
    expect(st.behind).toBeNull();
    expect(st.repoUrl).toContain('github.com');
  });

  it('cachea: una 2da llamada sin force NO vuelve a pegarle a GitHub', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockRuns(95));
    await checkForUpdate(true);
    await checkForUpdate(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('degrada a latest=null si GitHub falla (no rompe el admin)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const st = await checkForUpdate(true);
    expect(st.latest).toBeNull();
    expect(st.updateAvailable).toBe(false);
  });
});
