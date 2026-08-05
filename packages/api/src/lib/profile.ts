/**
 * ¿El perfil del usuario está INCOMPLETO para una firma corporativa?
 *
 * Señales (el gate del webmail fuerza a completarlo al entrar):
 *  - `displayName` AUTOGENERADO: vacío o igual al prefijo del email. Así queda al crear la cuenta vía
 *    API/provisioning/reconcile sin nombre (auth.ts, reconcile.ts fuerzan `email.split('@')[0]`), y por
 *    eso la firma sale como "f.arenas" en vez de "Francisco Arenas".
 *  - Sin TELÉFONO.
 *
 * La FOTO es opcional → no cuenta. En cuanto el usuario pone un nombre real + teléfono, la señal se
 * apaga sola (no hace falta flag persistido ni migración: usuarios con perfil ya bueno nunca lo ven).
 */
export function needsProfileCompletion(u: {
  displayName: string;
  primaryEmail: string;
  phone?: string | null;
}): boolean {
  const prefix = u.primaryEmail.split('@')[0]?.trim().toLowerCase() ?? '';
  const name = u.displayName.trim();
  const nameIsAuto = name.length === 0 || (prefix.length > 0 && name.toLowerCase() === prefix);
  const noPhone = !u.phone || u.phone.trim().length === 0;
  return nameIsAuto || noPhone;
}
