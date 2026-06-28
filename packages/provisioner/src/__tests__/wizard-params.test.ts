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
    // ImageId NO se pasa (lo resuelve el template por SSM).
    expect(p.map((x) => x.key)).not.toContain('ImageId');
  });

  it('con S3 (sin nombre) deriva el bucket del dominio', () => {
    const p = assembleStackParams({ ...baseAnswers, useS3: true });
    expect(get(p, 'S3Mode')).toBe('create');
    expect(get(p, 'S3BucketName')).toBe('bifrost-acme-com-data');
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
});
