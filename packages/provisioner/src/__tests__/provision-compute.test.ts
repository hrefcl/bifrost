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
  AllocateAddressCommand,
  RunInstancesCommand,
  AssociateAddressCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { provisionComputeIdentity, provisionInstance } from '../steps/provision-compute.js';
import { emptyState, addResource } from '../state.js';

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

const instInput = {
  domain: 'acme.com',
  instanceType: 't3.large',
  amiId: 'ami-123',
  keyName: 'bifrost',
  securityGroupId: 'sg-1',
  ebsGiB: 40,
  userData: '#!/bin/bash\necho hi',
};

describe('provisionInstance', () => {
  it('fresh: asigna EIP, lanza instancia (user-data base64, gp3 cifrado), asocia, marca associated y persiste incremental', async () => {
    ec2.on(AllocateAddressCommand).resolves({ AllocationId: 'eipalloc-1', PublicIp: '1.2.3.4' });
    ec2.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: 'i-abc' }] });
    ec2.on(AssociateAddressCommand).resolves({});
    const saves: number[] = [];

    const r = await provisionInstance(
      clients().ec2,
      instInput,
      emptyState('us-east-1', 'acme.com'),
      {
        onResource: (st) => saves.push(st.resources.length),
      }
    );

    expect(r.instanceId).toBe('i-abc');
    expect(r.publicIp).toBe('1.2.3.4');
    expect(r.state.resources.map((x) => x.kind)).toEqual(['elastic-ip', 'ec2-instance']);
    // La instancia quedó marcada associated (para no re-asociar en un re-run).
    expect(r.state.resources.find((x) => x.kind === 'ec2-instance')?.meta?.associated).toBe('true');
    // Persistencia incremental: EIP, instancia (pre-associate), instancia (post-associate) = 3.
    expect(saves).toEqual([1, 2, 2]);
    const runCall = ec2.commandCalls(RunInstancesCommand)[0]?.args[0].input;
    const decoded = Buffer.from(String(runCall?.UserData), 'base64').toString('utf8');
    expect(decoded).toContain('#!/bin/bash');
    expect(runCall?.BlockDeviceMappings?.[0]?.Ebs?.VolumeType).toBe('gp3');
    expect(runCall?.BlockDeviceMappings?.[0]?.Ebs?.Encrypted).toBe(true);
    expect(ec2.commandCalls(AssociateAddressCommand)).toHaveLength(1);
  });

  it('terminado (instancia associated) → cero allocate/run/associate', async () => {
    let s = emptyState('us-east-1', 'acme.com');
    s = addResource(s, { kind: 'elastic-ip', id: 'eipalloc-1', meta: { publicIp: '1.2.3.4' } });
    s = addResource(s, { kind: 'ec2-instance', id: 'i-existing', meta: { associated: 'true' } });

    const r = await provisionInstance(clients().ec2, instInput, s);

    expect(r.instanceId).toBe('i-existing');
    expect(ec2.commandCalls(AllocateAddressCommand)).toHaveLength(0);
    expect(ec2.commandCalls(RunInstancesCommand)).toHaveLength(0);
    expect(ec2.commandCalls(AssociateAddressCommand)).toHaveLength(0);
  });

  it('crash tras RunInstances (instancia SIN associated) → reintenta associate, NO relanza', async () => {
    let s = emptyState('us-east-1', 'acme.com');
    s = addResource(s, { kind: 'elastic-ip', id: 'eipalloc-1', meta: { publicIp: '1.2.3.4' } });
    s = addResource(s, { kind: 'ec2-instance', id: 'i-half' }); // creada pero no asociada
    ec2.on(AssociateAddressCommand).resolves({});

    const r = await provisionInstance(clients().ec2, instInput, s);

    expect(ec2.commandCalls(RunInstancesCommand)).toHaveLength(0); // NO se relanza otra instancia
    expect(ec2.commandCalls(AssociateAddressCommand)).toHaveLength(1); // se reintenta la asociación
    expect(r.state.resources.find((x) => x.kind === 'ec2-instance')?.meta?.associated).toBe('true');
  });

  it('resumible: EIP asignada pero sin instancia → reusa EIP (no re-asigna) y lanza la instancia', async () => {
    let s = emptyState('us-east-1', 'acme.com');
    s = addResource(s, { kind: 'elastic-ip', id: 'eipalloc-9', meta: { publicIp: '9.9.9.9' } });
    ec2.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: 'i-new' }] });
    ec2.on(AssociateAddressCommand).resolves({});

    const r = await provisionInstance(clients().ec2, instInput, s);

    expect(ec2.commandCalls(AllocateAddressCommand)).toHaveLength(0); // reusa la EIP
    expect(r.allocationId).toBe('eipalloc-9');
    expect(r.instanceId).toBe('i-new');
    expect(ec2.commandCalls(AssociateAddressCommand)[0]?.args[0].input).toMatchObject({
      AllocationId: 'eipalloc-9',
      InstanceId: 'i-new',
    });
  });
});
