import { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';

export interface VpcInfo {
  id: string;
  isDefault: boolean;
  cidr: string;
}

/** Lista las VPCs de la cuenta/región. Si hay → el CLI pregunta "¿en cuál instalo?"; si no → crea una. */
export async function listVpcs(ec2: EC2Client): Promise<VpcInfo[]> {
  const res = await ec2.send(new DescribeVpcsCommand({}));
  return (res.Vpcs ?? []).flatMap((v) =>
    v.VpcId ? [{ id: v.VpcId, isDefault: v.IsDefault ?? false, cidr: v.CidrBlock ?? '' }] : []
  );
}

export interface SubnetInfo {
  id: string;
  vpcId: string;
  az: string;
  cidr: string;
  /** Subnet pública (asigna IP pública al lanzar) — el mail server necesita una. */
  mapPublicIp: boolean;
}

/** Subnets de una VPC (para elegir una pública donde lanzar el EC2). */
export async function listSubnets(ec2: EC2Client, vpcId: string): Promise<SubnetInfo[]> {
  const res = await ec2.send(
    new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpcId] }] })
  );
  return (res.Subnets ?? []).flatMap((s) =>
    s.SubnetId
      ? [
          {
            id: s.SubnetId,
            vpcId: s.VpcId ?? vpcId,
            az: s.AvailabilityZone ?? '',
            cidr: s.CidrBlock ?? '',
            mapPublicIp: s.MapPublicIpOnLaunch ?? false,
          },
        ]
      : []
  );
}
