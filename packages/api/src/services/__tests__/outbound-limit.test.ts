import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { redis } from '../../config/redis.js';
import {
  checkOutboundLimit,
  outboundLimits,
  maxRecipientsPerMessage,
  type OutboundLimits,
} from '../outbound-limit.js';

const LIMITS: OutboundLimits = { perMinute: 10, perHour: 50, perDay: 100 };

describe('checkOutboundLimit (anti spam-cannon por buzón)', () => {
  beforeEach(async () => {
    await redis.flushall();
  });
  afterEach(() => vi.restoreAllMocks());

  it('permite mientras esté bajo el límite e incrementa por destinatarios', async () => {
    const r1 = await checkOutboundLimit('acc1', 4, LIMITS);
    expect(r1.allowed).toBe(true);
    const r2 = await checkOutboundLimit('acc1', 4, LIMITS);
    expect(r2.allowed).toBe(true); // 8/10
  });

  it('rechaza al exceder la ventana de minuto, con scope/limit/retryAfter', async () => {
    await checkOutboundLimit('acc1', 8, LIMITS); // 8/10
    const r = await checkOutboundLimit('acc1', 5, LIMITS); // 8+5 > 10
    expect(r.allowed).toBe(false);
    expect(r.scope).toBe('minute');
    expect(r.limit).toBe(10);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect(r.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('un envío rechazado NO consume cuota: un envío más chico que sí entra, pasa', async () => {
    await checkOutboundLimit('acc1', 8, LIMITS); // 8/10
    const rejected = await checkOutboundLimit('acc1', 5, LIMITS); // rechazado
    expect(rejected.allowed).toBe(false);
    // El rechazo no incrementó → todavía hay 2 de cuota.
    const ok = await checkOutboundLimit('acc1', 2, LIMITS); // 8+2 = 10, entra
    expect(ok.allowed).toBe(true);
  });

  it('aísla por buzón: una cuenta saturada no afecta a otra', async () => {
    await checkOutboundLimit('acc1', 10, LIMITS); // acc1 lleno
    const other = await checkOutboundLimit('acc2', 10, LIMITS);
    expect(other.allowed).toBe(true);
  });

  it('cap DIARIO: acumula entre ventanas y corta al llegar al día', async () => {
    // perDay=100; mandamos 10x10 = 100 (ok), el siguiente excede el día.
    for (let i = 0; i < 10; i++) {
      const r = await checkOutboundLimit('acc1', 10, {
        perMinute: 1000,
        perHour: 1000,
        perDay: 100,
      });
      expect(r.allowed).toBe(true);
    }
    const over = await checkOutboundLimit('acc1', 1, {
      perMinute: 1000,
      perHour: 1000,
      perDay: 100,
    });
    expect(over.allowed).toBe(false);
    expect(over.scope).toBe('day');
  });

  it('recipients <= 0 → permitido sin tocar Redis', async () => {
    const spy = vi.spyOn(redis, 'eval');
    expect((await checkOutboundLimit('acc1', 0, LIMITS)).allowed).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: si Redis falla, permite el envío y captura la causa (root-cause 3AM)', async () => {
    vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('redis down'));
    const r = await checkOutboundLimit('acc1', 5, LIMITS);
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain('redis down'); // [B2-MED] la causa queda para el log
  });

  it('repara una key SIN TTL aunque RECHACE (no deja el buzón bloqueado para siempre) [B2-LOW/MED]', async () => {
    // Simula una key saturada que perdió su TTL (failover): valor sobre el límite, sin EXPIRE.
    const key = 'obl:{accStuck}:min';
    await redis.set(key, '999'); // 999 >> perMinute(10), SIN ttl
    expect(await redis.ttl(key)).toBe(-1); // confirmado sin TTL
    const r = await checkOutboundLimit('accStuck', 1, LIMITS);
    expect(r.allowed).toBe(false); // rechaza (está sobre el límite)
    // Pero el path de rechazo REPARÓ el TTL → la key ya no es eterna; el buzón se recupera.
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });
});

describe('outboundLimits (defaults + override por env)', () => {
  afterEach(() => {
    delete process.env.OUTBOUND_MAX_RCPT_PER_MIN;
    delete process.env.OUTBOUND_MAX_RCPT_PER_DAY;
  });

  it('defaults razonables para uso de negocio (perMinute >= maxPerMessage, invariante B2)', () => {
    const l = outboundLimits();
    expect(l.perMinute).toBe(100);
    expect(l.perHour).toBe(300);
    expect(l.perDay).toBe(1000);
    // Invariante: un mensaje del tamaño máximo cabe en la ventana de minuto (si no, 429 eterno).
    expect(l.perMinute).toBeGreaterThanOrEqual(maxRecipientsPerMessage());
  });

  it('override por env (valores inválidos → default)', () => {
    process.env.OUTBOUND_MAX_RCPT_PER_MIN = '5';
    process.env.OUTBOUND_MAX_RCPT_PER_DAY = 'no-numero';
    const l = outboundLimits();
    expect(l.perMinute).toBe(5);
    expect(l.perDay).toBe(1000); // inválido → default
  });
});

describe('maxRecipientsPerMessage (cap por mensaje)', () => {
  afterEach(() => delete process.env.OUTBOUND_MAX_RCPT_PER_MESSAGE);

  it('default 100, override por env, inválido → default', () => {
    expect(maxRecipientsPerMessage()).toBe(100);
    process.env.OUTBOUND_MAX_RCPT_PER_MESSAGE = '20';
    expect(maxRecipientsPerMessage()).toBe(20);
    process.env.OUTBOUND_MAX_RCPT_PER_MESSAGE = '-3';
    expect(maxRecipientsPerMessage()).toBe(100);
  });
});
