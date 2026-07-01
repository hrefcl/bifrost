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
import { MEET_EIP_MARKER } from '../mailserver/user-data.js';
import { LIVEKIT_EIP_MARKER } from '../meet/livekit-media-user-data.js';

/** Puertos abiertos: 22 (SSH, CIDR configurable) + correo/web (a internet). */
const MAIL_PORTS = [25, 80, 443, 143, 465, 587, 993] as const;

/**
 * Puertos MEDIA de LiveKit (2º SG, sólo con Meet ON). MÍNIMOS — NUNCA 1-65535. El 7880 (API/signaling)
 * jamás se publica (sólo Traefik lo alcanza por la red docker). Single-node usa mux 1 UDP (7882) +
 * 1 TCP de fallback (7881) + TURN/STUN embebido UDP (3478). TURN/TLS 5349 DIFERIDO (roadmap).
 */
const MEET_PORTS = [
  { IpProtocol: 'tcp', FromPort: 7881, ToPort: 7881 }, // ICE/TCP fallback
  { IpProtocol: 'udp', FromPort: 7882, ToPort: 7882 }, // mux UDP single-port
  { IpProtocol: 'udp', FromPort: 3478, ToPort: 3478 }, // TURN/STUN UDP (listen)
  // Rango de allocations del TURN embebido (turn.relay_range 30000-40000). Sin esto, el fallback TURN
  // no puede relayear media para clientes tras NAT restrictivo/simétrico. [deploy real from-zero]
  { IpProtocol: 'udp', FromPort: 30000, ToPort: 40000 }, // TURN relay range
] as const;

/**
 * Construye el template CloudFormation. Si se pasa `userData`, lo EMBEBE en el Instance
 * (`Fn::Base64` del literal) y omite el parámetro `UserData` — necesario porque un parámetro String
 * de CFN tope a 4096 chars y el cloud-init real son ~5KB (bug hallado en el deploy real). Sin
 * `userData`, deja el parámetro `UserData` (template genérico para validación/uso parametrizado).
 * En modo twobox, `livekitUserData` se embebe en el recurso `LivekitInstance`.
 */
export function buildStackTemplate(
  userData?: string,
  livekitUserData?: string
): Record<string, unknown> {
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

  const template: Record<string, unknown> = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description:
      'Bifrost all-in-one (docker-mailserver + webmail) — VPC opcional, EC2, EIP. Modo twobox: 2º EC2 dedicado a LiveKit.',
    Parameters: {
      DomainName: { Type: 'String', Description: 'Dominio de correo (ej. empresa.com)' },
      // Default Graviton t4g.large → DEBE coincidir con la arch del ImageId default (arm64). Un deploy
      // "pelado" (sin wizard) usa ambos defaults juntos; si divergen (p.ej. t3 x86 + AMI arm64) la
      // instancia NO bootea. El wizard pasa InstanceType+ImageId emparejados por arch. [hallazgo D]
      InstanceType: { Type: 'String', Default: 't4g.large' },
      // CloudFormation resuelve el AMI Ubuntu más reciente EN EL DEPLOY desde el parámetro público de
      // Canonical (por región). Así el modo SIN-CLAVES no necesita resolver el AMI (no hay llamada AWS)
      // y siempre se usa la imagen parcheada al día. El CLI no necesita pasar ImageId.
      // Default arm64 (Graviton) — coherente con el InstanceType default t4g. El wizard SIEMPRE pasa
      // el ImageId que matchea la arch de la instancia elegida (ver assembleStackParams), así que un
      // override a x86 (t3…) recibe el AMI amd64 correcto; este default sólo aplica a un deploy pelado.
      ImageId: {
        Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
        Default:
          '/aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id',
      },
      KeyName: { Type: 'AWS::EC2::KeyPair::KeyName' },
      EbsSizeGiB: { Type: 'Number', Default: 40, MinValue: 20 },
      // Vacío = crear VPC nueva; con valor = usar la VPC/subnet existentes elegidas.
      ExistingVpcId: { Type: 'String', Default: '' },
      ExistingSubnetId: { Type: 'String', Default: '' },
      // user-data (cloud-init) en texto plano; se base64ea en el template.
      UserData: { Type: 'String' },
      SshCidr: { Type: 'String', Default: '0.0.0.0/0' },
      // 'create' = crear S3 cifrado + KMS + rol IAM para el box; 'none' = storage local (sin S3).
      // Default 'none' (SEGURO): un deploy "pelado" del YAML funciona con storage local sin exigir un
      // nombre de bucket. El wizard pasa 'create' + S3BucketName explícito cuando se elige S3.
      S3Mode: { Type: 'String', Default: 'none', AllowedValues: ['create', 'none'] },
      // Nombre del bucket a crear (debe ser globalmente único; el CLI lo deriva del dominio).
      S3BucketName: { Type: 'String', Default: '' },
      // Zona Route53 para gestionar el DNS (A/MX/SPF/DMARC) desde el stack. Vacío = NO gestionar DNS
      // acá (el CLI imprime los registros para cargarlos a mano — seguro si la zona ya tiene records).
      HostedZoneId: { Type: 'String', Default: '' },
      // Modo Bifrost Meet: 'disabled' (default, seguro), 'enabled' (bundled, LiveKit en el mismo EC2),
      // 'external' (LiveKit ajeno, secret en SSM) o 'twobox' (2º EC2 dedicado a LiveKit).
      MeetMode: {
        Type: 'String',
        Default: 'disabled',
        AllowedValues: ['disabled', 'enabled', 'external', 'twobox'],
      },
      // Tipo de EC2 para el media-box en modo twobox. Default t4g.large (económico, suficiente para PYME).
      LivekitInstanceType: { Type: 'String', Default: 't4g.large' },
      // AMI para el media-box (el wizard pasa el SSM path según la arquitectura del tipo elegido).
      LivekitImageId: {
        Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
        Default:
          '/aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id',
      },
      // Nombre del parámetro SSM SecureString con la credencial SMTP de SES (lo escribe el orquestador
      // del CLI post-stack). Vacío = outbound SES deshabilitado. Con valor, el rol del box puede LEERLO
      // (ssm:GetParameter + kms:Decrypt) para cablear el relay cuando el outbound esté `ready`. §3/§7b.
      SesParamName: { Type: 'String', Default: '' },
      // Nombre del SSM SecureString con el apiSecret de LiveKit (modo external o twobox). Vacío = sin
      // LiveKit externo/twobox. Con valor, el rol del box puede LEERLO (ssm:GetParameter + kms:Decrypt).
      LivekitSecretParamName: { Type: 'String', Default: '' },
    },
    // CloudFormation Rules: validan parámetros ANTES de crear recursos y rechazan el deploy con un
    // mensaje claro. Protegen el path de despliegue STANDALONE (consola web / `aws cloudformation
    // deploy` directo, sin el wizard): el wizard ya empareja VPC+subnet, pero un deploy a mano podría
    // pasar ExistingVpcId sin ExistingSubnetId → CreateNetwork=false → el Fn::If del SubnetId caería en
    // la rama `ExistingSubnetId` VACÍA → instancia sin subnet → deploy roto/confuso. [hallazgo D]
    Rules: {
      SubnetRequiredWithExistingVpc: {
        RuleCondition: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'ExistingVpcId' }, ''] }] },
        Assertions: [
          {
            Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'ExistingSubnetId' }, ''] }] },
            AssertDescription:
              'Si especificás ExistingVpcId, también debés especificar ExistingSubnetId (la instancia necesita una subnet de esa VPC).',
          },
        ],
      },
      // Meet BUNDLED (MeetMode=enabled) requiere LivekitSecretParamName vacío (no tiene sentido secret
      // externo cuando las claves se generan en el host). Los modos external/twobox SÍ usan el param.
      ExternalLivekitExcludesBundledMeet: {
        RuleCondition: { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'enabled'] },
        Assertions: [
          {
            Assert: { 'Fn::Equals': [{ Ref: 'LivekitSecretParamName' }, ''] },
            AssertDescription:
              'MeetMode=enabled (LiveKit bundled) es incompatible con LivekitSecretParamName. Para LiveKit externo/twobox usá MeetMode=external o twobox.',
          },
        ],
      },
    },
    Conditions: {
      // Si no se pasó una VPC existente, el stack crea toda la red.
      CreateNetwork: { 'Fn::Equals': [{ Ref: 'ExistingVpcId' }, ''] },
      // Crear el repositorio de datos cifrado en S3 (+ KMS + rol IAM para que el box lo acceda).
      CreateS3: { 'Fn::Equals': [{ Ref: 'S3Mode' }, 'create'] },
      // Gestionar el DNS desde el stack sólo si se dio una zona (opt-in; el default es no tocar DNS).
      ManageDns: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'HostedZoneId' }, ''] }] },
      // Bifrost Meet BUNDLED: LiveKit en el mismo EC2 (2º SG, DNS meet./turn. → EIP del app-box).
      EnableBundledMeet: { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'enabled'] },
      // Bifrost Meet TWOBOX: 2º EC2 dedicado a LiveKit.
      EnableTwobox: { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'twobox'] },
      // Cualquier modo Meet activo (para DNS meet./turn. y output MeetUrl).
      EnableAnyMeet: {
        'Fn::Or': [
          { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'enabled'] },
          { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'external'] },
          { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'twobox'] },
        ],
      },
      // DNS de Meet sólo si se gestiona el DNS Y Meet es bundled o twobox (en external el LiveKit
      // ajeno ya tiene su propio DNS; no apuntamos meet.<dom> a nuestra infra).
      ManageMeetDns: {
        'Fn::And': [
          { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'HostedZoneId' }, ''] }] },
          {
            'Fn::Or': [
              { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'enabled'] },
              { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'twobox'] },
            ],
          },
        ],
      },
      // Outbound SES habilitado: dar al rol del box permiso de leer la credencial SMTP de SSM.
      EnableSes: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'SesParamName' }, ''] }] },
      // LiveKit externo/twobox: dar al rol permiso de leer el apiSecret de Meet de SSM.
      EnableLivekitSecret: {
        'Fn::Or': [
          { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'external'] },
          { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'twobox'] },
        ],
      },
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
      // 2º SG CONDICIONAL (sólo Meet BUNDLED): puertos MEDIA de LiveKit. Recurso SEPARADO a propósito → el SG
      // base queda BYTE-IDÉNTICO con Meet OFF (los tests lo asertan). Se asocia a la instancia vía lista
      // condicional (abajo). Puertos mínimos (7881/tcp, 7882/udp, 3478/udp) — NUNCA 1-65535.
      MeetSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Condition: 'EnableBundledMeet',
        Properties: {
          GroupDescription: 'Bifrost Meet (LiveKit media)',
          VpcId: { 'Fn::If': ['CreateNetwork', { Ref: 'VPC' }, { Ref: 'ExistingVpcId' }] },
          SecurityGroupIngress: MEET_PORTS.map((p) => ({ ...p, CidrIp: '0.0.0.0/0' })),
          Tags: projectTags,
        },
      },
      ElasticIP: {
        Type: 'AWS::EC2::EIP',
        Properties: { Domain: 'vpc', Tags: projectTags },
      },
      Instance: {
        Type: 'AWS::EC2::Instance',
        // CreationPolicy: CREATE_COMPLETE sólo cuando el user-data señaliza éxito (cfn-signal). Sin
        // esto, el stack reporta éxito aunque el bootstrap del mailserver falle (falso OK).
        CreationPolicy: { ResourceSignal: { Count: 1, Timeout: 'PT15M' } },
        Properties: {
          ImageId: { Ref: 'ImageId' },
          InstanceType: { Ref: 'InstanceType' },
          KeyName: { Ref: 'KeyName' },
          SubnetId: { 'Fn::If': ['CreateNetwork', { Ref: 'Subnet' }, { Ref: 'ExistingSubnetId' }] },
          // SG base SIEMPRE; el 2º SG (Meet bundled) sólo con MeetMode=enabled. `AWS::NoValue` ELIMINA el
          // elemento cuando no aplica → la lista efectiva es `[SecurityGroup]`, idéntica al stack pre-Meet.
          SecurityGroupIds: [
            { Ref: 'SecurityGroup' },
            {
              'Fn::If': [
                'EnableBundledMeet',
                { Ref: 'MeetSecurityGroup' },
                { Ref: 'AWS::NoValue' },
              ],
            },
          ],
          // IMDSv2 obligatorio (HttpTokens required) — cierra el SSRF a credenciales de IMDSv1.
          // HopLimit=2: la API corre en un CONTENEDOR Docker → alcanzar el IMDS suma un hop de red; con
          // el default 1, las requests IMDSv2 desde el contenedor fallan y el S3-por-rol no autentica.
          MetadataOptions: {
            HttpEndpoint: 'enabled',
            HttpTokens: 'required',
            HttpPutResponseHopLimit: 2,
          },
          BlockDeviceMappings: [
            {
              DeviceName: '/dev/sda1',
              Ebs: {
                VolumeSize: { Ref: 'EbsSizeGiB' },
                VolumeType: 'gp3',
                Encrypted: true,
                // FALSE a propósito: el maildir/datos viven en este volumen. Borrarlo al terminar la
                // instancia destruiría TODOS los buzones. (Teardown deja el volumen; se borra a mano.)
                DeleteOnTermination: false,
              },
            },
          ],
          UserData: { 'Fn::Base64': { Ref: 'UserData' } },
          // Perfil IAM SIEMPRE presente: la base permite cfn-signal; con S3 suma acceso bucket+CMK.
          IamInstanceProfile: { Ref: 'InstanceProfile' },
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

      // ---- Bifrost Meet TWOBOX: 2º EC2 dedicado a LiveKit (condición EnableTwobox) ----
      // SG del media-box: 443 para WSS vía Caddy + puertos media de LiveKit. NUNCA 7880 público.
      LivekitSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Condition: 'EnableTwobox',
        Properties: {
          GroupDescription: 'Bifrost Meet media-box (LiveKit + Caddy)',
          VpcId: { 'Fn::If': ['CreateNetwork', { Ref: 'VPC' }, { Ref: 'ExistingVpcId' }] },
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: { Ref: 'SshCidr' } },
            // 80: ACME HTTP-01 + redirect http→https de Caddy (Let's Encrypt). 443: WSS/API vía Caddy. [B#1]
            { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
            ...MEET_PORTS.map((p) => ({ ...p, CidrIp: '0.0.0.0/0' })),
          ],
          Tags: projectTags,
        },
      },
      LivekitElasticIP: {
        Type: 'AWS::EC2::EIP',
        Condition: 'EnableTwobox',
        Properties: { Domain: 'vpc', Tags: projectTags },
      },
      LivekitInstance: {
        Type: 'AWS::EC2::Instance',
        Condition: 'EnableTwobox',
        CreationPolicy: { ResourceSignal: { Count: 1, Timeout: 'PT15M' } },
        Properties: {
          ImageId: { Ref: 'LivekitImageId' },
          InstanceType: { Ref: 'LivekitInstanceType' },
          KeyName: { Ref: 'KeyName' },
          SubnetId: { 'Fn::If': ['CreateNetwork', { Ref: 'Subnet' }, { Ref: 'ExistingSubnetId' }] },
          SecurityGroupIds: [{ Ref: 'LivekitSecurityGroup' }],
          MetadataOptions: {
            HttpEndpoint: 'enabled',
            HttpTokens: 'required',
            HttpPutResponseHopLimit: 2,
          },
          BlockDeviceMappings: [
            {
              DeviceName: '/dev/sda1',
              Ebs: {
                VolumeSize: 40,
                VolumeType: 'gp3',
                Encrypted: true,
                DeleteOnTermination: true,
              },
            },
          ],
          UserData: { 'Fn::Base64': { Ref: 'UserData' } },
          IamInstanceProfile: { Ref: 'LivekitInstanceProfile' }, // rol propio mínimo (no el del app-box) [B-HIGH]
          Tags: [...projectTags, { Key: 'Name', Value: { 'Fn::Sub': 'livekit-${DomainName}' } }],
        },
      },
      LivekitEIPAssociation: {
        Type: 'AWS::EC2::EIPAssociation',
        Condition: 'EnableTwobox',
        Properties: {
          AllocationId: { 'Fn::GetAtt': ['LivekitElasticIP', 'AllocationId'] },
          InstanceId: { Ref: 'LivekitInstance' },
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
              // NOTA: no se deniega el PUT sin header de cifrado — el bucket ya tiene default
              // encryption SSE-KMS (todo objeto queda cifrado en reposo). Denegar por el header
              // rompería clientes que confían en el default encryption (hallazgo B/D).
            ],
          },
        },
      },
      InstanceRole: {
        Type: 'AWS::IAM::Role',
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
          // Base SIEMPRE: sólo cfn-signal sobre ESTE stack (mínimo privilegio).
          Policies: [
            {
              PolicyName: 'bifrost-base',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: 'cloudformation:SignalResource',
                    Resource: {
                      'Fn::Sub':
                        'arn:aws:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${AWS::StackName}/*',
                    },
                  },
                ],
              },
            },
          ],
          Tags: projectTags,
        },
      },
      // Acceso al bucket+CMK SÓLO si hay S3 (policy condicional adjunta al mismo rol).
      S3AccessPolicy: {
        Type: 'AWS::IAM::Policy',
        Condition: 'CreateS3',
        Properties: {
          PolicyName: 'bifrost-s3-kms',
          Roles: [{ Ref: 'InstanceRole' }],
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  's3:GetObject',
                  's3:PutObject',
                  's3:DeleteObject',
                  's3:ListBucket',
                  's3:GetBucketLocation',
                ],
                Resource: [
                  { 'Fn::GetAtt': ['S3Bucket', 'Arn'] },
                  { 'Fn::Sub': '${S3Bucket.Arn}/*' },
                ],
              },
              {
                Effect: 'Allow',
                Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
                Resource: { 'Fn::GetAtt': ['KmsKey', 'Arn'] },
              },
            ],
          },
        },
      },
      // Lectura de la credencial SMTP de SES (SSM SecureString) SÓLO si el outbound SES está habilitado.
      // El box la lee con el rol al boot (send-gating) — el SecretAccessKey de AWS nunca toca el box,
      // sólo el password SMTP ya derivado. §3/§7b.
      SesAccessPolicy: {
        Type: 'AWS::IAM::Policy',
        Condition: 'EnableSes',
        Properties: {
          PolicyName: 'bifrost-ses-ssm',
          Roles: [{ Ref: 'InstanceRole' }],
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['ssm:GetParameter'],
                // El nombre del parámetro empieza con '/', así el ARN queda :parameter/bifrost/...
                Resource: {
                  'Fn::Sub':
                    'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${SesParamName}',
                },
              },
              {
                // Descifrar el SecureString. Acotado por kms:ViaService a SSM → la key (gestionada
                // alias/aws/ssm) sólo se puede usar a través de SSM, no para otra cosa.
                Effect: 'Allow',
                Action: ['kms:Decrypt'],
                Resource: '*',
                Condition: {
                  StringEquals: {
                    'kms:ViaService': { 'Fn::Sub': 'ssm.${AWS::Region}.amazonaws.com' },
                  },
                },
              },
            ],
          },
        },
      },
      // Lectura del apiSecret de LiveKit (modo external o twobox) desde SSM SecureString. El box lo lee
      // con el rol al boot. Espeja SesAccessPolicy (el mismo patrón seguro): el secret nunca viaja en
      // user-data/CFN, sólo el rol puede descifrarlo vía SSM.
      LivekitSecretAccessPolicy: {
        Type: 'AWS::IAM::Policy',
        Condition: 'EnableLivekitSecret',
        Properties: {
          PolicyName: 'bifrost-livekit-ssm',
          Roles: [{ Ref: 'InstanceRole' }],
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['ssm:GetParameter'],
                Resource: {
                  'Fn::Sub':
                    'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${LivekitSecretParamName}',
                },
              },
              {
                // Descifrar el SecureString, acotado por kms:ViaService a SSM (alias/aws/ssm gestionada).
                Effect: 'Allow',
                Action: ['kms:Decrypt'],
                Resource: '*',
                Condition: {
                  StringEquals: {
                    'kms:ViaService': { 'Fn::Sub': 'ssm.${AWS::Region}.amazonaws.com' },
                  },
                },
              },
            ],
          },
        },
      },
      InstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Properties: { Roles: [{ Ref: 'InstanceRole' }] },
      },

      // Rol PROPIO y MÍNIMO del media-box (modo twobox): NO reusa el rol del app-box (que tiene S3/SES/KMS).
      // Sólo cfn-signal sobre este stack + leer el apiSecret de LiveKit de SSM + descifrarlo vía SSM.
      // Least-privilege: el media-box no toca buzones, adjuntos ni SES. [review B — HIGH]
      LivekitInstanceRole: {
        Type: 'AWS::IAM::Role',
        Condition: 'EnableTwobox',
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
              PolicyName: 'bifrost-livekit-base',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: 'cloudformation:SignalResource',
                    Resource: {
                      'Fn::Sub':
                        'arn:aws:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${AWS::StackName}/*',
                    },
                  },
                  {
                    Effect: 'Allow',
                    Action: ['ssm:GetParameter'],
                    Resource: {
                      'Fn::Sub':
                        'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${LivekitSecretParamName}',
                    },
                  },
                  {
                    Effect: 'Allow',
                    Action: ['kms:Decrypt'],
                    Resource: '*',
                    Condition: {
                      StringEquals: {
                        'kms:ViaService': { 'Fn::Sub': 'ssm.${AWS::Region}.amazonaws.com' },
                      },
                    },
                  },
                ],
              },
            },
          ],
          Tags: projectTags,
        },
      },
      LivekitInstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Condition: 'EnableTwobox',
        Properties: { Roles: [{ Ref: 'LivekitInstanceRole' }] },
      },

      // ---- DNS (condición ManageDns: sólo si se dio una zona Route53) ----
      // A → mail.dominio, MX → mail, SPF y DMARC. El DKIM NO va acá (la clave se genera en el box al
      // boot; su registro se agrega después). Un grupo de records = un solo recurso.
      DnsRecords: {
        Type: 'AWS::Route53::RecordSetGroup',
        Condition: 'ManageDns',
        Properties: {
          HostedZoneId: { Ref: 'HostedZoneId' },
          RecordSets: [
            {
              Name: { 'Fn::Sub': 'mail.${DomainName}' },
              Type: 'A',
              TTL: '300',
              ResourceRecords: [{ Ref: 'ElasticIP' }],
            },
            {
              // webmail.<dominio> → la UI web (Traefik/Bifrost lo usan para front + TLS).
              Name: { 'Fn::Sub': 'webmail.${DomainName}' },
              Type: 'A',
              TTL: '300',
              ResourceRecords: [{ Ref: 'ElasticIP' }],
            },
            {
              Name: { Ref: 'DomainName' },
              Type: 'MX',
              TTL: '300',
              ResourceRecords: [{ 'Fn::Sub': '10 mail.${DomainName}' }],
            },
            {
              Name: { Ref: 'DomainName' },
              Type: 'TXT',
              TTL: '300',
              // ~all (softfail) en el setup inicial: evita rebotar correo legítimo mientras se afina
              // la config; endurecer a -all después. Coherente con deploy/example-mailserver/setup.sh.
              ResourceRecords: ['"v=spf1 mx ~all"'],
            },
            {
              Name: { 'Fn::Sub': '_dmarc.${DomainName}' },
              Type: 'TXT',
              TTL: '300',
              ResourceRecords: ['"v=DMARC1; p=quarantine"'],
            },
            // A meet.<dom> y turn.meet.<dom> → app-box EIP (bundled) o media-box EIP (twobox),
            // SÓLO cuando ManageMeetDns es true. `AWS::NoValue` elimina el elemento cuando no aplica.
            {
              'Fn::If': [
                'ManageMeetDns',
                {
                  Name: { 'Fn::Sub': 'meet.${DomainName}' },
                  Type: 'A',
                  TTL: '300',
                  ResourceRecords: [
                    {
                      'Fn::If': ['EnableTwobox', { Ref: 'LivekitElasticIP' }, { Ref: 'ElasticIP' }],
                    },
                  ],
                },
                { Ref: 'AWS::NoValue' },
              ],
            },
            {
              'Fn::If': [
                'ManageMeetDns',
                {
                  Name: { 'Fn::Sub': 'turn.meet.${DomainName}' },
                  Type: 'A',
                  TTL: '300',
                  ResourceRecords: [
                    {
                      'Fn::If': ['EnableTwobox', { Ref: 'LivekitElasticIP' }, { Ref: 'ElasticIP' }],
                    },
                  ],
                },
                { Ref: 'AWS::NoValue' },
              ],
            },
          ],
        },
      },
    },
    Outputs: {
      PublicIp: {
        Description: 'IP pública del app-box (mail/webmail/MX; meet/turn en modo bundled)',
        Value: { Ref: 'ElasticIP' },
      },
      InstanceId: { Value: { Ref: 'Instance' } },
      VpcId: { Value: { 'Fn::If': ['CreateNetwork', { Ref: 'VPC' }, { Ref: 'ExistingVpcId' }] } },
      S3Bucket: {
        Condition: 'CreateS3',
        Description: 'Bucket de datos cifrado',
        Value: { Ref: 'S3Bucket' },
      },
      S3Region: {
        Condition: 'CreateS3',
        Description: 'Región del bucket (para el provider S3 vía rol del EC2)',
        Value: { Ref: 'AWS::Region' },
      },
      MediaPublicIp: {
        Condition: 'EnableTwobox',
        Description: 'IP pública del media-box (meet.<dom> / turn.meet.<dom> en modo twobox)',
        Value: { Ref: 'LivekitElasticIP' },
      },
      MeetUrl: {
        Condition: 'EnableAnyMeet',
        Description:
          'URL pública de Bifrost Meet (apuntá meet.<dom> y turn.meet.<dom> a la IP correcta)',
        Value: { 'Fn::Sub': 'https://meet.${DomainName}' },
      },
    },
  };

  // Si nos dan el cloud-init del app-box, lo EMBEBEMOS (literal) y quitamos el parámetro UserData:
  // un parámetro String de CFN tope a 4096 chars y el script real son ~5KB. El template body sí admite.
  // El cloud-init del media-box (modo twobox) se embebe en el recurso LivekitInstance.
  const resources = template.Resources as Record<string, { Properties: Record<string, unknown> }>;
  if (userData !== undefined) {
    const params = template.Parameters as Record<string, unknown>;
    delete params.UserData;
    resources.Instance.Properties.UserData = {
      'Fn::Base64': embedUserData(userData, {
        marker: MEET_EIP_MARKER,
        eipResource: 'ElasticIP',
        condition: 'EnableBundledMeet',
      }),
    };
    // CRÍTICO: borrado el parámetro `UserData`, `LivekitInstance.UserData` (que lo referenciaba) quedaría
    // con un `Ref: UserData` COLGANTE. CFN valida los Ref aunque el recurso sea CONDICIONAL (EnableTwobox) →
    // rechazaría TODO deploy (incluso no-twobox). Si no se embebe el media user-data, placeholder literal. [B-HIGH]
    if (livekitUserData === undefined) {
      resources.LivekitInstance.Properties.UserData = { 'Fn::Base64': '' };
    }
  }
  if (livekitUserData !== undefined) {
    resources.LivekitInstance.Properties.UserData = {
      'Fn::Base64': embedUserData(livekitUserData, {
        marker: LIVEKIT_EIP_MARKER,
        eipResource: 'LivekitElasticIP',
        condition: 'EnableTwobox',
      }),
    };
  }

  return template;
}

/**
 * Embebe el user-data en el template. Si contiene el marcador de la EIP, lo sustituye por
 * `GetAtt <eipResource>.PublicIp` vía **`Fn::Join`** — NO `Fn::Sub`: `Fn::Sub` interpolaría TODOS los
 * `${VAR}` del bash del cloud-init (cada variable rompería salvo escaparla `${!VAR}`, frágil). `Fn::Join`
 * concatena las partes literales SIN tocar el `$`. La IP la inyecta CFN desde la EIP asignada (NO IMDS —
 * el EIPAssociation asocia DESPUÉS de que user-data señaliza, así que IMDS devolvería la IP efímera de
 * launch). `GetAtt <eipResource>.PublicIp` crea la dependencia implícita Instance→EIP. Sin marcador →
 * Base64 del literal.
 */
function embedUserData(
  userData: string,
  opts: { marker: string; eipResource: string; condition: string }
): unknown {
  if (!userData.includes(opts.marker)) return userData;
  const parts = userData.split(opts.marker);
  const eip = {
    'Fn::If': [opts.condition, { 'Fn::GetAtt': [opts.eipResource, 'PublicIp'] }, ''],
  };
  const joinList: unknown[] = [];
  parts.forEach((part, i) => {
    joinList.push(part);
    if (i < parts.length - 1) joinList.push(eip);
  });
  return { 'Fn::Join': ['', joinList] };
}

export const MAIL_INGRESS_PORTS = MAIL_PORTS;
export const MEET_INGRESS_PORTS = MEET_PORTS;

/** El template como YAML de CloudFormation (el entregable que el CLI ofrece correr o entregar). */
export function templateToYaml(template: Record<string, unknown> = buildStackTemplate()): string {
  // `aliasDuplicateObjects: false` es OBLIGATORIO: el builder reutiliza la MISMA referencia de objeto
  // (p.ej. los project tags, o un `{ Ref: 'ElasticIP' }` compartido) en varios lugares, y por defecto
  // el serializador YAML emite anchors/aliases (&x / *x) para esas repeticiones. CloudFormation NO
  // acepta aliases YAML → "Template error: YAML aliases are not allowed". Esto duplica el contenido.
  return yamlStringify(template, { aliasDuplicateObjects: false });
}

/** El template como JSON (lo que se pasa como `TemplateBody` a CreateStack). */
export function templateToJson(template: Record<string, unknown> = buildStackTemplate()): string {
  return JSON.stringify(template, null, 2);
}
