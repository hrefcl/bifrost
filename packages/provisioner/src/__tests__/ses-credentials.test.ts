import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  IAMClient,
  GetUserCommand,
  CreateUserCommand,
  PutUserPolicyCommand,
  ListAccessKeysCommand,
  CreateAccessKeyCommand,
  DeleteAccessKeyCommand,
} from '@aws-sdk/client-iam';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  ensureSmtpCredentials,
  buildSesSendPolicy,
  type EnsureSmtpCredentialsInput,
} from '../aws/ses-credentials.js';
import { deriveSesSmtpPassword } from '../aws/ses-smtp.js';

const iamMock = mockClient(IAMClient);
const ssmMock = mockClient(SSMClient);

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function baseInput(): EnsureSmtpCredentialsInput {
  return {
    iam: new IAMClient({ region: 'us-east-1' }),
    ssm: new SSMClient({ region: 'us-east-1' }),
    region: 'us-east-1',
    userName: 'bifrost-ses-acme-com',
    policyName: 'bifrost-ses-send',
    policyDocument: buildSesSendPolicy('us-east-1', '111122223333', 'acme.com'),
    ssmParamName: '/bifrost/acme-com/ses-smtp',
    kmsKeyId: 'alias/aws/ssm',
    tags: [{ Key: 'bifrost:managed', Value: 'ses' }],
  };
}

function notFound(name: string) {
  const e = new Error(name) as Error & { name: string };
  e.name = name;
  return e;
}

beforeEach(() => {
  iamMock.reset();
  ssmMock.reset();
});

describe('ensureSmtpCredentials', () => {
  it('provisión fresca: crea user+policy+key, deriva el password y lo guarda en SSM SecureString', async () => {
    iamMock.on(GetUserCommand).rejects(notFound('NoSuchEntityException'));
    iamMock.on(CreateUserCommand).resolves({});
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

    const res = await ensureSmtpCredentials(baseInput());

    expect(res.created).toBe(true);
    expect(res.accessKeyId).toBe('AKIANEW');
    expect(res.smtpHost).toBe('email-smtp.us-east-1.amazonaws.com');
    // El SecretAccessKey NO se guarda crudo: SSM recibe el password YA derivado.
    const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(put.Type).toBe('SecureString');
    expect(put.KeyId).toBe('alias/aws/ssm');
    const stored = JSON.parse(put.Value as string);
    expect(stored.smtpPassword).toBe(deriveSesSmtpPassword(SECRET, 'us-east-1'));
    expect(stored.smtpPassword).not.toContain(SECRET); // jamás el secreto crudo
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });

  it('idempotente: si SSM ya tiene una credencial cuya key existe, NO crea otra', async () => {
    iamMock.on(GetUserCommand).resolves({ User: { UserName: 'bifrost-ses-acme-com' } as never });
    iamMock.on(PutUserPolicyCommand).resolves({});
    iamMock.on(ListAccessKeysCommand).resolves({
      AccessKeyMetadata: [{ AccessKeyId: 'AKIACURRENT', Status: 'Active' }],
    });
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AKIACURRENT', smtpPassword: 'pw' }) },
    });

    const res = await ensureSmtpCredentials(baseInput());

    expect(res.created).toBe(false);
    expect(res.accessKeyId).toBe('AKIACURRENT');
    expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
    expect(iamMock.commandCalls(DeleteAccessKeyCommand)).toHaveLength(0); // no toca la vigente
  });

  it('crash-safe: una key huérfana (no referenciada por SSM) se borra y se crea una fresca', async () => {
    iamMock.on(GetUserCommand).resolves({ User: { UserName: 'u' } as never });
    iamMock.on(PutUserPolicyCommand).resolves({});
    // SSM vacío (el run anterior murió antes de escribir) pero quedó una key activa.
    ssmMock.on(GetParameterCommand).rejects(notFound('ParameterNotFound'));
    iamMock.on(ListAccessKeysCommand).resolves({
      AccessKeyMetadata: [{ AccessKeyId: 'AKIAORPHAN', Status: 'Active' }],
    });
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    iamMock
      .on(CreateAccessKeyCommand)
      .resolves({
        AccessKey: {
          UserName: 'u',
          AccessKeyId: 'AKIAFRESH',
          SecretAccessKey: SECRET,
          Status: 'Active',
        },
      });
    ssmMock.on(PutParameterCommand).resolves({});

    const res = await ensureSmtpCredentials(baseInput());

    expect(res.created).toBe(true);
    expect(res.accessKeyId).toBe('AKIAFRESH');
    // La huérfana fue borrada (cero keys activas sin respaldo en SSM).
    const del = iamMock.commandCalls(DeleteAccessKeyCommand);
    expect(del).toHaveLength(1);
    expect(del[0].args[0].input.AccessKeyId).toBe('AKIAORPHAN');
  });

  it('transaccional: si el PutParameter falla, borra la key recién creada (cero huérfanas) y propaga', async () => {
    iamMock.on(GetUserCommand).resolves({ User: { UserName: 'u' } as never });
    iamMock.on(PutUserPolicyCommand).resolves({});
    ssmMock.on(GetParameterCommand).rejects(notFound('ParameterNotFound'));
    iamMock.on(ListAccessKeysCommand).resolves({ AccessKeyMetadata: [] });
    iamMock
      .on(CreateAccessKeyCommand)
      .resolves({
        AccessKey: {
          UserName: 'u',
          AccessKeyId: 'AKIADOOMED',
          SecretAccessKey: SECRET,
          Status: 'Active',
        },
      });
    ssmMock.on(PutParameterCommand).rejects(new Error('KMS AccessDenied'));
    iamMock.on(DeleteAccessKeyCommand).resolves({});

    await expect(ensureSmtpCredentials(baseInput())).rejects.toThrow(/KMS AccessDenied/);

    const del = iamMock.commandCalls(DeleteAccessKeyCommand);
    expect(del).toHaveLength(1);
    expect(del[0].args[0].input.AccessKeyId).toBe('AKIADOOMED'); // la recién creada, no otra
  });

  it('vigente + huérfana a la vez (tope de 2 keys): borra sólo la huérfana y mantiene idempotencia', async () => {
    iamMock.on(GetUserCommand).resolves({ User: { UserName: 'u' } as never });
    iamMock.on(PutUserPolicyCommand).resolves({});
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AKIACURRENT', smtpPassword: 'pw' }) },
    });
    iamMock.on(ListAccessKeysCommand).resolves({
      AccessKeyMetadata: [
        { AccessKeyId: 'AKIACURRENT', Status: 'Active' },
        { AccessKeyId: 'AKIAORPHAN', Status: 'Active' },
      ],
    });
    iamMock.on(DeleteAccessKeyCommand).resolves({});

    const res = await ensureSmtpCredentials(baseInput());

    expect(res.created).toBe(false);
    expect(res.accessKeyId).toBe('AKIACURRENT');
    const del = iamMock.commandCalls(DeleteAccessKeyCommand);
    expect(del).toHaveLength(1);
    expect(del[0].args[0].input.AccessKeyId).toBe('AKIAORPHAN');
    expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
  });
});

describe('buildSesSendPolicy', () => {
  it('acota el envío a la identidad del dominio y al FromAddress del dominio', () => {
    const doc = JSON.parse(buildSesSendPolicy('us-east-1', '111122223333', 'acme.com'));
    const stmt = doc.Statement[0];
    expect(stmt.Resource).toBe('arn:aws:ses:us-east-1:111122223333:identity/acme.com');
    expect(stmt.Action).toContain('ses:SendRawEmail');
    expect(stmt.Condition.StringLike['ses:FromAddress']).toBe('*@acme.com');
  });
});
