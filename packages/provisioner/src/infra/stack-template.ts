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

import { stringify as yamlStringify } from 'yaml';

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
      // 'create' = crear S3 cifrado + KMS + rol IAM para el box; 'none' = storage local (sin S3).
      S3Mode: { Type: 'String', Default: 'create', AllowedValues: ['create', 'none'] },
      // Nombre del bucket a crear (debe ser globalmente único; el CLI lo deriva del dominio).
      S3BucketName: { Type: 'String', Default: '' },
    },
    Conditions: {
      // Si no se pasó una VPC existente, el stack crea toda la red.
      CreateNetwork: { 'Fn::Equals': [{ Ref: 'ExistingVpcId' }, ''] },
      // Crear el repositorio de datos cifrado en S3 (+ KMS + rol IAM para que el box lo acceda).
      CreateS3: { 'Fn::Equals': [{ Ref: 'S3Mode' }, 'create'] },
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
          // Perfil IAM SÓLO si hay S3: da acceso al bucket+CMK por ROL (sin claves estáticas).
          IamInstanceProfile: {
            'Fn::If': ['CreateS3', { Ref: 'InstanceProfile' }, { Ref: 'AWS::NoValue' }],
          },
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

      // ---- Repositorio de datos cifrado en S3 (condición CreateS3) ----
      KmsKey: {
        Type: 'AWS::KMS::Key',
        Condition: 'CreateS3',
        Properties: {
          Description: 'Bifrost data encryption (S3/EBS)',
          EnableKeyRotation: true,
          KeyPolicy: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'root',
                Effect: 'Allow',
                Principal: { AWS: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:root' } },
                Action: 'kms:*',
                Resource: '*',
              },
            ],
          },
          Tags: projectTags,
        },
      },
      KmsAlias: {
        Type: 'AWS::KMS::Alias',
        Condition: 'CreateS3',
        Properties: {
          AliasName: { 'Fn::Sub': 'alias/bifrost-${AWS::StackName}' },
          TargetKeyId: { Ref: 'KmsKey' },
        },
      },
      S3Bucket: {
        Type: 'AWS::S3::Bucket',
        Condition: 'CreateS3',
        Properties: {
          BucketName: { Ref: 'S3BucketName' },
          VersioningConfiguration: { Status: 'Enabled' },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              {
                ServerSideEncryptionByDefault: {
                  SSEAlgorithm: 'aws:kms',
                  KMSMasterKeyID: { Ref: 'KmsKey' },
                },
                BucketKeyEnabled: true,
              },
            ],
          },
          Tags: projectTags,
        },
      },
      S3BucketPolicy: {
        Type: 'AWS::S3::BucketPolicy',
        Condition: 'CreateS3',
        Properties: {
          Bucket: { Ref: 'S3Bucket' },
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'DenyInsecureTransport',
                Effect: 'Deny',
                Principal: '*',
                Action: 's3:*',
                Resource: [
                  { 'Fn::GetAtt': ['S3Bucket', 'Arn'] },
                  { 'Fn::Sub': '${S3Bucket.Arn}/*' },
                ],
                Condition: { Bool: { 'aws:SecureTransport': 'false' } },
              },
              {
                Sid: 'DenyUnencryptedPut',
                Effect: 'Deny',
                Principal: '*',
                Action: 's3:PutObject',
                Resource: { 'Fn::Sub': '${S3Bucket.Arn}/*' },
                Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
              },
            ],
          },
        },
      },
      S3Role: {
        Type: 'AWS::IAM::Role',
        Condition: 'CreateS3',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'ec2.amazonaws.com' },
                Action: 'sts:AssumeRole',
              },
            ],
          },
          Policies: [
            {
              PolicyName: 'bifrost-s3-kms',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
                    Resource: [
                      { 'Fn::GetAtt': ['S3Bucket', 'Arn'] },
                      { 'Fn::Sub': '${S3Bucket.Arn}/*' },
                    ],
                  },
                  {
                    Effect: 'Allow',
                    Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
                    Resource: { 'Fn::GetAtt': ['KmsKey', 'Arn'] },
                  },
                ],
              },
            },
          ],
          Tags: projectTags,
        },
      },
      InstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Condition: 'CreateS3',
        Properties: { Roles: [{ Ref: 'S3Role' }] },
      },
    },
    Outputs: {
      PublicIp: { Description: 'IP pública (apuntá el A/MX acá)', Value: { Ref: 'ElasticIP' } },
      InstanceId: { Value: { Ref: 'Instance' } },
      VpcId: { Value: { 'Fn::If': ['CreateNetwork', { Ref: 'VPC' }, { Ref: 'ExistingVpcId' }] } },
      S3Bucket: {
        Condition: 'CreateS3',
        Description: 'Bucket de datos cifrado',
        Value: { Ref: 'S3Bucket' },
      },
    },
  };
}

export const MAIL_INGRESS_PORTS = MAIL_PORTS;

/** El template como YAML de CloudFormation (el entregable que el CLI ofrece correr o entregar). */
export function templateToYaml(template: Record<string, unknown> = buildStackTemplate()): string {
  return yamlStringify(template);
}

/** El template como JSON (lo que se pasa como `TemplateBody` a CreateStack). */
export function templateToJson(template: Record<string, unknown> = buildStackTemplate()): string {
  return JSON.stringify(template, null, 2);
}
