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

/**
 * Construye el template CloudFormation. Si se pasa `userData`, lo EMBEBE en el Instance
 * (`Fn::Base64` del literal) y omite el parámetro `UserData` — necesario porque un parámetro String
 * de CFN tope a 4096 chars y el cloud-init real son ~5KB (bug hallado en el deploy real). Sin
 * `userData`, deja el parámetro `UserData` (template genérico para validación/uso parametrizado).
 */
export function buildStackTemplate(userData?: string): Record<string, unknown> {
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
    Description: 'Bifrost all-in-one (docker-mailserver + webmail) — VPC opcional, EC2, EIP.',
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
    },
    Conditions: {
      // Si no se pasó una VPC existente, el stack crea toda la red.
      CreateNetwork: { 'Fn::Equals': [{ Ref: 'ExistingVpcId' }, ''] },
      // Crear el repositorio de datos cifrado en S3 (+ KMS + rol IAM para que el box lo acceda).
      CreateS3: { 'Fn::Equals': [{ Ref: 'S3Mode' }, 'create'] },
      // Gestionar el DNS desde el stack sólo si se dio una zona (opt-in; el default es no tocar DNS).
      ManageDns: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'HostedZoneId' }, ''] }] },
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
        // CreationPolicy: CREATE_COMPLETE sólo cuando el user-data señaliza éxito (cfn-signal). Sin
        // esto, el stack reporta éxito aunque el bootstrap del mailserver falle (falso OK).
        CreationPolicy: { ResourceSignal: { Count: 1, Timeout: 'PT15M' } },
        Properties: {
          ImageId: { Ref: 'ImageId' },
          InstanceType: { Ref: 'InstanceType' },
          KeyName: { Ref: 'KeyName' },
          SubnetId: { 'Fn::If': ['CreateNetwork', { Ref: 'Subnet' }, { Ref: 'ExistingSubnetId' }] },
          SecurityGroupIds: [{ Ref: 'SecurityGroup' }],
          // IMDSv2 obligatorio (HttpTokens required) — cierra el SSRF a credenciales de IMDSv1.
          MetadataOptions: { HttpEndpoint: 'enabled', HttpTokens: 'required' },
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
      },
      InstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Properties: { Roles: [{ Ref: 'InstanceRole' }] },
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
          ],
        },
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

  // Si nos dan el cloud-init, lo EMBEBEMOS (literal) y quitamos el parámetro UserData: un parámetro
  // String de CFN tope a 4096 chars y el script real son ~5KB. El template body sí admite el tamaño.
  if (userData !== undefined) {
    const params = template.Parameters as Record<string, unknown>;
    delete params.UserData;
    const resources = template.Resources as Record<string, { Properties: Record<string, unknown> }>;
    resources.Instance.Properties.UserData = { 'Fn::Base64': userData };
  }

  return template;
}

export const MAIL_INGRESS_PORTS = MAIL_PORTS;

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
