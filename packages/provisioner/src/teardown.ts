import {
  type ProvisionState,
  type ResourceRef,
  type ResourceKind,
  RESOURCE_ORDER,
} from './state.js';

/** Orden INVERSO al de creación (destruir dependientes antes que dependencias). */
const REVERSE_ORDER: readonly ResourceKind[] = [...RESOURCE_ORDER].reverse();

/** Caveats por tipo que el preview del teardown debe mostrar (no todo se borra "ya"). */
export const TEARDOWN_NOTES: Record<ResourceKind, string> = {
  'route53-record': 'se eliminan los registros DNS',
  'route53-zone': 'sólo se borra si la creamos nosotros (no zonas preexistentes)',
  'ec2-instance': 'se termina la instancia (datos del EBS efímero se pierden)',
  'elastic-ip': 'se libera (tras terminar la instancia)',
  'security-group': 'se borra (tras terminar la instancia)',
  'key-pair': 'se borra el key pair en AWS (el .pem local no se toca)',
  's3-bucket': 'se VACÍA y se borra — el correo en S3 se pierde; exportá antes si lo necesitás',
  'kms-key': 'se AGENDA su borrado (ventana AWS de 7–30 días); no se borra al instante',
};

/**
 * Devuelve los recursos del estado en ORDEN SEGURO de destrucción. EXCLUYE las hosted zones que NO
 * creamos nosotros (`meta.createdByUs !== 'true'`): borrar una zona preexistente del usuario sería
 * destructivo y fuera de alcance. PURA → testeable sin AWS.
 */
export function teardownOrder(state: ProvisionState): ResourceRef[] {
  const rank = (k: ResourceKind): number => REVERSE_ORDER.indexOf(k);
  return state.resources
    .filter((r) => !(r.kind === 'route53-zone' && r.meta?.createdByUs !== 'true'))
    .slice()
    .sort((a, b) => rank(a.kind) - rank(b.kind));
}
