/**
 * Catálogo ESTÁTICO y CERRADO de permisos del admin (F8 RBAC). No es editable en runtime.
 * El modelo es ADITIVO: `User.role==='admin'` es superusuario (todos los permisos, siempre), y un
 * usuario normal puede tener un rol custom que le otorga un SUBconjunto de estos permisos.
 *
 * Default-deny (review B-CRITICAL): una ruta `/admin/*` sin `config.permission` es admin-only; un
 * role-holder sólo accede a las rutas cuyo `permission` posee. Una ruta olvidada queda admin-only
 * (fail-closed), nunca abierta.
 */
export interface PermissionDef {
  key: string;
  category: string;
  label: string;
}

export const PERMISSIONS = [
  { key: 'accounts.manage', category: 'Cuentas', label: 'Gestionar cuentas' },
  { key: 'groups.manage', category: 'Cuentas', label: 'Gestionar grupos' },
  { key: 'roles.manage', category: 'Seguridad', label: 'Gestionar roles y permisos' },
  { key: 'branding.manage', category: 'Configuración', label: 'Gestionar marca' },
  { key: 'storage.manage', category: 'Configuración', label: 'Gestionar almacenamiento' },
  {
    key: 'calendar.manage',
    category: 'Configuración',
    label: 'Gestionar preferencias de calendario',
  },
  { key: 'scheduling.manage', category: 'Agenda', label: 'Gestionar la Agenda' },
  { key: 'audit.view', category: 'Seguridad', label: 'Ver auditoría' },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

const KEY_SET: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

/** Todas las claves del catálogo (lo que tiene un admin superusuario). */
export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

/** ¿`key` es un permiso válido del catálogo? (claves stale/desconocidas se ignoran — review C/D-028). */
export function isValidPermission(key: string): key is PermissionKey {
  return KEY_SET.has(key);
}

/** Filtra una lista a permisos válidos del catálogo (ignora desconocidos), deduplicado. */
export function sanitizePermissions(keys: readonly string[]): PermissionKey[] {
  return [...new Set(keys.filter(isValidPermission))] as PermissionKey[];
}
