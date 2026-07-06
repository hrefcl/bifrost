import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { Route53Client, ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { toUpsertChanges, upsertRecords, type DnsUpsert } from '../aws/route53.js';

describe('toUpsertChanges (pura)', () => {
  it('un Change UPSERT por (name,type)', () => {
    const recs: DnsUpsert[] = [
      { name: 't1._domainkey.acme.com', type: 'CNAME', value: 't1.dkim.amazonses.com', ttl: 1800 },
      {
        name: 'bounce.acme.com',
        type: 'MX',
        value: '10 feedback-smtp.us-east-1.amazonses.com',
        ttl: 1800,
      },
    ];
    const ch = toUpsertChanges(recs);
    expect(ch).toHaveLength(2);
    expect(ch[0].Action).toBe('UPSERT');
    expect(ch[0].ResourceRecordSet?.Name).toBe('t1._domainkey.acme.com');
    expect(ch[0].ResourceRecordSet?.ResourceRecords).toEqual([{ Value: 't1.dkim.amazonses.com' }]);
  });

  it('records del MISMO name+type se agrupan en un set (no se pisan)', () => {
    const recs: DnsUpsert[] = [
      { name: 'bounce.acme.com', type: 'TXT', value: '"a"', ttl: 300 },
      { name: 'bounce.acme.com', type: 'TXT', value: '"b"', ttl: 300 },
    ];
    const ch = toUpsertChanges(recs);
    expect(ch).toHaveLength(1);
    expect(ch[0].ResourceRecordSet?.ResourceRecords).toEqual([{ Value: '"a"' }, { Value: '"b"' }]);
  });
});

describe('upsertRecords', () => {
  const r53 = mockClient(Route53Client);
  beforeEach(() => r53.reset());

  it('manda el ChangeBatch a la zona', async () => {
    r53.on(ChangeResourceRecordSetsCommand).resolves({});
    await upsertRecords(new Route53Client({ region: 'us-east-1' }), 'Z123', [
      { name: 'x.acme.com', type: 'CNAME', value: 'y.dkim.amazonses.com', ttl: 1800 },
    ]);
    const call = r53.commandCalls(ChangeResourceRecordSetsCommand)[0].args[0].input;
    expect(call.HostedZoneId).toBe('Z123');
    expect(call.ChangeBatch?.Changes).toHaveLength(1);
  });

  it('sin records → no llama a la API', async () => {
    await upsertRecords(new Route53Client({ region: 'us-east-1' }), 'Z123', []);
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
  });
});

describe('listResourceRecordSets (paginado)', () => {
  it('junta los records de todas las páginas y normaliza el name a minúsculas', async () => {
    const { Route53Client, ListResourceRecordSetsCommand } =
      await import('@aws-sdk/client-route-53');
    const { listResourceRecordSets } = await import('../aws/route53.js');
    const { mockClient } = await import('aws-sdk-client-mock');
    const r53 = mockClient(Route53Client);
    r53
      .on(ListResourceRecordSetsCommand)
      .resolvesOnce({
        ResourceRecordSets: [
          { Name: 'Acme.com.', Type: 'MX' },
          { Name: 'acme.com.', Type: 'TXT' },
        ],
        IsTruncated: true,
        NextRecordName: 'mail.acme.com.',
        NextRecordType: 'A',
      })
      .resolvesOnce({
        ResourceRecordSets: [{ Name: 'mail.acme.com.', Type: 'A' }],
        IsTruncated: false,
      });
    const recs = await listResourceRecordSets(new Route53Client({ region: 'us-east-1' }), 'Z1');
    expect(recs).toEqual([
      { name: 'acme.com.', type: 'MX' },
      { name: 'acme.com.', type: 'TXT' },
      { name: 'mail.acme.com.', type: 'A' },
    ]);
    // El cursor compuesto de la 2ª página se pasó bien.
    const call2 = r53.commandCalls(ListResourceRecordSetsCommand)[1].args[0].input;
    expect(call2.StartRecordName).toBe('mail.acme.com.');
    expect(call2.StartRecordType).toBe('A');
  });
});
