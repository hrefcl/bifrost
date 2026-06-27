import { ref } from 'vue';
import { defineStore } from 'pinia';

/** Contexto con el que se abre el composer (nuevo, borrador, o respuesta/reenvío). */
export interface ComposerContext {
  draftId?: string;
  replyTo?: string;
  replyAll?: string;
  forward?: string;
}

/**
 * Estado GLOBAL del composer estilo Gmail: una ventana flotante que se superpone a la vista
 * actual (no una ruta). Se puede minimizar. Abrir un composer nuevo remonta la ventana
 * (instanceKey) para resetear el estado interno.
 */
export const useComposerStore = defineStore('composer', () => {
  const open = ref(false);
  const minimized = ref(false);
  const context = ref<ComposerContext>({});
  const instanceKey = ref(0);

  function openComposer(ctx: ComposerContext = {}): void {
    context.value = ctx;
    open.value = true;
    minimized.value = false;
    instanceKey.value++;
  }

  function close(): void {
    open.value = false;
    minimized.value = false;
    context.value = {};
  }

  function toggleMinimize(): void {
    minimized.value = !minimized.value;
  }

  return { open, minimized, context, instanceKey, openComposer, close, toggleMinimize };
});
