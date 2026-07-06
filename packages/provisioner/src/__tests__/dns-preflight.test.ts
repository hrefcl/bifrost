import { describe, it, expect } from 'vitest';
import {
  normalizeDnsName,
  plannedDnsRecords,
  findDnsConflicts,
  type DnsRecordKey,
} from '../wizard/dns-preflight.js';

describe('normalizeDnsName', () => {
  it('agrega punto final y baja a minúsculas', () => {
    expect(normalizeDnsName('Mail.Aulion.DEV')).toBe('mail.aulion.dev.');
    expect(normalizeDnsName('aulion.dev.')).toBe('aulion.dev.');
    expect(normalizeDnsName('  webmail.x.com  ')).toBe('webmail.x.com.');
  });
});

describe('plannedDnsRecords', () => {
  it('sin Meet DNS: A mail/webmail, MX apex, TXT apex (SPF), TXT _dmarc', () => {
    const r = plannedDnsRecords('aulion.dev', { manageMeetDns: false });
    expect(r).toEqual([
      { name: 'mail.aulion.dev.', type: 'A' },
      { name: 'webmail.aulion.dev.', type: 'A' },
      { name: 'aulion.dev.', type: 'MX' },
      { name: 'aulion.dev.', type: 'TXT' },
      { name: '_dmarc.aulion.dev.', type: 'TXT' },
    ]);
  });
  it('con Meet DNS: suma A meet y A turn.meet', () => {
    const r = plannedDnsRecords('aulion.dev', { manageMeetDns: true });
    expect(r).toContainEqual({ name: 'meet.aulion.dev.', type: 'A' });
    expect(r).toContainEqual({ name: 'turn.meet.aulion.dev.', type: 'A' });
    expect(r).toHaveLength(7);
  });
});

describe('findDnsConflicts', () => {
  const planned = plannedDnsRecords('aulion.dev', { manageMeetDns: false });

  it('detecta el choque de SPF/DMARC previos (el caso REAL de aulion.dev)', () => {
    const existing: DnsRecordKey[] = [
      { name: 'aulion.dev.', type: 'TXT' }, // SPF previo
      { name: '_dmarc.aulion.dev.', type: 'TXT' }, // DMARC previo
      { name: 'aulion.dev.', type: 'NS' } as unknown as DnsRecordKey, // NS del apex: NO choca (otro type)
    ];
    const conflicts = findDnsConflicts(planned, existing);
    expect(conflicts).toEqual([
      { name: 'aulion.dev.', type: 'TXT' },
      { name: '_dmarc.aulion.dev.', type: 'TXT' },
    ]);
  });

  it('zona limpia → sin conflictos', () => {
    expect(findDnsConflicts(planned, [{ name: 'blog.aulion.dev.', type: 'A' }])).toEqual([]);
    expect(findDnsConflicts(planned, [])).toEqual([]);
  });

  it('es case-insensitive y tolera FQDN con/sin punto final', () => {
    const existing: DnsRecordKey[] = [{ name: 'MAIL.aulion.dev', type: 'A' }]; // sin punto, mayúsculas
    expect(findDnsConflicts(planned, existing)).toEqual([{ name: 'mail.aulion.dev.', type: 'A' }]);
  });

  it('mismo name distinto type NO choca (Route53 permite A y TXT en el mismo name)', () => {
    const existing: DnsRecordKey[] = [{ name: 'mail.aulion.dev.', type: 'TXT' }]; // A planned, TXT existe
    expect(findDnsConflicts(planned, existing)).toEqual([]);
  });
});
