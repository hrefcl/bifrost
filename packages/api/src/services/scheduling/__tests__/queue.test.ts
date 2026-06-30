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

describe('schedulingProcessor (stubs Fase 3.0)', () => {
  it('lanza para nombres conocidos aún no implementados y para desconocidos', async () => {
    // job mínimo: sólo `name` importa para el dispatch.
    const mk = (name: string) => ({ name }) as unknown as Parameters<typeof schedulingProcessor>[0];
    await expect(schedulingProcessor(mk('send-email'))).rejects.toThrow(/not implemented/);
    await expect(schedulingProcessor(mk('reconcile'))).rejects.toThrow(/not implemented/);
    await expect(schedulingProcessor(mk('bogus'))).rejects.toThrow(/unknown job name/);
  });
});
