import { describe, it, expect } from 'vitest';
import { matchHostedZone, type HostedZone } from '../aws/route53.js';

const zones: HostedZone[] = [
  { id: 'ZEX', name: 'example.com.' },
  { id: 'ZAMPLE', name: 'ample.com.' },
  { id: 'ZSUB', name: 'sub.example.com.' },
];

describe('matchHostedZone', () => {
  it('zona exacta gana sobre cualquier padre', () => {
    const m = matchHostedZone(zones, 'example.com');
    expect(m.exact?.id).toBe('ZEX');
    expect(m.parent).toBeNull();
  });

  it('subdominio sin zona exacta resuelve al padre MÁS específico', () => {
    // mail.sub.example.com → padre más largo es sub.example.com, no example.com.
    const m = matchHostedZone(zones, 'mail.sub.example.com');
    expect(m.exact).toBeNull();
    expect(m.parent?.id).toBe('ZSUB');
  });

  it('respeta el borde de label: "ample.com" NO es padre de "example.com"', () => {
    const m = matchHostedZone([{ id: 'ZAMPLE', name: 'ample.com.' }], 'example.com');
    expect(m.exact).toBeNull();
    expect(m.parent).toBeNull(); // ample.com no contiene example.com
  });

  it('sin coincidencias → ambos null', () => {
    const m = matchHostedZone(zones, 'otra.org');
    expect(m.exact).toBeNull();
    expect(m.parent).toBeNull();
  });
});
