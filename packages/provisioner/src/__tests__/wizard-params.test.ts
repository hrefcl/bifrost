import { describe, it, expect } from 'vitest';
import { assembleStackParams, deriveBucketName } from '../wizard/params.js';

const get = (params: { key: string; value: string }[], key: string) =>
  params.find((p) => p.key === key)?.value;

describe('deriveBucketName', () => {
  it('normaliza el dominio a un nombre de bucket válido', () => {
    expect(deriveBucketName('Empresa.COM')).toBe('bifrost-empresa-com-data');
    expect(deriveBucketName('mi_empresa.io')).toBe('bifrost-mi-empresa-io-data');
  });
});

describe('assembleStackParams', () => {
  const baseAnswers = {
    domain: 'acme.com',
    instanceType: 't3.large',
    keyName: 'bifrost',
    userData: '#!/bin/bash',
    useS3: false,
  };

  it('modo offline (sin VPC, sin S3): defaults seguros', () => {
    const p = assembleStackParams(baseAnswers);
    expect(get(p, 'ExistingVpcId')).toBe(''); // crea VPC
    expect(get(p, 'S3Mode')).toBe('none'); // storage local
    expect(get(p, 'S3BucketName')).toBe('');
    expect(get(p, 'SshCidr')).toBe('0.0.0.0/0');
  });

  it('pasa el ImageId (SSM) que matchea la arch de la instancia (Graviton vs x86)', () => {
    // t3 (x86) → AMI amd64
    const x86 = assembleStackParams({ ...baseAnswers, instanceType: 't3.large' });
    expect(get(x86, 'ImageId')).toContain('/amd64/');
    // t4g (Graviton) → AMI arm64 (el default del wizard)
    const arm = assembleStackParams({ ...baseAnswers, instanceType: 't4g.large' });
    expect(get(arm, 'ImageId')).toContain('/arm64/');
    expect(get(arm, 'ImageId')).toContain('ubuntu/server/22.04');
  });

  it('con S3 (sin nombre) deriva el bucket del dominio', () => {
    const p = assembleStackParams({ ...baseAnswers, useS3: true });
    expect(get(p, 'S3Mode')).toBe('create');
    expect(get(p, 'S3BucketName')).toBe('bifrost-acme-com-data');
  });

  it('sin hostedZoneId → HostedZoneId vacío (no gestiona DNS); con id lo pasa', () => {
    expect(get(assembleStackParams(baseAnswers), 'HostedZoneId')).toBe('');
    expect(get(assembleStackParams({ ...baseAnswers, hostedZoneId: 'Z123' }), 'HostedZoneId')).toBe(
      'Z123'
    );
  });

  it('sin enableSes → SesParamName vacío (outbound off); con enableSes → el nombre derivado del dominio', () => {
    expect(get(assembleStackParams(baseAnswers), 'SesParamName')).toBe('');
    expect(get(assembleStackParams({ ...baseAnswers, enableSes: true }), 'SesParamName')).toBe(
      '/bifrost/acme-com/ses-smtp'
    );
  });

  it('con VPC existente elegida la pasa', () => {
    const p = assembleStackParams({
      ...baseAnswers,
      existingVpcId: 'vpc-1',
      existingSubnetId: 'subnet-1',
      sshCidr: '203.0.113.5/32',
    });
    expect(get(p, 'ExistingVpcId')).toBe('vpc-1');
    expect(get(p, 'ExistingSubnetId')).toBe('subnet-1');
    expect(get(p, 'SshCidr')).toBe('203.0.113.5/32');
  });

  it('NUNCA incluye UserData como parámetro → el deploy DEBE embeber userData (buildStackTemplate(userData)) [B/D-HIGH F3.5]', () => {
    // El userData se EMBEBE en el template (Fn::Base64/Fn::Join), no va como param (tope 4096 de CFN).
    // Si el deploy construyera el template SIN userData, el param requerido `UserData` quedaría sin
    // valor → CFN rechaza. Este invariante obliga a usar buildStackTemplate(userData) en el deploy.
    const keys = assembleStackParams({ ...baseAnswers, enableMeet: true }).map((p) => p.key);
    expect(keys).not.toContain('UserData');
  });

  it('MeetMode: default disabled (Meet OFF); enableMeet → enabled', () => {
    expect(get(assembleStackParams(baseAnswers), 'MeetMode')).toBe('disabled');
    expect(get(assembleStackParams({ ...baseAnswers, enableMeet: false }), 'MeetMode')).toBe(
      'disabled'
    );
    expect(get(assembleStackParams({ ...baseAnswers, enableMeet: true }), 'MeetMode')).toBe(
      'enabled'
    );
  });

  it('LivekitSecretParamName: vacío por defecto; con meetExternal → el nombre del param SSM', () => {
    expect(get(assembleStackParams(baseAnswers), 'LivekitSecretParamName')).toBe('');
    const p = assembleStackParams({
      ...baseAnswers,
      meetExternal: { secretParamName: '/bifrost/acme-com/livekit-secret' },
    });
    expect(get(p, 'LivekitSecretParamName')).toBe('/bifrost/acme-com/livekit-secret');
  });

  it('Meet EXTERNO NO monta media local → MeetMode queda disabled (sin 2º SG/DNS/EIP)', () => {
    const p = assembleStackParams({
      ...baseAnswers,
      meetExternal: { secretParamName: '/bifrost/acme-com/livekit-secret' },
    });
    expect(get(p, 'MeetMode')).toBe('disabled');
    expect(get(p, 'LivekitSecretParamName')).not.toBe('');
  });
});
