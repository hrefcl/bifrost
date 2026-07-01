/**
 * Estimador de costo mensual del despliegue — la métrica que PRUEBA la tesis de la misión
 * ("empresa de ~50 personas con correo prácticamente ilimitado por ~$50/mes" vs $5–10/usuario
 * comerciales). Ver `docs/cli-provisioning-aws.md` §0.
 *
 * Precios APROXIMADOS on-demand us-east-1 (USD). Orientativos, NO autoritativos: el precio exacto
 * por región lo dará el Pricing API en una fase futura (deuda registrada). Función PURA → testeable.
 */
export const PRICING = {
  /** EBS gp3 por GiB-mes. */
  ebsGp3PerGiB: 0.08,
  /** S3 Standard por GiB-mes. */
  s3StandardPerGiB: 0.023,
  /** Transferencia saliente a internet por GiB (tras la franja gratis). */
  dataOutPerGiB: 0.09,
  /** Franja gratis de salida por mes. */
  dataOutFreeGiB: 100,
  /** IPv4 pública: ~$0.005/h × 730h (AWS cobra toda IPv4 pública desde 2024, incluso asociada). */
  publicIpv4Monthly: 3.6,
  /** KMS CMK por mes (sin contar requests, despreciables para este uso). */
  kmsCmkMonthly: 1.0,
  /** Hosted zone Route53 por mes. */
  route53ZoneMonthly: 0.5,
} as const;

export interface CostInput {
  /** Costo mensual del EC2 elegido (del catálogo). */
  instanceMonthlyUsd: number;
  ebsGiB: number;
  /** Correo en bulk (cuerpos+adjuntos) en S3 — la palanca de costo de la misión. */
  s3GiB: number;
  /** Transferencia saliente estimada por mes. */
  dataTransferOutGiB: number;
  mailboxes: number;
  createHostedZone: boolean;
  useKms: boolean;
  /** Costo mensual de un 2º EC2 (modo twobox: media-box dedicado). */
  secondInstanceMonthlyUsd?: number;
  /** Si el 2º EC2 tiene EIP pública (modo twobox). */
  secondPublicIpv4?: boolean;
}

export interface CostBreakdown {
  ec2: number;
  ebs: number;
  s3: number;
  dataTransfer: number;
  publicIpv4: number;
  kms: number;
  route53: number;
  total: number;
  /** Costo mensual por buzón (la comparación directa contra los $5–10 comerciales). */
  perMailbox: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function estimateMonthlyCost(input: CostInput): CostBreakdown {
  const ec2 = input.instanceMonthlyUsd + (input.secondInstanceMonthlyUsd ?? 0);
  const ebs = input.ebsGiB * PRICING.ebsGp3PerGiB;
  const s3 = input.s3GiB * PRICING.s3StandardPerGiB;
  const billableEgress = Math.max(0, input.dataTransferOutGiB - PRICING.dataOutFreeGiB);
  const dataTransfer = billableEgress * PRICING.dataOutPerGiB;
  const publicIpv4 = PRICING.publicIpv4Monthly * (input.secondPublicIpv4 ? 2 : 1);
  const kms = input.useKms ? PRICING.kmsCmkMonthly : 0;
  const route53 = input.createHostedZone ? PRICING.route53ZoneMonthly : 0;
  const total = ec2 + ebs + s3 + dataTransfer + publicIpv4 + kms + route53;
  const perMailbox = input.mailboxes > 0 ? total / input.mailboxes : total;
  return {
    ec2: round2(ec2),
    ebs: round2(ebs),
    s3: round2(s3),
    dataTransfer: round2(dataTransfer),
    publicIpv4: round2(publicIpv4),
    kms: round2(kms),
    route53: round2(route53),
    total: round2(total),
    perMailbox: round2(perMailbox),
  };
}
