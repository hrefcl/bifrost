import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudFormationClient,
  CreateStackCommand,
  UpdateStackCommand,
  DescribeStacksCommand,
  DeleteStackCommand,
} from '@aws-sdk/client-cloudformation';
import { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import {
  deployStack,
  getStackOutputs,
  deleteStack,
  getStackStatus,
} from '../aws/cloudformation.js';
import { listVpcs, listSubnets } from '../aws/vpc.js';

const cfn = mockClient(CloudFormationClient);
const ec2 = mockClient(EC2Client);

beforeEach(() => {
  cfn.reset();
  ec2.reset();
});

const deployInput = {
  stackName: 'bifrost-acme',
  templateBody: '{"x":1}',
  params: [{ key: 'DomainName', value: 'acme.com' }],
};

describe('deployStack', () => {
  it('crea el stack si no existe (CreateStack, OnFailure DELETE)', async () => {
    cfn.on(DescribeStacksCommand).rejects(new Error('Stack does not exist'));
    cfn.on(CreateStackCommand).resolves({ StackId: 'arn:stack/1' });

    const action = await deployStack(
      new CloudFormationClient({ region: 'us-east-1' }),
      deployInput
    );

    expect(action).toBe('created');
    const call = cfn.commandCalls(CreateStackCommand)[0]?.args[0].input;
    expect(call?.OnFailure).toBe('DELETE');
    expect(call?.Parameters).toEqual([{ ParameterKey: 'DomainName', ParameterValue: 'acme.com' }]);
    expect(cfn.commandCalls(UpdateStackCommand)).toHaveLength(0);
  });

  it('actualiza el stack si ya existe (UpdateStack)', async () => {
    cfn.on(DescribeStacksCommand).resolves({ Stacks: [{ StackName: 'bifrost-acme' } as never] });
    cfn.on(UpdateStackCommand).resolves({});

    const action = await deployStack(
      new CloudFormationClient({ region: 'us-east-1' }),
      deployInput
    );

    expect(action).toBe('updated');
    expect(cfn.commandCalls(CreateStackCommand)).toHaveLength(0);
  });

  it('re-run sin cambios → "unchanged" (idempotente, no error)', async () => {
    cfn.on(DescribeStacksCommand).resolves({ Stacks: [{ StackName: 'bifrost-acme' } as never] });
    cfn.on(UpdateStackCommand).rejects(new Error('No updates are to be performed.'));
    const action = await deployStack(
      new CloudFormationClient({ region: 'us-east-1' }),
      deployInput
    );
    expect(action).toBe('unchanged');
  });

  it('RE-LANZA errores que NO son "does not exist" (permisos), no los trata como inexistente', async () => {
    cfn.on(DescribeStacksCommand).rejects(new Error('AccessDenied: not authorized'));
    await expect(
      deployStack(new CloudFormationClient({ region: 'us-east-1' }), deployInput)
    ).rejects.toThrow(/AccessDenied/);
  });
});

describe('getStackOutputs / status / delete', () => {
  it('mapea Outputs a un dict', async () => {
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackStatus: 'CREATE_COMPLETE',
          Outputs: [
            { OutputKey: 'PublicIp', OutputValue: '1.2.3.4' },
            { OutputKey: 'InstanceId', OutputValue: 'i-1' },
          ],
        } as never,
      ],
    });
    const out = await getStackOutputs(
      new CloudFormationClient({ region: 'us-east-1' }),
      'bifrost-acme'
    );
    expect(out).toEqual({ PublicIp: '1.2.3.4', InstanceId: 'i-1' });
  });

  it('getStackStatus null si no existe', async () => {
    cfn.on(DescribeStacksCommand).rejects(new Error('does not exist'));
    expect(
      await getStackStatus(new CloudFormationClient({ region: 'us-east-1' }), 'nope')
    ).toBeNull();
  });

  it('deleteStack envía DeleteStack', async () => {
    cfn.on(DeleteStackCommand).resolves({});
    await deleteStack(new CloudFormationClient({ region: 'us-east-1' }), 'bifrost-acme');
    expect(cfn.commandCalls(DeleteStackCommand)[0]?.args[0].input.StackName).toBe('bifrost-acme');
  });
});

describe('listVpcs / listSubnets', () => {
  it('lista VPCs con flag isDefault', async () => {
    ec2.on(DescribeVpcsCommand).resolves({
      Vpcs: [
        { VpcId: 'vpc-1', IsDefault: true, CidrBlock: '172.31.0.0/16' },
        { VpcId: 'vpc-2', IsDefault: false, CidrBlock: '10.0.0.0/16' },
      ],
    });
    const vpcs = await listVpcs(new EC2Client({ region: 'us-east-1' }));
    expect(vpcs).toHaveLength(2);
    expect(vpcs[0]).toEqual({ id: 'vpc-1', isDefault: true, cidr: '172.31.0.0/16' });
  });

  it('lista subnets de una VPC marcando las públicas', async () => {
    ec2.on(DescribeSubnetsCommand).resolves({
      Subnets: [
        {
          SubnetId: 'subnet-1',
          VpcId: 'vpc-1',
          AvailabilityZone: 'us-east-1a',
          CidrBlock: '172.31.1.0/24',
          MapPublicIpOnLaunch: true,
        },
      ],
    });
    const subs = await listSubnets(new EC2Client({ region: 'us-east-1' }), 'vpc-1');
    expect(subs[0]?.mapPublicIp).toBe(true);
    expect(cfn.commandCalls(DeleteStackCommand)).toHaveLength(0); // no cruza con cfn
  });
});
