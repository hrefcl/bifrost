import { describe, it, expect } from 'vitest';
import { ICONS, renderIconHtml, type IconName } from '../icons';

/**
 * Regresión de la migración a FontAwesome Pro duotone (AppIcon). Atrapa lo que el typecheck NO ve:
 * un icono que existe pero renderiza vacío/single-layer, o que svg-core vuelva a inyectar CSS
 * (rompería la CSP). Corre en el env `node` de vitest porque `@/lib/icons` es un módulo puro.
 */
describe('icons FA duotone', () => {
  const names = Object.keys(ICONS) as IconName[];

  it('conserva el set completo (ninguno se perdió en la migración)', () => {
    // 59 del set base (lucide→FA) + 4 de los controles de Meet (mic/micOff/videoOff/screenShare).
    // No debe encogerse silenciosamente; si agregás iconos, subí este número a conciencia.
    expect(names.length).toBe(63);
    expect(new Set(names).size).toBe(names.length); // sin duplicados
  });

  it.each(names)('renderiza "%s" con forma y estructura duotone', (name) => {
    const html = renderIconHtml(name);
    expect(html.startsWith('<svg')).toBe(true);
    // Estructura duotone: svg-core emite ambas capas. OJO: en glifos simples (plus, x, chevron,
    // check, star…) FA deja UNA capa vacía a propósito (no hay descomposición two-tone que tenga
    // sentido) → renderizan como relleno sólido. Eso es diseño de FA, no un defecto.
    expect(html).toContain('fa-primary');
    expect(html).toContain('fa-secondary');
    // Lo que SÍ debe cumplirse siempre: el icono no está en blanco → al menos una capa con path real.
    const dLens = [...html.matchAll(/\bd="([^"]*)"/g)].map((m) => m[1].length);
    expect(dLens.some((n) => n > 0)).toBe(true);
    // CSP: svg-core NO debe emitir un <style> inline (autoAddCss=false).
    expect(html).not.toContain('<style');
  });
});
