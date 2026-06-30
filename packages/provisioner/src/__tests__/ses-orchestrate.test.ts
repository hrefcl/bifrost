import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SESv2Client,
  CreateConfigurationSetCommand,
  GetAccountCommand,
  PutAccountSuppressionAttributesCommand,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  PutEmailIdentityConfigurationSetAttributesCommand,
} from '@aws-sdk/client-sesv2';
import {
  IAMClient,
  GetUserCommand,
  PutUserPolicyCommand,
  ListAccessKeysCommand,
  CreateAccessKeyCommand,
} from '@aws-sdk/client-iam';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { Route53Client, ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { orchestrateSesOutbound, type OrchestrateSesInput } from '../ses/orchestrate.js';

const sesMock = mockClient(SESv2Client);
const iamMock = mockClient(IAMClient);
const ssmMock = mockClient(SSMClient);
const r53Mock = mockClient(Route53Client);

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function input(overrides: Partial<OrchestrateSesInput> = {}): OrchestrateSesInput {
  return {
    ses: new SESv2Client({ region: 'us-east-1' }),
    iam: new IAMClient({ region: 'us-east-1' }),
    ssm: new SSMClient({ region: 'us-east-1' }),
    r53: new Route53Client({ region: 'us-east-1' }),
    domain: 'acme.com',
    region: 'us-east-1',
    accountId: '111122223333',
    ssmParamName: '/bifrost/acme-com/ses-smtp',
    kmsKeyId: 'alias/aws/ssm',
    configurationSetName: 'bifrost-acme-com',
    userName: 'bifrost-ses-acme-com',
    policyName: 'bifrost-ses-send',
    ...overrides,
  };
}

function notFound(name: string) {
  const e = new Error(name) as Error & { name: string };
  e.name = name;
  return e;
}

function wireCommon() {
  sesMock.on(CreateConfigurationSetCommand).resolves({});
  sesMock.on(PutAccountSuppressionAttributesCommand).resolves({});
  sesMock.on(CreateEmailIdentityCommand).resolves({});
  sesMock.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
  sesMock.on(PutEmailIdentityConfigurationSetAttributesCommand).resolves({});
  // IAM: usuario fresco con key nueva.
  iamMock.on(GetUserCommand).rejects(notFound('NoSuchEntityException'));
  iamMock.on(PutUserPolicyCommand).resolves({});
  iamMock.on(ListAccessKeysCommand).resolves({ AccessKeyMetadata: [] });
  iamMock
    .on(CreateAccessKeyCommand)
    .resolves({
      AccessKey: {
        UserName: 'u',
        AccessKeyId: 'AKIANEW',
        SecretAccessKey: SECRET,
        Status: 'Active',
      },
    });
  ssmMock.on(GetParameterCommand).rejects(notFound('ParameterNotFound'));
  ssmMock.on(PutParameterCommand).resolves({});
  r53Mock.on(ChangeResourceRecordSetsCommand).resolves({});
}

beforeEach(() => {
  sesMock.reset();
  iamMock.reset();
  ssmMock.reset();
  r53Mock.reset();
});

describe('orchestrateSesOutbound', () => {
  it('camino READY: DKIM+MAIL FROM verificados + fuera de sandbox + zona gestionada', async () => {
    wireCommon();
    sesMock.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: 'SUCCESS', Tokens: ['t1', 't2', 't3'] },
      MailFromAttributes: { MailFromDomain: 'bounce.acme.com', MailFromDomainStatus: 'SUCCESS' },
    });
    sesMock.on(GetAccountCommand).resolves({
      SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
      ProductionAccessEnabled: true,
    });

    const res = await orchestrateSesOutbound(input({ hostedZoneId: 'Z123' }));

    expect(res.state).toBe('ready');
    expect(res.dnsManaged).toBe(true);
    expect(res.credentialPublished).toBe(true); // ready → se crea y publica la credencial
    expect(res.accessKeyId).toBe('AKIANEW');
    expect(res.mailFromDomain).toBe('bounce.acme.com');
    // 3 CNAME DKIM + MX + TXT.
    expect(res.dnsRecords).toHaveLength(5);
    // Se escribieron en Route53.
    expect(r53Mock.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(1);
    // El config set quedó como default de la identidad (cierre del bug de B4).
    expect(sesMock.commandCalls(PutEmailIdentityConfigurationSetAttributesCommand)).toHaveLength(1);
    // SEGURIDAD: a SSM va el password derivado, JAMÁS el SecretAccessKey crudo.
    const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(put.Type).toBe('SecureString');
    expect(put.Value).not.toContain(SECRET);
  });

  it('camino PENDING-DKIM: sin zona → records para hacer a mano, NO ready, NO crea credencial (send-gating)', async () => {
    wireCommon();
    sesMock.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: 'PENDING', Tokens: ['t1', 't2', 't3'] },
    });
    sesMock.on(GetAccountCommand).resolves({
      SuppressionAttributes: { SuppressedReasons: [] },
      ProductionAccessEnabled: false,
    });

    const res = await orchestrateSesOutbound(input({ hostedZoneId: undefined }));

    expect(res.state).toBe('pending-dkim');
    expect(res.dnsManaged).toBe(false); // sin zona, el operador agrega los records
    expect(res.dnsRecords.length).toBeGreaterThan(0);
    expect(r53Mock.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
    // SEND-GATING: en pending no se crea credencial ni se escribe SSM → el relay del box queda apagado.
    expect(res.credentialPublished).toBe(false);
    expect(res.accessKeyId).toBeUndefined();
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
    // Igual se activó la suppression (estaba vacía).
    expect(sesMock.commandCalls(PutAccountSuppressionAttributesCommand)).toHaveLength(1);
  });

  it('camino PENDING-PRODUCTION-ACCESS: todo verificado pero en sandbox → tampoco publica credencial', async () => {
    wireCommon();
    sesMock.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: 'SUCCESS', Tokens: ['t1', 't2', 't3'] },
      MailFromAttributes: { MailFromDomain: 'bounce.acme.com', MailFromDomainStatus: 'SUCCESS' },
    });
    sesMock.on(GetAccountCommand).resolves({
      SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
      ProductionAccessEnabled: false, // sandbox
    });

    const res = await orchestrateSesOutbound(input({ hostedZoneId: 'Z123' }));
    expect(res.state).toBe('pending-production-access');
    expect(res.credentialPublished).toBe(false);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});
