import { describe, it, expect } from 'vitest';
import { buildStackTemplate, MAIL_INGRESS_PORTS } from '../infra/stack-template.js';

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

  it('outputs exponen la IP pública y el instanceId; serializa a JSON (TemplateBody)', () => {
    expect(Object.keys(t.Outputs)).toEqual(
      expect.arrayContaining(['PublicIp', 'InstanceId', 'VpcId'])
    );
    expect(() => JSON.parse(JSON.stringify(t))).not.toThrow();
  });
});
