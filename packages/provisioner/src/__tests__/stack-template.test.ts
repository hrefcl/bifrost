import { describe, it, expect } from 'vitest';
import { parse as yamlParse } from 'yaml';
import {
  buildStackTemplate,
  MAIL_INGRESS_PORTS,
  MEET_INGRESS_PORTS,
  templateToYaml,
  templateToJson,
} from '../infra/stack-template.js';
import { MEET_EIP_MARKER } from '../mailserver/user-data.js';

interface TplView {
  Parameters: Record<string, unknown>;
  Rules: Record<string, { RuleCondition: unknown; Assertions: { Assert: unknown }[] }>;
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

  it('con userData lo EMBEBE (Fn::Base64 literal) y quita el parámetro UserData [bug deploy real]', () => {
    const script = '#!/bin/bash\necho hola';
    const emb = buildStackTemplate(script) as unknown as TplView & {
      Resources: Record<string, { Properties: Record<string, unknown> }>;
    };
    // El parámetro UserData ya no existe (un String param de CFN tope a 4096; el script son ~5KB).
    expect(emb.Parameters.UserData).toBeUndefined();
    // El Instance lleva el script EMBEBIDO, no un Ref al parámetro.
    expect(emb.Resources.Instance.Properties.UserData).toEqual({ 'Fn::Base64': script });
    // Sin userData, mantiene el parámetro (template genérico).
    expect((buildStackTemplate() as unknown as TplView).Parameters.UserData).toBeDefined();
  });

  it('embebido NO-twobox: LivekitInstance no deja un Ref:UserData COLGANTE al borrar el parámetro [B-HIGH]', () => {
    // CFN valida los Ref aunque el recurso sea condicional (EnableTwobox). Si LivekitInstance conservara
    // Ref:UserData tras borrar el parámetro, TODO deploy (incluso no-twobox) sería rechazado.
    const emb = buildStackTemplate('#!/bin/bash\necho hola') as unknown as TplView & {
      Resources: Record<string, { Properties: Record<string, unknown> }>;
    };
    expect(emb.Resources.LivekitInstance.Properties.UserData).toEqual({ 'Fn::Base64': '' });
    expect(JSON.stringify(emb)).not.toContain('"Ref":"UserData"');
  });

  it('los defaults de InstanceType e ImageId son arch-consistentes (deploy pelado no rompe) [D]', () => {
    // Un deploy sin wizard usa ambos defaults juntos: deben ser la MISMA arch o la instancia no bootea.
    const instType = (t.Parameters.InstanceType as { Default: string }).Default;
    const imageId = (t.Parameters.ImageId as { Default: string }).Default;
    expect(instType).toMatch(/^t4g\./); // Graviton
    expect(imageId).toContain('/arm64/'); // AMI arm64 → coincide con t4g
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

  it('Rule: exige ExistingSubnetId si se pasa ExistingVpcId (protege el deploy standalone) [D]', () => {
    const rule = t.Rules.SubnetRequiredWithExistingVpc;
    expect(rule).toBeDefined();
    // Sólo aplica cuando ExistingVpcId NO está vacío...
    expect(rule.RuleCondition).toEqual({
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'ExistingVpcId' }, ''] }],
    });
    // ...y entonces ASEGURA que ExistingSubnetId tampoco esté vacío (si no, deploy rechazado).
    expect(rule.Assertions[0]?.Assert).toEqual({
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'ExistingSubnetId' }, ''] }],
    });
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

  it('SES: SesParamName parametrizado, EnableSes condicional, SesAccessPolicy lee SSM + descifra vía SSM', () => {
    // Por defecto (deploy pelado) el outbound SES está deshabilitado.
    expect(t.Parameters.SesParamName).toMatchObject({ Default: '' });
    expect(t.Conditions.EnableSes).toEqual({
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'SesParamName' }, ''] }],
    });
    // La policy de lectura SÓLO existe si SES está habilitado y cuelga del MISMO rol del box.
    const pol = t.Resources.SesAccessPolicy;
    expect(pol?.Condition).toBe('EnableSes');
    expect(pol?.Properties.Roles).toEqual([{ Ref: 'InstanceRole' }]);
    const stmts = (
      pol?.Properties.PolicyDocument as {
        Statement: { Action: string[]; Resource: unknown; Condition?: unknown }[];
      }
    ).Statement;
    const ssmStmt = stmts.find((s) => s.Action.includes('ssm:GetParameter'));
    // Scoped al parámetro exacto (no a todo SSM).
    expect(ssmStmt?.Resource).toEqual({
      'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${SesParamName}',
    });
    const kmsStmt = stmts.find((s) => s.Action.includes('kms:Decrypt'));
    // kms:Decrypt acotado por ViaService a SSM (la key sólo se usa a través de SSM).
    expect(kmsStmt?.Condition).toEqual({
      StringEquals: { 'kms:ViaService': { 'Fn::Sub': 'ssm.${AWS::Region}.amazonaws.com' } },
    });
  });

  it('LiveKit externo/twobox: LivekitSecretParamName parametrizado, EnableLivekitSecret condicional, policy lee SSM + descifra vía SSM', () => {
    // Por defecto (sin LiveKit externo/twobox) el parámetro está vacío y la policy no existe.
    expect(t.Parameters.LivekitSecretParamName).toMatchObject({ Default: '' });
    expect(t.Conditions.EnableLivekitSecret).toEqual({
      'Fn::Or': [
        { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'external'] },
        { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'twobox'] },
      ],
    });
    const pol = t.Resources.LivekitSecretAccessPolicy;
    expect(pol?.Condition).toBe('EnableLivekitSecret');
    expect(pol?.Properties.Roles).toEqual([{ Ref: 'InstanceRole' }]);
    const stmts = (
      pol?.Properties.PolicyDocument as {
        Statement: { Action: string[]; Resource: unknown; Condition?: unknown }[];
      }
    ).Statement;
    const ssmStmt = stmts.find((s) => s.Action.includes('ssm:GetParameter'));
    // Scoped al parámetro exacto del secret externo (no a todo SSM).
    expect(ssmStmt?.Resource).toEqual({
      'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${LivekitSecretParamName}',
    });
    const kmsStmt = stmts.find((s) => s.Action.includes('kms:Decrypt'));
    expect(kmsStmt?.Condition).toEqual({
      StringEquals: { 'kms:ViaService': { 'Fn::Sub': 'ssm.${AWS::Region}.amazonaws.com' } },
    });
  });

  it('Rule: MeetMode=enabled (bundled) es EXCLUYENTE con LivekitSecretParamName (externo)', () => {
    const rules = (t as unknown as { Rules: Record<string, unknown> }).Rules;
    const rule = rules.ExternalLivekitExcludesBundledMeet as {
      RuleCondition: unknown;
      Assertions: { Assert: unknown }[];
    };
    // Sólo aplica cuando MeetMode=enabled; ahí exige LivekitSecretParamName vacío.
    expect(rule.RuleCondition).toEqual({ 'Fn::Equals': [{ Ref: 'MeetMode' }, 'enabled'] });
    expect(rule.Assertions[0].Assert).toEqual({
      'Fn::Equals': [{ Ref: 'LivekitSecretParamName' }, ''],
    });
  });

  it('endurecimiento: IMDSv2 requerido, EBS NO se borra al terminar, CreationPolicy presente', () => {
    expect(t.Resources.Instance?.Properties.MetadataOptions).toEqual({
      HttpEndpoint: 'enabled',
      HttpTokens: 'required',
      // HopLimit=2: la API en contenedor necesita 1 hop extra para alcanzar el IMDS (S3 por rol).
      HttpPutResponseHopLimit: 2,
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

  it('la YAML NO usa anchors/aliases (CloudFormation los rechaza — bug hallado en deploy real)', () => {
    const yaml = templateToYaml();
    // El builder reutiliza referencias de objeto; sin aliasDuplicateObjects:false el serializador
    // emite `&anchor`/`*alias` que CFN rechaza ("YAML aliases are not allowed").
    expect(yaml).not.toMatch(/: &\w/); // ninguna línea define un anchor
    expect(yaml).not.toMatch(/: \*\w/); // ninguna usa un alias
  });
});

describe('buildStackTemplate — Bifrost Meet (F3.5)', () => {
  it('MeetMode param default disabled; 4 valores incluyendo external/twobox', () => {
    expect(t.Parameters.MeetMode).toMatchObject({
      Default: 'disabled',
      AllowedValues: ['disabled', 'enabled', 'external', 'twobox'],
    });
    expect(t.Conditions.EnableBundledMeet).toEqual({
      'Fn::Equals': [{ Ref: 'MeetMode' }, 'enabled'],
    });
    expect(t.Conditions.EnableTwobox).toEqual({
      'Fn::Equals': [{ Ref: 'MeetMode' }, 'twobox'],
    });
    expect(t.Conditions.EnableAnyMeet).toEqual({
      'Fn::Or': [
        { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'enabled'] },
        { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'external'] },
        { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'twobox'] },
      ],
    });
    // ManageMeetDns = hay zona Route53 Y Meet bundled/twobox (external gestiona su propio DNS).
    expect(t.Conditions.ManageMeetDns).toEqual({
      'Fn::And': [
        { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'HostedZoneId' }, ''] }] },
        {
          'Fn::Or': [
            { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'enabled'] },
            { 'Fn::Equals': [{ Ref: 'MeetMode' }, 'twobox'] },
          ],
        },
      ],
    });
  });

  it('2º SG (MeetSecurityGroup) condicional EnableBundledMeet con EXACTAMENTE los puertos media (mínimos)', () => {
    const sg = t.Resources.MeetSecurityGroup;
    expect(sg?.Condition).toBe('EnableBundledMeet');
    const ingress = sg?.Properties.SecurityGroupIngress as {
      IpProtocol: string;
      FromPort: number;
      ToPort: number;
      CidrIp: string;
    }[];
    // 4 reglas media: 7881/tcp, 7882/udp, 3478/udp (single) + 30000-40000/udp (rango relay TURN).
    // NUNCA un rango 1-65535 abierto.
    expect(ingress).toHaveLength(4);
    expect(ingress).toEqual(
      expect.arrayContaining([
        { IpProtocol: 'tcp', FromPort: 7881, ToPort: 7881, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'udp', FromPort: 7882, ToPort: 7882, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'udp', FromPort: 3478, ToPort: 3478, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'udp', FromPort: 30000, ToPort: 40000, CidrIp: '0.0.0.0/0' },
      ])
    );
    // Los puertos fijos son single (FromPort===ToPort); el único rango es el relay de TURN (acotado, no 1-65535).
    for (const r of ingress) {
      if (r.FromPort === 30000) expect(r.ToPort).toBe(40000);
      else expect(r.FromPort).toBe(r.ToPort);
    }
    // El export coincide con lo que arma el SG.
    expect(MEET_INGRESS_PORTS.map((p) => p.FromPort)).toEqual([7881, 7882, 3478, 30000]);
  });

  it('el SG BASE queda BYTE-IDÉNTICO con Meet (sin puertos media ni UDP); 7880 jamás expuesto', () => {
    const base = t.Resources.SecurityGroup?.Properties.SecurityGroupIngress as {
      IpProtocol: string;
      FromPort: number;
    }[];
    const basePorts = base.map((x) => x.FromPort);
    // El SG base NO gana ningún puerto de Meet (van en el 2º SG separado).
    for (const p of [7880, 7881, 7882, 3478]) expect(basePorts).not.toContain(p);
    // El SG base no tiene NINGUNA regla UDP (sólo TCP de correo/web/SSH).
    expect(base.every((x) => x.IpProtocol === 'tcp')).toBe(true);
  });

  it('la Instance asocia el 2º SG SOLO con Meet bundled (AWS::NoValue lo elimina con Meet OFF/twobox)', () => {
    expect(t.Resources.Instance?.Properties.SecurityGroupIds).toEqual([
      { Ref: 'SecurityGroup' },
      { 'Fn::If': ['EnableBundledMeet', { Ref: 'MeetSecurityGroup' }, { Ref: 'AWS::NoValue' }] },
    ]);
  });

  it('Route53 suma A meet. y turn.meet. (cond. ManageMeetDns) apuntando a EIP correcta; base intacta', () => {
    const records = t.Resources.DnsRecords?.Properties.RecordSets as Record<string, unknown>[];
    const meetRecords = records.filter((r) => typeof r === 'object' && r !== null && 'Fn::If' in r);
    expect(meetRecords).toHaveLength(2);
    for (const r of meetRecords) {
      const branch = (r as { 'Fn::If': unknown[] })['Fn::If'];
      expect(branch[0]).toBe('ManageMeetDns');
      expect(branch[2]).toEqual({ Ref: 'AWS::NoValue' });
      const record = branch[1] as { ResourceRecords: unknown[] };
      // El target es condicional: media-box EIP en twobox, app-box EIP en bundled.
      expect(record.ResourceRecords[0]).toEqual({
        'Fn::If': ['EnableTwobox', { Ref: 'LivekitElasticIP' }, { Ref: 'ElasticIP' }],
      });
    }
    // Los 5 records base (A mail, A webmail, MX, SPF, DMARC) siguen incondicionales.
    const baseRecords = records.filter((r) => !('Fn::If' in r));
    expect(baseRecords).toHaveLength(5);
  });

  it('Output MeetUrl condicional EnableAnyMeet (bundled/external/twobox)', () => {
    const out = (t.Outputs.MeetUrl ?? {}) as { Condition?: string; Value?: unknown };
    expect(out.Condition).toBe('EnableAnyMeet');
    expect(out.Value).toEqual({ 'Fn::Sub': 'https://meet.${DomainName}' });
  });

  it('Output MediaPublicIp condicional EnableTwobox', () => {
    const out = (t.Outputs.MediaPublicIp ?? {}) as { Condition?: string; Value?: unknown };
    expect(out.Condition).toBe('EnableTwobox');
    expect(out.Value).toEqual({ Ref: 'LivekitElasticIP' });
  });

  it('user-data CON marcador EIP → Fn::Join inyecta GetAtt ElasticIP.PublicIp (NO Fn::Sub, NO IMDS)', () => {
    const script = `#!/bin/bash\nMEET_EXTERNAL_IP="${MEET_EIP_MARKER}"\necho "$DOMAIN"`;
    const emb = buildStackTemplate(script) as unknown as TplView & {
      Resources: Record<string, { Properties: Record<string, unknown> }>;
    };
    const ud = emb.Resources.Instance.Properties.UserData as {
      'Fn::Base64': { 'Fn::Join': unknown[] };
    };
    expect(ud['Fn::Base64']).toHaveProperty('Fn::Join');
    const [sep, parts] = ud['Fn::Base64']['Fn::Join'] as [string, unknown[]];
    expect(sep).toBe('');
    // La EIP se inyecta como GetAtt condicional (no IMDS); el `$DOMAIN` bash queda LITERAL (no Fn::Sub).
    expect(parts[1]).toEqual({
      'Fn::If': ['EnableBundledMeet', { 'Fn::GetAtt': ['ElasticIP', 'PublicIp'] }, ''],
    });
    expect(parts[0] as string).toContain('MEET_EXTERNAL_IP="');
    expect(parts[2] as string).toContain('echo "$DOMAIN"'); // bash var intacta, NO interpolada
    // El marcador crudo ya NO aparece (fue sustituido).
    expect(JSON.stringify(ud)).not.toContain(MEET_EIP_MARKER);
  });

  it('user-data SIN marcador → embedding literal (Fn::Base64 del string, byte-idéntico pre-Meet)', () => {
    const script = '#!/bin/bash\necho hola';
    const emb = buildStackTemplate(script) as unknown as TplView & {
      Resources: Record<string, { Properties: Record<string, unknown> }>;
    };
    expect(emb.Resources.Instance.Properties.UserData).toEqual({ 'Fn::Base64': script });
  });
});

describe('buildStackTemplate — Bifrost Meet TWOBOX', () => {
  const LIVEKIT_EIP_MARKER = '@@LIVEKIT_EXTERNAL_IP@@';

  it('crea recursos dedicados del media-box condicionales a EnableTwobox', () => {
    const tw = buildStackTemplate() as unknown as TplView;
    expect(tw.Resources.LivekitSecurityGroup?.Condition).toBe('EnableTwobox');
    expect(tw.Resources.LivekitElasticIP?.Condition).toBe('EnableTwobox');
    expect(tw.Resources.LivekitInstance?.Condition).toBe('EnableTwobox');
    expect(tw.Resources.LivekitEIPAssociation?.Condition).toBe('EnableTwobox');
  });

  it('el SG del media-box abre 443 + puertos media; NUNCA 7880', () => {
    const tw = buildStackTemplate() as unknown as TplView;
    const ingress = tw.Resources.LivekitSecurityGroup?.Properties.SecurityGroupIngress as {
      FromPort: number;
      IpProtocol: string;
    }[];
    const ports = ingress.map((r) => r.FromPort);
    expect(ports).toContain(22);
    expect(ports).toContain(443);
    for (const p of [7881, 7882, 3478, 30000]) expect(ports).toContain(p);
    expect(ports).not.toContain(7880);
  });

  it('el app-box NO asocia MeetSecurityGroup en twobox', () => {
    const tw = buildStackTemplate() as unknown as TplView;
    expect(tw.Resources.Instance?.Properties.SecurityGroupIds).toEqual([
      { Ref: 'SecurityGroup' },
      { 'Fn::If': ['EnableBundledMeet', { Ref: 'MeetSecurityGroup' }, { Ref: 'AWS::NoValue' }] },
    ]);
  });

  it('el media-box usa un rol IAM PROPIO y MÍNIMO (no el del app-box) + CreationPolicy [B-HIGH]', () => {
    const tw = buildStackTemplate() as unknown as TplView;
    // Rol propio, NO el InstanceProfile del app-box (que tiene S3/SES/KMS).
    expect(tw.Resources.LivekitInstance?.Properties.IamInstanceProfile).toEqual({
      Ref: 'LivekitInstanceProfile',
    });
    expect(
      (tw.Resources.LivekitInstance as unknown as { CreationPolicy?: unknown }).CreationPolicy
    ).toBeTruthy();
    // El rol propio existe, es condicional a twobox, y su policy es mínima: cfn-signal + ssm:GetParameter +
    // kms:Decrypt, SIN S3/SES.
    const role = tw.Resources.LivekitInstanceRole;
    expect(role?.Condition).toBe('EnableTwobox');
    const actions = JSON.stringify((role?.Properties as { Policies: unknown[] }).Policies);
    expect(actions).toContain('cloudformation:SignalResource');
    expect(actions).toContain('ssm:GetParameter');
    expect(actions).toContain('kms:Decrypt');
    expect(actions).not.toContain('s3:');
    expect(actions).not.toContain('ses:');
    expect(tw.Resources.LivekitInstanceProfile?.Condition).toBe('EnableTwobox');
  });

  it('el SG del media-box abre 80 (ACME) y 443, nunca 7880 [B#1]', () => {
    const tw = buildStackTemplate() as unknown as TplView;
    const ingress = (
      tw.Resources.LivekitSecurityGroup?.Properties as {
        SecurityGroupIngress: { FromPort: number }[];
      }
    ).SecurityGroupIngress;
    const ports = ingress.map((r) => r.FromPort);
    expect(ports).toContain(80);
    expect(ports).toContain(443);
    expect(ports).not.toContain(7880);
  });

  it('livekitUserData se embebe en LivekitInstance con Fn::Join de LivekitElasticIP', () => {
    const mediaScript = `#!/bin/bash\nLIVEKIT_EIP="${LIVEKIT_EIP_MARKER}"`;
    const emb = buildStackTemplate(undefined, mediaScript) as unknown as TplView & {
      Resources: Record<string, { Properties: Record<string, unknown> }>;
    };
    const ud = emb.Resources.LivekitInstance.Properties.UserData as {
      'Fn::Base64': { 'Fn::Join': unknown[] };
    };
    expect(ud['Fn::Base64']).toHaveProperty('Fn::Join');
    const [sep, parts] = ud['Fn::Base64']['Fn::Join'] as [string, unknown[]];
    expect(sep).toBe('');
    expect(parts[1]).toEqual({
      'Fn::If': ['EnableTwobox', { 'Fn::GetAtt': ['LivekitElasticIP', 'PublicIp'] }, ''],
    });
  });

  it('con appUserData y livekitUserData se embeben ambos', () => {
    const appScript = '#!/bin/bash\necho app';
    const mediaScript = `#!/bin/bash\nLIVEKIT_EIP="${LIVEKIT_EIP_MARKER}"`;
    const emb = buildStackTemplate(appScript, mediaScript) as unknown as TplView & {
      Resources: Record<string, { Properties: Record<string, unknown> }>;
      Parameters: Record<string, unknown>;
    };
    expect(emb.Parameters.UserData).toBeUndefined();
    expect(emb.Resources.Instance.Properties.UserData).toHaveProperty('Fn::Base64');
    expect(emb.Resources.LivekitInstance.Properties.UserData).toHaveProperty('Fn::Base64');
  });
});
