import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useComposerStore } from '../composer';

/** Store multi-ventana del composer: varias ventanas de redacción a la vez (estilo Gmail). */
describe('useComposerStore (multi-ventana)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('abre varias ventanas independientes', () => {
    const c = useComposerStore();
    c.openComposer();
    c.openComposer({ replyTo: 'e1' });
    expect(c.windows.length).toBe(2);
    expect(c.windows.map((w) => w.id)).toEqual([...new Set(c.windows.map((w) => w.id))]); // ids únicos
  });

  it('reabrir un borrador YA abierto lo enfoca en vez de duplicar', () => {
    const c = useComposerStore();
    c.openComposer({ draftId: 'd1' });
    c.windows[0].minimized = true;
    c.openComposer({ draftId: 'd1' });
    expect(c.windows.length).toBe(1);
    expect(c.windows[0].minimized).toBe(false); // se des-minimizó (enfocó)
  });

  it('cierra por id sin afectar a las demás', () => {
    const c = useComposerStore();
    c.openComposer({ replyTo: 'a' });
    c.openComposer({ replyTo: 'b' });
    const firstId = c.windows[0].id;
    c.close(firstId);
    expect(c.windows.length).toBe(1);
    expect(c.windows[0].context.replyTo).toBe('b');
  });

  it('minimiza/restaura por id', () => {
    const c = useComposerStore();
    c.openComposer();
    const id = c.windows[0].id;
    c.toggleMinimize(id);
    expect(c.windows[0].minimized).toBe(true);
    c.toggleMinimize(id);
    expect(c.windows[0].minimized).toBe(false);
  });

  it('respeta el tope de ventanas simultáneas (no crece sin límite)', () => {
    const c = useComposerStore();
    for (let i = 0; i < 10; i++) c.openComposer({ replyTo: `e${String(i)}` });
    expect(c.windows.length).toBeLessThanOrEqual(4);
  });
});
