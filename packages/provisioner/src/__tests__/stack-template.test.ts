import { describe, it, expect } from 'vitest';
import { parse as yamlParse } from 'yaml';
import {
  buildStackTemplate,
  MAIL_INGRESS_PORTS,
  templateToYaml,
  templateToJson,
} from '../infra/stack-template.js';

interface TplView {
  Parameters: Record<string, unknown>;
  Conditions: Record<string, unknown>;
  Resources: Record<
    string,
    { Type: string; Condition?: string; Properties: Record<string, unknown> }
  >;
  Outputs: Record<string, unknown>;
}
const t = buildStackTemplate() as unknown as TplView;

describe('buildStackTemplate (CloudFormation)', () => {
  it('expone los parameters que el CLI rellena', () => {
    expect(Object.keys(t.Parameters)).toEqual(
      expect.arrayContaining([
        'DomainName',
        'InstanceType',
        'ImageId',
        'KeyName',
        'ExistingVpcId',
        'ExistingSubnetId',
        'UserData',
        'SshCidr',
      ])
    );
    // Default SEGURO: un deploy pelado no exige bucket (storage local).
    expect(t.Parameters.S3Mode).toMatchObject({ Default: 'none' });
  });

  it('crea TODA la red bajo la condición CreateNetwork (cuenta nueva sin VPC)', () => {
    for (const r of [
      'VPC',
      'InternetGateway',
      'VPCGatewayAttachment',
      'Subnet',
      'RouteTable',
      'DefaultRoute',
      'SubnetRouteTableAssociation',
    ]) {
      expect(t.Resources[r]?.Condition, r).toBe('CreateNetwork');
    }
  });

  it('VpcId/SubnetId son condicionales: usan la existente si se pasa, si no la creada', () => {
    expect(t.Resources.SecurityGroup?.Properties.VpcId).toEqual({
      'Fn::If': ['CreateNetwork', { Ref: 'VPC' }, { Ref: 'ExistingVpcId' }],
    });
    expect(t.Resources.Instance?.Properties.SubnetId).toEqual({
      'Fn::If': ['CreateNetwork', { Ref: 'Subnet' }, { Ref: 'ExistingSubnetId' }],
    });
  });

  it('SG abre SSH + puertos de correo; EBS cifrado; user-data en base64', () => {
    const ingress = t.Resources.SecurityGroup?.Properties.SecurityGroupIngress as {
      FromPort: number;
    }[];
    const ports = ingress.map((x) => x.FromPort);
    expect(ports).toContain(22);
    for (const p of MAIL_INGRESS_PORTS) expect(ports, `puerto ${String(p)}`).toContain(p);

    const ebs = (
      t.Resources.Instance?.Properties.BlockDeviceMappings as {
        Ebs: { Encrypted: boolean; VolumeType: string };
      }[]
    )[0]?.Ebs;
    expect(ebs?.Encrypted).toBe(true);
    expect(ebs?.VolumeType).toBe('gp3');
    expect(t.Resources.Instance?.Properties.UserData).toHaveProperty('Fn::Base64');
  });

  it('S3/KMS + S3AccessPolicy son condicionales; el rol/perfil IAM están SIEMPRE (para cfn-signal)', () => {
    for (const r of ['KmsKey', 'KmsAlias', 'S3Bucket', 'S3BucketPolicy', 'S3AccessPolicy']) {
      expect(t.Resources[r]?.Condition, r).toBe('CreateS3');
    }
    // El rol y el perfil NO son condicionales: la instancia siempre necesita el perfil para cfn-signal.
    expect(t.Resources.InstanceRole?.Condition).toBeUndefined();
    expect(t.Resources.InstanceProfile?.Condition).toBeUndefined();
    expect(t.Resources.Instance?.Properties.IamInstanceProfile).toEqual({ Ref: 'InstanceProfile' });
    const enc = (
      t.Resources.S3Bucket?.Properties.BucketEncryption as {
        ServerSideEncryptionConfiguration: {
          ServerSideEncryptionByDefault: { SSEAlgorithm: string };
        }[];
      }
    ).ServerSideEncryptionConfiguration[0]?.ServerSideEncryptionByDefault.SSEAlgorithm;
    expect(enc).toBe('aws:kms');
  });

  it('endurecimiento: IMDSv2 requerido, EBS NO se borra al terminar, CreationPolicy presente', () => {
    expect(t.Resources.Instance?.Properties.MetadataOptions).toEqual({
      HttpEndpoint: 'enabled',
      HttpTokens: 'required',
    });
    const ebs = (
      t.Resources.Instance?.Properties.BlockDeviceMappings as {
        Ebs: { DeleteOnTermination: boolean };
      }[]
    )[0]?.Ebs;
    expect(ebs?.DeleteOnTermination).toBe(false); // no destruir los buzones al terminar
    expect(
      (t.Resources.Instance as unknown as { CreationPolicy?: unknown }).CreationPolicy
    ).toBeTruthy();
  });

  it('gestiona DNS (A/MX/SPF/DMARC) bajo ManageDns; condicional a tener HostedZoneId', () => {
    expect(t.Resources.DnsRecords?.Condition).toBe('ManageDns');
    const records = t.Resources.DnsRecords?.Properties.RecordSets as {
      Type: string;
      Name: unknown;
    }[];
    const types = records.map((r) => r.Type);
    expect(types).toContain('A');
    expect(types).toContain('MX');
    expect(types.filter((x) => x === 'TXT')).toHaveLength(2); // SPF + DMARC
    // ManageDns es opt-in: por defecto HostedZoneId vacío → no se tocan DNS.
    expect(t.Parameters.HostedZoneId).toMatchObject({ Default: '' });
  });

  it('outputs exponen la IP pública y el instanceId; serializa a JSON (TemplateBody)', () => {
    expect(Object.keys(t.Outputs)).toEqual(
      expect.arrayContaining(['PublicIp', 'InstanceId', 'VpcId'])
    );
    expect(() => JSON.parse(JSON.stringify(t))).not.toThrow();
  });

  it('emite YAML válido (el entregable) y JSON; el YAML re-parsea al mismo template', () => {
    const yaml = templateToYaml();
    expect(yaml).toContain('AWSTemplateFormatVersion');
    expect(yaml).toContain('AWS::EC2::VPC');
    expect(yaml).toContain('AWS::S3::Bucket');
    expect(yamlParse(yaml)).toEqual(buildStackTemplate());
    expect(() => JSON.parse(templateToJson())).not.toThrow();
  });
});
