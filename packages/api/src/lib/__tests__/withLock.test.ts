import { describe, it, expect } from 'vitest';
import { withLock } from '../withLock.js';

// Usa el `redis` mock (REDIS_URL=mock en test/setup.ts). El eval Lua del release/extend lo soporta
// ioredis-mock (mismo patrón que withAccountLock en producción).

const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withLock', () => {
  it('corre fn con el lock tomado y devuelve el resultado', async () => {
    const out = await withLock('wl:ok', async () => 42);
    expect(out).toEqual({ skipped: false, result: 42 });
  });

  it('serializa: un segundo intento sobre la misma key mientras el primero corre → skipped', async () => {
    const gate = defer();
    const first = withLock('wl:serial', async () => {
      await gate.promise;
      return 'A';
    });
    await tick(20); // dejar que el primero adquiera
    const second = await withLock('wl:serial', async () => 'B');
    expect(second).toEqual({ skipped: true });
    gate.resolve();
    expect(await first).toEqual({ skipped: false, result: 'A' });
  });

  it('libera al terminar → se puede re-adquirir', async () => {
    expect(await withLock('wl:reuse', async () => 1)).toEqual({ skipped: false, result: 1 });
    expect(await withLock('wl:reuse', async () => 2)).toEqual({ skipped: false, result: 2 });
  });

  it('libera el lock aunque fn lance (finally) → se puede re-adquirir', async () => {
    await expect(
      withLock('wl:throws', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await withLock('wl:throws', async () => 'ok')).toEqual({
      skipped: false,
      result: 'ok',
    });
  });

  it('waitMs: reintenta la adquisición hasta que el lock se libera', async () => {
    const gate = defer();
    const first = withLock('wl:wait', async () => {
      await gate.promise;
      return 'A';
    });
    await tick(10);
    const secondP = withLock('wl:wait', async () => 'B', { waitMs: 2000, retryDelayMs: 20 });
    await tick(40);
    gate.resolve(); // libera el primero; el segundo debe adquirir en un reintento
    await first;
    expect(await secondP).toEqual({ skipped: false, result: 'B' });
  });
});
