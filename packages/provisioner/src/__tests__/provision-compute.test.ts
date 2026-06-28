import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  EC2Client,
  DescribeKeyPairsCommand,
  CreateKeyPairCommand,
  ImportKeyPairCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { provisionComputeIdentity } from '../steps/provision-compute.js';
import { emptyState } from '../state.js';

const ec2 = mockClient(EC2Client);
const ssm = mockClient(SSMClient);

function clients() {
  return {
    ec2: new EC2Client({ region: 'us-east-1' }),
    ssm: new SSMClient({ region: 'us-east-1' }),
  };
}
const input = { domain: 'acme.com', keyName: 'bifrost', securityGroupName: 'bifrost-sg' };

beforeEach(() => {
  ec2.reset();
  ssm.reset();
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'ami-ubuntu123' } });
});

describe('provisionComputeIdentity', () => {
  it('fresh: resuelve AMI, crea keypair (pem), crea SG + abre puertos, registra en state', async () => {
    ec2.on(DescribeKeyPairsCommand).rejects(new Error('InvalidKeyPair.NotFound'));
    ec2.on(CreateKeyPairCommand).resolves({ KeyMaterial: '---PEM---' });
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    ec2.on(CreateSecurityGroupCommand).resolves({ GroupId: 'sg-1' });
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});

    const r = await provisionComputeIdentity(clients(), input, emptyState('us-east-1', 'acme.com'));

    expect(r.amiId).toBe('ami-ubuntu123');
    expect(r.privateKeyPem).toBe('---PEM---');
    expect(r.securityGroupId).toBe('sg-1');
    expect(r.state.resources.map((x) => x.kind)).toEqual(['key-pair', 'security-group']);
    expect(ec2.commandCalls(AuthorizeSecurityGroupIngressCommand)).toHaveLength(1);
  });

  it('idempotente: keypair y SG ya existen → reusa, pem null, no recrea', async () => {
    ec2.on(DescribeKeyPairsCommand).resolves({ KeyPairs: [{ KeyName: 'bifrost' }] });
    ec2
      .on(DescribeSecurityGroupsCommand)
      .resolves({ SecurityGroups: [{ GroupId: 'sg-existing' }] });

    const r = await provisionComputeIdentity(clients(), input, emptyState('us-east-1', 'acme.com'));

    expect(r.privateKeyPem).toBeNull();
    expect(r.securityGroupId).toBe('sg-existing');
    expect(ec2.commandCalls(CreateKeyPairCommand)).toHaveLength(0);
    expect(ec2.commandCalls(CreateSecurityGroupCommand)).toHaveLength(0);
  });

  it('importa la clave pública del operador cuando se provee (no crea par AWS)', async () => {
    ec2.on(DescribeKeyPairsCommand).rejects(new Error('InvalidKeyPair.NotFound'));
    ec2.on(ImportKeyPairCommand).resolves({});
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    ec2.on(CreateSecurityGroupCommand).resolves({ GroupId: 'sg-2' });
    ec2.on(AuthorizeSecurityGroupIngressCommand).resolves({});

    const r = await provisionComputeIdentity(
      clients(),
      { ...input, importPublicKey: 'ssh-ed25519 AAAAC3Nz' },
      emptyState('us-east-1', 'acme.com')
    );

    expect(ec2.commandCalls(ImportKeyPairCommand)).toHaveLength(1);
    expect(ec2.commandCalls(CreateKeyPairCommand)).toHaveLength(0);
    expect(r.privateKeyPem).toBeNull();
  });
});
