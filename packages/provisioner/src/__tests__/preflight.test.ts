import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { Route53Client, ListHostedZonesCommand } from '@aws-sdk/client-route-53';
import { runPreflight } from '../steps/preflight.js';
import { makeClients } from '../aws/clients.js';

const stsMock = mockClient(STSClient);
const ec2Mock = mockClient(EC2Client);
const r53Mock = mockClient(Route53Client);

beforeEach(() => {
  stsMock.reset();
  ec2Mock.reset();
  r53Mock.reset();
  stsMock.on(GetCallerIdentityCommand).resolves({
    Account: '123456789012',
    Arn: 'arn:aws:iam::123456789012:user/op',
    UserId: 'AIDA',
  });
  ec2Mock
    .on(DescribeRegionsCommand)
    .resolves({ Regions: [{ RegionName: 'us-east-1' }, { RegionName: 'eu-west-1' }] });
});

describe('runPreflight', () => {
  it('caso feliz: credenciales + región + zona existente + bucket válido → sin avisos', async () => {
    r53Mock
      .on(ListHostedZonesCommand)
      .resolves({ HostedZones: [{ Id: '/hostedzone/Z123ABC', Name: 'example.com.' }] });

    const r = await runPreflight(makeClients('us-east-1'), {
      region: 'us-east-1',
      domain: 'example.com',
      useS3: true,
      bucketName: 'bifrost-mail-data',
    });

    expect(r.identity.accountId).toBe('123456789012');
    expect(r.region.valid).toBe(true);
    expect(r.domain.valid).toBe(true);
    expect(r.domain.mailHostname).toBe('mail.example.com');
    expect(r.domain.hostedZoneExists).toBe(true);
    expect(r.domain.hostedZoneId).toBe('Z123ABC');
    expect(r.s3.bucketNameValid).toBe(true);
    expect(r.recommendedInstance.memGiB).toBeGreaterThanOrEqual(4);
    expect(r.warnings).toHaveLength(0);
  });

  it('zona inexistente, región no habilitada y bucket inválido → avisos', async () => {
    r53Mock.on(ListHostedZonesCommand).resolves({ HostedZones: [] });

    const r = await runPreflight(makeClients('ap-south-1'), {
      region: 'ap-south-1', // no está en la lista mockeada
      domain: 'example.com',
      useS3: true,
      bucketName: 'BAD_NAME',
    });

    expect(r.region.valid).toBe(false);
    expect(r.domain.hostedZoneExists).toBe(false);
    expect(r.domain.parentZone).toBeNull();
    expect(r.s3.bucketNameValid).toBe(false);
    // 3 avisos: región, hosted zone, bucket.
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('subdominio con zona PADRE existente → no marca exacta, usa la zona padre y avisa', async () => {
    r53Mock
      .on(ListHostedZonesCommand)
      .resolves({ HostedZones: [{ Id: '/hostedzone/ZPARENT', Name: 'example.com.' }] });

    const r = await runPreflight(makeClients('us-east-1'), {
      region: 'us-east-1',
      domain: 'mail.example.com',
      useS3: false,
    });

    expect(r.domain.hostedZoneExists).toBe(false);
    expect(r.domain.parentZone).toEqual({ id: 'ZPARENT', name: 'example.com.' });
    expect(r.warnings.some((w) => w.includes('zona padre'))).toBe(true);
  });

  it('pagina ListHostedZones (IsTruncated) hasta encontrar la zona', async () => {
    r53Mock
      .on(ListHostedZonesCommand, { Marker: undefined })
      .resolves({
        HostedZones: [{ Id: '/hostedzone/ZA', Name: 'otra.com.' }],
        IsTruncated: true,
        NextMarker: 'pg2',
      })
      .on(ListHostedZonesCommand, { Marker: 'pg2' })
      .resolves({ HostedZones: [{ Id: '/hostedzone/ZB', Name: 'example.com.' }] });

    const r = await runPreflight(makeClients('us-east-1'), {
      region: 'us-east-1',
      domain: 'example.com',
      useS3: false,
    });
    expect(r.domain.hostedZoneId).toBe('ZB');
    expect(r.domain.hostedZoneExists).toBe(true);
  });

  it('dominio inválido → aviso y no consulta Route53', async () => {
    const r = await runPreflight(makeClients('us-east-1'), {
      region: 'us-east-1',
      domain: 'localhost',
      useS3: false,
    });
    expect(r.domain.valid).toBe(false);
    expect(r.domain.hostedZoneExists).toBe(false);
    expect(r.s3.enabled).toBe(false);
    expect(r53Mock.commandCalls(ListHostedZonesCommand)).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('FQDN'))).toBe(true);
  });

  it('credenciales inválidas (STS incompleto) → lanza', async () => {
    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({});
    await expect(
      runPreflight(makeClients('us-east-1'), {
        region: 'us-east-1',
        domain: 'example.com',
        useS3: false,
      })
    ).rejects.toThrow(/credenciales/i);
  });
});
