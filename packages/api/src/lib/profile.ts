/**
 * ¿El perfil del usuario está INCOMPLETO para una firma corporativa?
 *
 * Señal (el gate del webmail fuerza a completarlo al entrar): `displayName` AUTOGENERADO — vacío o igual
 * al prefijo del email. Así queda al crear la cuenta vía API/provisioning/reconcile sin nombre (auth.ts,
 * reconcile.ts fuerzan `email.split('@')[0]`), y por eso la firma sale como "f.arenas" en vez de
 * "Francisco Arenas".
 *
 * DECISIÓN DE PRODUCTO (A): el gate dispara SÓLO por el nombre autogenerado, NO por falta de teléfono —
 * así no se bloquea a usuarios existentes que ya tienen nombre pero nunca cargaron teléfono. El teléfono
 * (y la foto) se siguen pidiendo en el formulario del gate, pero no son el gatillo. En cuanto el usuario
 * pone un nombre real, la señal se apaga sola (sin flag persistido ni migración).
 */
export function needsProfileCompletion(u: {
  displayName: string;
  primaryEmail: string;
  phone?: string | null;
}): boolean {
  const prefix = u.primaryEmail.split('@')[0]?.trim().toLowerCase() ?? '';
  const name = u.displayName.trim();
  return name.length === 0 || (prefix.length > 0 && name.toLowerCase() === prefix);
}
