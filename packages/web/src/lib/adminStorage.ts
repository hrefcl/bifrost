/**
 * Lógica pura de la config de Almacenamiento del admin — extraída del SFC AdminView para que sea
 * unit-testeable (el web no tiene infra de tests de componente; ver TD-WEB-COMPONENT-TESTS).
 *
 * Motivo (incidente real, fix #34): en S3 con `useInstanceRole=true` (TODO box turnkey/CLI) la config
 * NO trae `accessKeyId`. Sin guardar ese undefined, `s3Incomplete` hacía `undefined.trim()` → crash de
 * toda la sección Almacenamiento. Estas funciones fijan el guard y su cobertura.
 */

/** Forma S3 tal como la devuelve el API (vista pública: sin secret, accessKeyId opcional). */
export interface RawS3Config {
  endpoint?: string | null;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  useInstanceRole?: boolean;
  secretConfigured?: boolean;
}

/** Estado del formulario S3 en la UI (siempre strings — nunca undefined, para evitar `.trim()` sobre undefined). */
export interface S3FormState {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  useInstanceRole: boolean;
}

/**
 * Normaliza la config S3 del API al estado del formulario, GUARDANDO cada campo contra undefined.
 * `accessKeyId ?? ''` es el guard que arregla el crash (con rol de instancia no viene accessKeyId).
 */
export function s3FormFromConfig(raw: RawS3Config | undefined): S3FormState {
  return {
    endpoint: raw?.endpoint ?? '',
    bucket: raw?.bucket ?? '',
    region: raw?.region ?? '',
    accessKeyId: raw?.accessKeyId ?? '',
    useInstanceRole: raw?.useInstanceRole ?? false,
  };
}

/**
 * ¿Falta completar el form S3 para poder guardar? Con `useInstanceRole` NO se exigen claves estáticas
 * (las provee el rol de EC2; además el S3-instance-role no se edita por UI). Sin ese short-circuit, y sin
 * los guards de arriba, se evaluaba `.trim()` sobre un accessKeyId undefined → crash.
 */
export function s3Incomplete(
  form: Pick<S3FormState, 'useInstanceRole' | 'bucket' | 'region' | 'accessKeyId'> & {
    secretAccessKey: string;
  }
): boolean {
  if (form.useInstanceRole) return false;
  return (
    !form.bucket.trim() || !form.region.trim() || !form.accessKeyId.trim() || !form.secretAccessKey
  );
}
