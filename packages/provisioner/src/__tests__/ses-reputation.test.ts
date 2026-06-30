import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SESv2Client,
  GetAccountCommand,
  PutAccountSuppressionAttributesCommand,
  CreateConfigurationSetCommand,
  PutConfigurationSetSendingOptionsCommand,
  ListSuppressedDestinationsCommand,
} from '@aws-sdk/client-sesv2';
import {
  mergeSuppressedReasons,
  ensureAccountSuppression,
  ensureConfigurationSet,
  setSendingEnabled,
  listSuppressed,
  REQUIRED_SUPPRESSION_REASONS,
} from '../aws/ses-reputation.js';

describe('mergeSuppressedReasons (pura, no-overwrite)', () => {
  it('une sin duplicar y en orden determinístico', () => {
    expect(mergeSuppressedReasons([], ['BOUNCE', 'COMPLAINT'])).toEqual(['BOUNCE', 'COMPLAINT']);
    expect(mergeSuppressedReasons(['COMPLAINT'], ['BOUNCE', 'COMPLAINT'])).toEqual([
      'BOUNCE',
      'COMPLAINT',
    ]);
  });

  it('preserva razones que el operador ya tenía (no pisa)', () => {
    // (hipotético reason extra del operador) se conserva.
    expect(mergeSuppressedReasons(['BOUNCE'], ['COMPLAINT'])).toEqual(['BOUNCE', 'COMPLAINT']);
  });

  it('maneja existing undefined', () => {
    expect(mergeSuppressedReasons(undefined, REQUIRED_SUPPRESSION_REASONS)).toEqual([
      'BOUNCE',
      'COMPLAINT',
    ]);
  });
});

describe('ensureAccountSuppression (merge + idempotente)', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => ses.reset());

  it('cuenta sin supresión → activa BOUNCE+COMPLAINT', async () => {
    ses.on(GetAccountCommand).resolves({ SuppressionAttributes: { SuppressedReasons: [] } });
    ses.on(PutAccountSuppressionAttributesCommand).resolves({});
    const r = await ensureAccountSuppression(new SESv2Client({ region: 'us-east-1' }));
    expect(r.changed).toBe(true);
    const put = ses.commandCalls(PutAccountSuppressionAttributesCommand)[0].args[0].input;
    expect(put.SuppressedReasons).toEqual(['BOUNCE', 'COMPLAINT']);
  });

  it('idempotente: si ya tiene BOUNCE+COMPLAINT, NO escribe', async () => {
    ses
      .on(GetAccountCommand)
      .resolves({ SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] } });
    const r = await ensureAccountSuppression(new SESv2Client({ region: 'us-east-1' }));
    expect(r.changed).toBe(false);
    expect(ses.commandCalls(PutAccountSuppressionAttributesCommand)).toHaveLength(0);
  });

  it('merge: si tiene sólo COMPLAINT, agrega BOUNCE sin perder COMPLAINT', async () => {
    ses
      .on(GetAccountCommand)
      .resolves({ SuppressionAttributes: { SuppressedReasons: ['COMPLAINT'] } });
    ses.on(PutAccountSuppressionAttributesCommand).resolves({});
    await ensureAccountSuppression(new SESv2Client({ region: 'us-east-1' }));
    const put = ses.commandCalls(PutAccountSuppressionAttributesCommand)[0].args[0].input;
    expect(put.SuppressedReasons).toEqual(['BOUNCE', 'COMPLAINT']);
  });
});

describe('ensureConfigurationSet (idempotente)', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => ses.reset());

  it('crea el set con métricas de reputación + supresión BOUNCE/COMPLAINT', async () => {
    ses.on(CreateConfigurationSetCommand).resolves({});
    await ensureConfigurationSet(new SESv2Client({ region: 'us-east-1' }), 'bifrost-acme-com');
    const c = ses.commandCalls(CreateConfigurationSetCommand)[0].args[0].input;
    expect(c.ReputationOptions?.ReputationMetricsEnabled).toBe(true);
    expect(c.SuppressionOptions?.SuppressedReasons).toEqual(['BOUNCE', 'COMPLAINT']);
  });

  it('tolera AlreadyExistsException (idempotente)', async () => {
    const err = new Error('exists') as Error & { name: string };
    err.name = 'AlreadyExistsException';
    ses.on(CreateConfigurationSetCommand).rejects(err);
    await expect(
      ensureConfigurationSet(new SESv2Client({ region: 'us-east-1' }), 'x')
    ).resolves.toBeUndefined();
  });

  it('propaga otros errores', async () => {
    ses.on(CreateConfigurationSetCommand).rejects(new Error('AccessDenied'));
    await expect(
      ensureConfigurationSet(new SESv2Client({ region: 'us-east-1' }), 'x')
    ).rejects.toThrow(/AccessDenied/);
  });
});

describe('setSendingEnabled + listSuppressed', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => ses.reset());

  it('pause/resume togglea SendingEnabled del set', async () => {
    ses.on(PutConfigurationSetSendingOptionsCommand).resolves({});
    await setSendingEnabled(new SESv2Client({ region: 'us-east-1' }), 'set', false);
    await setSendingEnabled(new SESv2Client({ region: 'us-east-1' }), 'set', true);
    const calls = ses.commandCalls(PutConfigurationSetSendingOptionsCommand);
    expect(calls[0].args[0].input.SendingEnabled).toBe(false);
    expect(calls[1].args[0].input.SendingEnabled).toBe(true);
  });

  it('listSuppressed pagina y agrega email+reason', async () => {
    ses
      .on(ListSuppressedDestinationsCommand)
      .resolvesOnce({
        SuppressedDestinationSummaries: [{ EmailAddress: 'a@x.com', Reason: 'BOUNCE' }],
        NextToken: 'p2',
      })
      .resolvesOnce({
        SuppressedDestinationSummaries: [{ EmailAddress: 'b@x.com', Reason: 'COMPLAINT' }],
      });
    const out = await listSuppressed(new SESv2Client({ region: 'us-east-1' }));
    expect(out).toEqual([
      { email: 'a@x.com', reason: 'BOUNCE' },
      { email: 'b@x.com', reason: 'COMPLAINT' },
    ]);
  });
});
