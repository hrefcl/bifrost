import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from '../plan.js';
import { teardownOrder } from '../teardown.js';
import { emptyState, addResource, RESOURCE_ORDER } from '../state.js';

const base: PlanInput = {
  region: 'us-east-1',
  domain: 'example.com',
  mailHostname: 'mail.example.com',
  useS3: true,
  bucketName: 'bifrost-data',
  instanceType: 't3.large',
  instanceMonthlyUsd: 60,
  ebsGiB: 40,
  bulkGiB: 200,
  mailboxes: 50,
  createHostedZone: true,
  encryptEbs: true,
};

describe('buildPlan', () => {
  it('con S3 + zona nueva: incluye kms, s3, zona y respeta el orden canónico de creación', () => {
    const plan = buildPlan(base);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain('kms-key');
    expect(kinds).toContain('s3-bucket');
    expect(kinds).toContain('route53-zone');
    // El orden de los pasos sigue el orden canónico de RESOURCE_ORDER.
    const ranks = kinds.map((k) => RESOURCE_ORDER.indexOf(k));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // Cost integrado y barato por buzón.
    expect(plan.cost.perMailbox).toBeLessThan(2);
  });

  it('sin S3 y sin cifrar EBS: no hay kms ni s3; el bulk no va a S3', () => {
    const plan = buildPlan({ ...base, useS3: false, encryptEbs: false });
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).not.toContain('kms-key');
    expect(kinds).not.toContain('s3-bucket');
    expect(plan.cost.s3).toBe(0);
  });

  it('cifrar EBS sin S3 igual exige KMS', () => {
    const plan = buildPlan({ ...base, useS3: false, encryptEbs: true });
    expect(plan.steps.map((s) => s.kind)).toContain('kms-key');
    expect(plan.steps.map((s) => s.kind)).not.toContain('s3-bucket');
  });

  it('zona existente: no incluye paso de crear zona', () => {
    const plan = buildPlan({ ...base, createHostedZone: false });
    expect(plan.steps.map((s) => s.kind)).not.toContain('route53-zone');
    expect(plan.cost.route53).toBe(0);
  });
});

describe('teardownOrder', () => {
  it('destruye en orden INVERSO al de creación', () => {
    let s = emptyState('us-east-1', 'example.com');
    s = addResource(s, { kind: 'kms-key', id: 'k' });
    s = addResource(s, { kind: 's3-bucket', id: 'b' });
    s = addResource(s, { kind: 'ec2-instance', id: 'i' });
    s = addResource(s, { kind: 'route53-record', id: 'A mail' });
    const order = teardownOrder(s).map((r) => r.kind);
    // records primero, kms al final.
    expect(order[0]).toBe('route53-record');
    expect(order[order.length - 1]).toBe('kms-key');
    expect(order.indexOf('ec2-instance')).toBeLessThan(order.indexOf('s3-bucket'));
  });

  it('NO borra una hosted zone preexistente (sólo las que creamos nosotros)', () => {
    let s = emptyState('us-east-1', 'example.com');
    s = addResource(s, { kind: 'route53-zone', id: 'Zpre' }); // sin createdByUs
    s = addResource(s, { kind: 'route53-zone', id: 'Zours', meta: { createdByUs: 'true' } });
    const ids = teardownOrder(s).map((r) => r.id);
    expect(ids).toContain('Zours');
    expect(ids).not.toContain('Zpre');
  });
});
