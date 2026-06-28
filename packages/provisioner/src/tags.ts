import type { Tag, TagSpecification, ResourceType } from '@aws-sdk/client-ec2';

/**
 * Tags que lleva TODO recurso creado por el provisioner. Permiten (a) identificar lo nuestro para el
 * teardown sin tocar recursos ajenos, y (b) trazabilidad/costos. `bifrost:domain` ata el recurso al
 * despliegue concreto.
 */
export const PROJECT = 'Bifrost';
export const MANAGED_BY = 'bifrost-provision';

export function projectTags(domain: string): Tag[] {
  return [
    { Key: 'Project', Value: PROJECT },
    { Key: 'ManagedBy', Value: MANAGED_BY },
    { Key: 'bifrost:domain', Value: domain },
  ];
}

/** TagSpecification para pasar a los comandos de creación EC2 (key pair, SG, instancia, EIP). */
export function tagSpec(resourceType: ResourceType, domain: string): TagSpecification {
  return { ResourceType: resourceType, Tags: projectTags(domain) };
}
