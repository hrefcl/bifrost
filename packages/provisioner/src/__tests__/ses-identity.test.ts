import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from '@aws-sdk/client-sesv2';
import {
  computeOutboundState,
  isOutboundReady,
  dkimCnameRecords,
  mailFromRecords,
  mailFromDomainFor,
  ensureEmailIdentity,
  ensureMailFrom,
} from '../aws/ses-identity.js';

describe('computeOutboundState (máquina de estados honestidad-crítica)', () => {
  it('sin DKIM verificado → pending-dkim (nunca ready)', () => {
    expect(computeOutboundState({})).toBe('pending-dkim');
    expect(computeOutboundState({ dkimStatus: 'PENDING' })).toBe('pending-dkim');
    expect(computeOutboundState({ dkimStatus: 'NOT_STARTED' })).toBe('pending-dkim');
    expect(computeOutboundState({ dkimStatus: 'TEMPORARY_FAILURE' })).toBe('pending-dkim');
  });

  it('DKIM FAILED → failed-dkim (terminal hasta corregir DNS)', () => {
    expect(computeOutboundState({ dkimStatus: 'FAILED' })).toBe('failed-dkim');
  });

  it('DKIM ok pero MAIL FROM sin verificar → pending-mail-from', () => {
    expect(computeOutboundState({ dkimStatus: 'SUCCESS' })).toBe('pending-mail-from');
    expect(computeOutboundState({ dkimStatus: 'SUCCESS', mailFromStatus: 'PENDING' })).toBe(
      'pending-mail-from'
    );
  });

  it('MAIL FROM FAILED → failed-mail-from', () => {
    expect(computeOutboundState({ dkimStatus: 'SUCCESS', mailFromStatus: 'FAILED' })).toBe(
      'failed-mail-from'
    );
  });

  it('DKIM + MAIL FROM ok pero en sandbox → pending-production-access', () => {
    expect(computeOutboundState({ dkimStatus: 'SUCCESS', mailFromStatus: 'SUCCESS' })).toBe(
      'pending-production-access'
    );
    expect(
      computeOutboundState({
        dkimStatus: 'SUCCESS',
        mailFromStatus: 'SUCCESS',
        productionAccessEnabled: false,
      })
    ).toBe('pending-production-access');
  });

  it('todo verificado + fuera de sandbox → ready (y SÓLO entonces)', () => {
    const st = computeOutboundState({
      dkimStatus: 'SUCCESS',
      mailFromStatus: 'SUCCESS',
      productionAccessEnabled: true,
    });
    expect(st).toBe('ready');
    expect(isOutboundReady(st)).toBe(true);
  });

  it('case-insensitive en los estados de SES', () => {
    expect(
      computeOutboundState({
        dkimStatus: 'success',
        mailFromStatus: 'success',
        productionAccessEnabled: true,
      })
    ).toBe('ready');
  });

  it('ningún estado intermedio reporta ready (send-gating)', () => {
    for (const st of [
      'pending-dkim',
      'failed-dkim',
      'pending-mail-from',
      'failed-mail-from',
      'pending-production-access',
    ] as const) {
      expect(isOutboundReady(st)).toBe(false);
    }
  });
});

describe('records DNS (puros)', () => {
  it('dkimCnameRecords arma los 3 CNAME a *.dkim.amazonses.com', () => {
    const recs = dkimCnameRecords('acme.com', ['tok1', 'tok2', 'tok3']);
    expect(recs).toHaveLength(3);
    expect(recs[0]).toEqual({
      name: 'tok1._domainkey.acme.com',
      type: 'CNAME',
      value: 'tok1.dkim.amazonses.com',
      ttl: 1800,
    });
  });

  it('mailFromDomainFor usa bounce. (no mail., reservado para MX)', () => {
    expect(mailFromDomainFor('acme.com')).toBe('bounce.acme.com');
  });

  it('mailFromRecords: MX al feedback de SES + SPF -all en el SUBDOMINIO (no toca el apex)', () => {
    const recs = mailFromRecords('us-east-1', 'bounce.acme.com');
    const mx = recs.find((r) => r.type === 'MX');
    const txt = recs.find((r) => r.type === 'TXT');
    expect(mx?.value).toBe('10 feedback-smtp.us-east-1.amazonses.com');
    expect(mx?.name).toBe('bounce.acme.com');
    expect(txt?.value).toBe('"v=spf1 include:amazonses.com -all"');
    expect(txt?.name).toBe('bounce.acme.com'); // SUBDOMINIO, jamás el apex
  });
});

describe('ensureEmailIdentity / ensureMailFrom (idempotencia)', () => {
  const sesMock = mockClient(SESv2Client);
  beforeEach(() => sesMock.reset());

  it('crea la identidad con Easy DKIM 2048 y devuelve los tokens', async () => {
    sesMock.on(CreateEmailIdentityCommand).resolves({});
    sesMock.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: 'PENDING', Tokens: ['a', 'b', 'c'] },
    });
    const info = await ensureEmailIdentity(new SESv2Client({ region: 'us-east-1' }), 'acme.com');
    expect(info.dkimTokens).toEqual(['a', 'b', 'c']);
    expect(info.dkimStatus).toBe('PENDING');
    const created = sesMock.commandCalls(CreateEmailIdentityCommand)[0].args[0].input;
    expect(created.DkimSigningAttributes?.NextSigningKeyLength).toBe('RSA_2048_BIT');
  });

  it('idempotente: si la identidad ya existe (AlreadyExistsException) igual lee su estado', async () => {
    const err = new Error('exists') as Error & { name: string };
    err.name = 'AlreadyExistsException';
    sesMock.on(CreateEmailIdentityCommand).rejects(err);
    sesMock.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: 'SUCCESS', Tokens: ['x'] },
      MailFromAttributes: { MailFromDomain: 'bounce.acme.com', MailFromDomainStatus: 'SUCCESS' },
    });
    const info = await ensureEmailIdentity(new SESv2Client({ region: 'us-east-1' }), 'acme.com');
    expect(info.dkimStatus).toBe('SUCCESS');
    expect(info.mailFromStatus).toBe('SUCCESS');
  });

  it('ensureMailFrom configura bounce.<dom> con BehaviorOnMxFailure=USE_DEFAULT_VALUE', async () => {
    sesMock.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
    await ensureMailFrom(new SESv2Client({ region: 'us-east-1' }), 'acme.com');
    const call = sesMock.commandCalls(PutEmailIdentityMailFromAttributesCommand)[0].args[0].input;
    expect(call.MailFromDomain).toBe('bounce.acme.com');
    expect(call.BehaviorOnMxFailure).toBe('USE_DEFAULT_VALUE');
  });
});
