/**
 * Validación del nombre de bucket S3 según las reglas de AWS (las que importan para crear uno
 * nuevo en cualquier región). Se valida ANTES de intentar `CreateBucket` para dar feedback claro
 * en el preflight en vez de un error opaco del SDK.
 */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface BucketNameCheck {
  valid: boolean;
  reason?: string;
}

export function validateBucketName(name: string): BucketNameCheck {
  if (name.length < 3 || name.length > 63)
    return { valid: false, reason: 'debe tener 3–63 caracteres' };
  if (!/^[a-z0-9.-]+$/.test(name))
    return { valid: false, reason: 'sólo minúsculas, números, puntos y guiones' };
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name))
    return { valid: false, reason: 'debe empezar y terminar con letra o número' };
  if (name.includes('..')) return { valid: false, reason: 'sin puntos consecutivos' };
  if (IPV4.test(name)) return { valid: false, reason: 'no puede tener formato de dirección IP' };
  if (name.startsWith('xn--')) return { valid: false, reason: 'no puede empezar con "xn--"' };
  if (name.startsWith('sthree-')) return { valid: false, reason: 'prefijo "sthree-" reservado' };
  if (name.endsWith('-s3alias') || name.endsWith('--ol-s3'))
    return { valid: false, reason: 'sufijo reservado por AWS' };
  return { valid: true };
}
