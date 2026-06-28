import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';

/** Lista las regiones habilitadas en la cuenta (read-only). Ordenadas alfabéticamente. */
export async function listRegions(ec2: EC2Client): Promise<string[]> {
  const res = await ec2.send(new DescribeRegionsCommand({}));
  return (res.Regions ?? [])
    .map((r) => r.RegionName)
    .filter((n): n is string => Boolean(n))
    .sort((a, b) => a.localeCompare(b));
}
