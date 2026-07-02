import { describe, it, expect } from 'vitest';
import { ICONS, type IconName } from '../icons';

/**
 * Regresión del set de iconos (Phosphor duotone). Atrapa lo que el typecheck no ve en runtime:
 * un nombre que quedó sin componente (import roto / rename en Phosphor) o que el set se encoja.
 * Corre en el env `node` de vitest porque `@/lib/icons` es un módulo puro (sin montar el SFC).
 */
describe('icons Phosphor duotone', () => {
  const names = Object.keys(ICONS) as IconName[];

  it('conserva el set completo (ninguno se perdió en la migración)', () => {
    // 59 del set original + 4 de Meet (mic/micOff/videoOff/screenShare) = 63; no debe encogerse.
    expect(names.length).toBe(63);
    expect(new Set(names).size).toBe(names.length); // sin duplicados
  });

  it.each(names)('"%s" resuelve a un componente Phosphor válido', (name) => {
    const comp = ICONS[name];
    // Cada icono Phosphor es un componente Vue (objeto/función con render), nunca undefined:
    // un import roto o un rename en el paquete dejaría esto en undefined y rompería el render.
    expect(comp).toBeTruthy();
    expect(['object', 'function']).toContain(typeof comp);
  });
});
