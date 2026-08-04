import { ref } from 'vue';
import { defineStore } from 'pinia';

/** Contexto con el que se abre el composer (nuevo, borrador, o respuesta/reenvío). */
export interface ComposerContext {
  draftId?: string;
  replyTo?: string;
  replyAll?: string;
  forward?: string;
}

/** Una ventana de composición abierta. `id` es estable (key de render + target de close/minimize). */
export interface ComposerWindowState {
  id: number;
  context: ComposerContext;
  minimized: boolean;
}

/** Tope de ventanas simultáneas: más que esto se vuelve inmanejable en pantalla (Gmail ~3). */
const MAX_WINDOWS = 4;

/**
 * Estado GLOBAL del composer estilo Gmail: VARIAS ventanas flotantes que se superponen a la vista
 * actual (no rutas), apiladas abajo-derecha, cada una minimizable de forma independiente. Antes era
 * una sola ventana; ahora es un array para poder redactar 2+ correos a la vez.
 */
export const useComposerStore = defineStore('composer', () => {
  const windows = ref<ComposerWindowState[]>([]);
  let nextId = 0;

  function openComposer(ctx: ComposerContext = {}): void {
    // Reabrir un borrador YA abierto: enfocarlo (des-minimizar) en vez de duplicar la ventana → así
    // no hay dos composers editando el mismo draftId (autosaves pisándose).
    if (ctx.draftId) {
      const existing = windows.value.find((w) => w.context.draftId === ctx.draftId);
      if (existing) {
        existing.minimized = false;
        return;
      }
    }
    // Tope duro: si ya hay MAX, des-minimiza/enfoca la última en vez de abrir otra.
    if (windows.value.length >= MAX_WINDOWS) {
      const last = windows.value[windows.value.length - 1];
      last.minimized = false;
      return;
    }
    windows.value.push({ id: nextId++, context: ctx, minimized: false });
  }

  function close(id: number): void {
    windows.value = windows.value.filter((w) => w.id !== id);
  }

  function toggleMinimize(id: number): void {
    const w = windows.value.find((x) => x.id === id);
    if (w) w.minimized = !w.minimized;
  }

  return { windows, openComposer, close, toggleMinimize };
});
