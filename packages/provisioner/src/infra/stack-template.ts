/**
 * Template CloudFormation del stack all-in-one de Bifrost. Es la forma NATIVA y turnkey:
 *  - cuenta nueva sin nada → crea VPC + subnet + IGW + route table + SG + EIP + EC2 de una sola vez
 *    (dependencias y rollback los maneja CloudFormation);
 *  - ya tiene VPC → se pasa `ExistingVpcId`/`ExistingSubnetId` y reusa esa red;
 *  - teardown = borrar el stack (cero recursos huérfanos — supera al teardown imperativo).
 *
 * Se construye como objeto JS (testeable + tipado) y el CLI lo serializa a JSON para `CreateStack`
 * (CloudFormation acepta JSON; YAML y JSON son intercambiables). Los valores variables (dominio,
 * tipo, AMI, user-data, VPC elegida…) son PARAMETERS del template — un template, muchos despliegues.
 */

/** Puertos abiertos: 22 (SSH, CIDR configurable) + correo/web (a internet). */
const MAIL_PORTS = [25, 80, 443, 143, 465, 587, 993] as const;

export function buildStackTemplate(): Record<string, unknown> {
  const projectTags = [
    { Key: 'Project', Value: 'Bifrost' },
    { Key: 'ManagedBy', Value: 'bifrost-provision' },
  ];

  const sgIngress = [
    // SSH restringible a la IP del operador (param SshCidr).
    { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: { Ref: 'SshCidr' } },
    // Correo/web abiertos a internet (un MX debe ser alcanzable).
    ...MAIL_PORTS.map((p) => ({ IpProtocol: 'tcp', FromPort: p, ToPort: p, CidrIp: '0.0.0.0/0' })),
  ];

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Bifrost all-in-one (docker-mailserver + webmail) — VPC opcional, EC2, EIP.',
    Parameters: {
      DomainName: { Type: 'String', Description: 'Dominio de correo (ej. empresa.com)' },
      InstanceType: { Type: 'String', Default: 't3.large' },
      ImageId: { Type: 'AWS::EC2::Image::Id', Description: 'AMI Ubuntu (resuelto por SSM)' },
      KeyName: { Type: 'AWS::EC2::KeyPair::KeyName' },
      EbsSizeGiB: { Type: 'Number', Default: 40, MinValue: 20 },
      // Vacío = crear VPC nueva; con valor = usar la VPC/subnet existentes elegidas.
      ExistingVpcId: { Type: 'String', Default: '' },
      ExistingSubnetId: { Type: 'String', Default: '' },
      // user-data (cloud-init) en texto plano; se base64ea en el template.
      UserData: { Type: 'String' },
      SshCidr: { Type: 'String', Default: '0.0.0.0/0' },
    },
    Conditions: {
      // Si no se pasó una VPC existente, el stack crea toda la red.
      CreateNetwork: { 'Fn::Equals': [{ Ref: 'ExistingVpcId' }, ''] },
    },
    Resources: {
      VPC: {
        Type: 'AWS::EC2::VPC',
        Condition: 'CreateNetwork',
        Properties: {
          CidrBlock: '10.20.0.0/16',
          EnableDnsSupport: true,
          EnableDnsHostnames: true,
          Tags: projectTags,
        },
      },
      InternetGateway: {
        Type: 'AWS::EC2::InternetGateway',
        Condition: 'CreateNetwork',
        Properties: { Tags: projectTags },
      },
      VPCGatewayAttachment: {
        Type: 'AWS::EC2::VPCGatewayAttachment',
        Condition: 'CreateNetwork',
        Properties: { VpcId: { Ref: 'VPC' }, InternetGatewayId: { Ref: 'InternetGateway' } },
      },
      Subnet: {
        Type: 'AWS::EC2::Subnet',
        Condition: 'CreateNetwork',
        Properties: {
          VpcId: { Ref: 'VPC' },
          CidrBlock: '10.20.1.0/24',
          MapPublicIpOnLaunch: true,
          Tags: projectTags,
        },
      },
      RouteTable: {
        Type: 'AWS::EC2::RouteTable',
        Condition: 'CreateNetwork',
        Properties: { VpcId: { Ref: 'VPC' }, Tags: projectTags },
      },
      DefaultRoute: {
        Type: 'AWS::EC2::Route',
        Condition: 'CreateNetwork',
        DependsOn: 'VPCGatewayAttachment',
        Properties: {
          RouteTableId: { Ref: 'RouteTable' },
          DestinationCidrBlock: '0.0.0.0/0',
          GatewayId: { Ref: 'InternetGateway' },
        },
      },
      SubnetRouteTableAssociation: {
        Type: 'AWS::EC2::SubnetRouteTableAssociation',
        Condition: 'CreateNetwork',
        Properties: { SubnetId: { Ref: 'Subnet' }, RouteTableId: { Ref: 'RouteTable' } },
      },
      SecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: 'Bifrost mail + web',
          VpcId: { 'Fn::If': ['CreateNetwork', { Ref: 'VPC' }, { Ref: 'ExistingVpcId' }] },
          SecurityGroupIngress: sgIngress,
          Tags: projectTags,
        },
      },
      ElasticIP: {
        Type: 'AWS::EC2::EIP',
        Properties: { Domain: 'vpc', Tags: projectTags },
      },
      Instance: {
        Type: 'AWS::EC2::Instance',
        Properties: {
          ImageId: { Ref: 'ImageId' },
          InstanceType: { Ref: 'InstanceType' },
          KeyName: { Ref: 'KeyName' },
          SubnetId: { 'Fn::If': ['CreateNetwork', { Ref: 'Subnet' }, { Ref: 'ExistingSubnetId' }] },
          SecurityGroupIds: [{ Ref: 'SecurityGroup' }],
          BlockDeviceMappings: [
            {
              DeviceName: '/dev/sda1',
              Ebs: {
                VolumeSize: { Ref: 'EbsSizeGiB' },
                VolumeType: 'gp3',
                Encrypted: true,
                DeleteOnTermination: true,
              },
            },
          ],
          UserData: { 'Fn::Base64': { Ref: 'UserData' } },
          Tags: [...projectTags, { Key: 'Name', Value: { Ref: 'DomainName' } }],
        },
      },
      EIPAssociation: {
        Type: 'AWS::EC2::EIPAssociation',
        Properties: {
          AllocationId: { 'Fn::GetAtt': ['ElasticIP', 'AllocationId'] },
          InstanceId: { Ref: 'Instance' },
        },
      },
    },
    Outputs: {
      PublicIp: { Description: 'IP pública (apuntá el A/MX acá)', Value: { Ref: 'ElasticIP' } },
      InstanceId: { Value: { Ref: 'Instance' } },
      VpcId: { Value: { 'Fn::If': ['CreateNetwork', { Ref: 'VPC' }, { Ref: 'ExistingVpcId' }] } },
    },
  };
}

export const MAIL_INGRESS_PORTS = MAIL_PORTS;
