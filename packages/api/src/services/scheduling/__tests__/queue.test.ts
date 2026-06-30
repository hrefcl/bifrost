import { describe, it, expect } from 'vitest';
import { enqueue, startSchedulingWorker, closeScheduling } from '../queue.js';
import { schedulingProcessor } from '../worker.js';

// En test (REDIS_URL=mock) BullMQ no aplica: enqueue es no-op, el worker no arranca. Verificamos que
// el guard mock no lanza ni intenta abrir conexiones BullMQ reales (que romperían con ioredis-mock).

describe('scheduling queue (mock guard)', () => {
  it('enqueue es no-op y no lanza en mock', async () => {
    await expect(enqueue('send-email', { bookingId: 'x' })).resolves.toBeUndefined();
  });

  it('startSchedulingWorker devuelve null en mock', () => {
    expect(startSchedulingWorker(schedulingProcessor)).toBeNull();
  });

  it('closeScheduling resuelve sin error en mock', async () => {
    await expect(closeScheduling()).resolves.toBeUndefined();
  });
});

describe('schedulingProcessor (dispatch, Fase 3.4)', () => {
  it('rechaza send-email sin datos y nombres desconocidos', async () => {
    const mk = (name: string, data: unknown = {}) =>
      ({ name, data }) as unknown as Parameters<typeof schedulingProcessor>[0];
    // send-email sin bookingId/kind → rechaza (valida antes de tocar DB).
    await expect(schedulingProcessor(mk('send-email'))).rejects.toThrow(/requeridos/);
    // nombre desconocido → rechaza.
    await expect(schedulingProcessor(mk('bogus'))).rejects.toThrow(/unknown job name/);
  });
});
