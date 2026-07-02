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
    // El set portado desde lucide tenía 59 nombres; no debe encogerse silenciosamente.
    expect(names.length).toBe(59);
    expect(new Set(names).size).toBe(names.length); // sin duplicados
  });

  it.each(names)('renderiza "%s" como SVG duotone de dos capas', (name) => {
    const html = renderIconHtml(name);
    expect(html.startsWith('<svg')).toBe(true);
    // duotone = capa primaria + secundaria; si faltara una, el efecto se pierde.
    expect(html).toContain('fa-primary');
    expect(html).toContain('fa-secondary');
    // CSP: svg-core NO debe emitir un <style> inline (autoAddCss=false).
    expect(html).not.toContain('<style');
  });
});
