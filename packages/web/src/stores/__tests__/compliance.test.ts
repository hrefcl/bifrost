import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/http', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

import { useComplianceStore } from '../compliance';

describe('compliance store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    get.mockReset();
    post.mockReset();
  });

  it('fetchPending hidrata enforcement y documents', async () => {
    get.mockResolvedValueOnce({
      data: {
        enforcement: 'block_full',
        documents: [
          { key: 'tos', title: 'T', version: 1, enforcement: 'block_full', blocking: true },
        ],
      },
    });
    const s = useComplianceStore();
    await s.fetchPending();
    expect(s.enforcement).toBe('block_full');
    expect(s.pending).toHaveLength(1);
    expect(s.blockFull).toBe(true);
    expect(s.hasPending).toBe(true);
  });

  it('fetchPending ante error no asume bloqueo (backend es la autoridad)', async () => {
    get.mockRejectedValueOnce(new Error('net'));
    const s = useComplianceStore();
    await s.fetchPending();
    expect(s.enforcement).toBe('none');
    expect(s.blockFull).toBe(false);
  });

  it('blockPartial true sólo con enforcement block_partial y doc bloqueante', async () => {
    get.mockResolvedValueOnce({
      data: {
        enforcement: 'block_partial',
        documents: [
          { key: 'aup', title: 'A', version: 2, enforcement: 'block_partial', blocking: true },
        ],
      },
    });
    const s = useComplianceStore();
    await s.fetchPending();
    expect(s.blockPartial).toBe(true);
    expect(s.blockFull).toBe(false);
  });

  it('accept hace POST y refresca pending', async () => {
    post.mockResolvedValueOnce({ data: { accepted: true } });
    get.mockResolvedValueOnce({ data: { enforcement: 'none', documents: [] } });
    const s = useComplianceStore();
    await s.accept('tos', 1, 'scroll_confirmed', 'es');
    expect(post).toHaveBeenCalledWith('/compliance/accept', {
      documentKey: 'tos',
      version: 1,
      method: 'scroll_confirmed',
      locale: 'es',
    });
    expect(s.blockFull).toBe(false); // tras refrescar, ya no bloquea
  });

  it('markRequired (desde el interceptor 403) fija bloqueo y documentos', () => {
    const s = useComplianceStore();
    s.markRequired([
      { key: 'tos', title: 'T', version: 1, enforcement: 'block_full', blocking: true },
    ]);
    expect(s.blockFull).toBe(true);
    expect(s.pending).toHaveLength(1);
  });

  it('markRequired sin documentos igual marca bloqueo total (D-001: evita loop por 403 inconsistente)', () => {
    const s = useComplianceStore();
    s.markRequired(undefined);
    expect(s.blockFull).toBe(true);
  });

  it('fetchPending ante error NO limpia un bloqueo ya marcado por el interceptor (D-002)', async () => {
    const s = useComplianceStore();
    s.markRequired([
      { key: 'tos', title: 'T', version: 1, enforcement: 'block_full', blocking: true },
    ]);
    expect(s.blockFull).toBe(true);
    get.mockRejectedValueOnce(new Error('net')); // refresh transitorio falla
    await s.fetchPending();
    expect(s.blockFull).toBe(true); // el bloqueo se conserva (no se resetea a none)
  });

  it('accept no relanza si el refresh posterior falla (D-003: el POST ya registró)', async () => {
    post.mockResolvedValueOnce({ data: { accepted: true } });
    get.mockRejectedValueOnce(new Error('net'));
    const s = useComplianceStore();
    await expect(s.accept('tos', 1, 'scroll_confirmed', 'es')).resolves.toBeUndefined();
  });

  it('soft enforcement: hasPending pero NO blockFull/blockPartial', async () => {
    get.mockResolvedValueOnce({
      data: {
        enforcement: 'none',
        documents: [
          { key: 'cookies', title: 'C', version: 1, enforcement: 'soft', blocking: false },
        ],
      },
    });
    const s = useComplianceStore();
    await s.fetchPending();
    expect(s.hasPending).toBe(true);
    expect(s.blockFull).toBe(false);
    expect(s.blockPartial).toBe(false);
  });
});
