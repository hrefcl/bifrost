import { describe, it, expect } from 'vitest';
import { estimateMonthlyCost, PRICING } from '../cost.js';

describe('estimateMonthlyCost', () => {
  it('prueba la tesis de la misión: 50 buzones quedan MUY por debajo de $5–10/usuario', () => {
    // Escenario realista all-in-one: t3.medium (~$30), 40GB EBS, 200GB de correo en S3, egress
    // modesto dentro de la franja gratis, con KMS + hosted zone nueva.
    const c = estimateMonthlyCost({
      instanceMonthlyUsd: 30,
      ebsGiB: 40,
      s3GiB: 200,
      dataTransferOutGiB: 50, // < 100 → sin cargo de transferencia
      mailboxes: 50,
      createHostedZone: true,
      useKms: true,
    });
    expect(c.dataTransfer).toBe(0); // egress dentro de la franja gratis
    // Total acotado a unas decenas de dólares para TODA la empresa.
    expect(c.total).toBeLessThan(60);
    // Por buzón: centavos, no dólares — el corazón del producto.
    expect(c.perMailbox).toBeLessThan(2);
    // Suma coherente de las partes.
    expect(c.total).toBeCloseTo(
      c.ec2 + c.ebs + c.s3 + c.dataTransfer + c.publicIpv4 + c.kms + c.route53,
      2
    );
  });

  it('cobra la transferencia saliente sólo por encima de la franja gratis', () => {
    const base = {
      instanceMonthlyUsd: 60,
      ebsGiB: 40,
      s3GiB: 100,
      mailboxes: 100,
      createHostedZone: false,
      useKms: false,
    };
    const within = estimateMonthlyCost({ ...base, dataTransferOutGiB: PRICING.dataOutFreeGiB });
    const over = estimateMonthlyCost({ ...base, dataTransferOutGiB: PRICING.dataOutFreeGiB + 100 });
    expect(within.dataTransfer).toBe(0);
    expect(over.dataTransfer).toBeCloseTo(100 * PRICING.dataOutPerGiB, 2);
  });

  it('omite KMS y Route53 cuando no se usan', () => {
    const c = estimateMonthlyCost({
      instanceMonthlyUsd: 30,
      ebsGiB: 30,
      s3GiB: 0,
      dataTransferOutGiB: 0,
      mailboxes: 10,
      createHostedZone: false,
      useKms: false,
    });
    expect(c.kms).toBe(0);
    expect(c.route53).toBe(0);
    expect(c.s3).toBe(0);
  });

  it('perMailbox cae a total cuando mailboxes = 0 (evita división por cero)', () => {
    const c = estimateMonthlyCost({
      instanceMonthlyUsd: 30,
      ebsGiB: 30,
      s3GiB: 0,
      dataTransferOutGiB: 0,
      mailboxes: 0,
      createHostedZone: false,
      useKms: false,
    });
    expect(c.perMailbox).toBe(c.total);
  });

  it('modo twobox: suma 2º EC2 y 2º EIP al costo', () => {
    const single = estimateMonthlyCost({
      instanceMonthlyUsd: 49,
      ebsGiB: 40,
      s3GiB: 0,
      dataTransferOutGiB: 0,
      mailboxes: 10,
      createHostedZone: false,
      useKms: false,
    });
    const twobox = estimateMonthlyCost({
      instanceMonthlyUsd: 49,
      secondInstanceMonthlyUsd: 58,
      secondPublicIpv4: true,
      ebsGiB: 40,
      s3GiB: 0,
      dataTransferOutGiB: 0,
      mailboxes: 10,
      createHostedZone: false,
      useKms: false,
    });
    expect(twobox.ec2).toBeCloseTo(49 + 58, 2);
    expect(twobox.publicIpv4).toBeCloseTo(PRICING.publicIpv4Monthly * 2, 2);
    expect(twobox.total).toBeCloseTo(twobox.ec2 + twobox.ebs + twobox.publicIpv4, 2);
    expect(twobox.total).toBeGreaterThan(single.total);
  });
});
