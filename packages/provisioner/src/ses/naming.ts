/**
 * Nombres DETERMINÍSTICOS de los recursos SES, derivados del dominio. CRÍTICO que sean estables y
 * compartidos: la policy del InstanceRole (CFN, vía SesParamName) referencia el MISMO parámetro SSM que
 * escribe el orquestador y que lee el user-data del box. Si divergieran, el box no podría leer la
 * credencial. Por eso viven en un solo lugar, puros y testeados.
 */

/** Slug DNS-safe del dominio: minúsculas, no-alfanumérico → '-', sin guiones en los bordes. */
export function domainSlug(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parámetro SSM SecureString con la credencial SMTP (lo que comparten CFN/orquestador/box). */
export function sesParamName(domain: string): string {
  return `/bifrost/${domainSlug(domain)}/ses-smtp`;
}

/** IAM user del envío (1 por dominio). */
export function sesUserName(domain: string): string {
  return `bifrost-ses-${domainSlug(domain)}`;
}

/** Configuration set (métricas de reputación + supresión + default de identidad). */
export function sesConfigSetName(domain: string): string {
  return `bifrost-${domainSlug(domain)}`;
}

/** Nombre de la policy inline de envío (scoped al dominio). */
export const SES_POLICY_NAME = 'bifrost-ses-send';
