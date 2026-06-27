import { ref } from 'vue';
import { defineStore } from 'pinia';

/**
 * Estado de UI compartido entre el shell (TopBar) y las vistas.
 * - `searchQuery`: lo escribe la barra de búsqueda del TopBar y lo lee el Inbox para filtrar
 *   la lista en cliente (sin backend de búsqueda todavía).
 * - `sidebarCollapsed`: el botón de menú del TopBar colapsa/expande el sidebar del Inbox.
 */
export const useUiStore = defineStore('ui', () => {
  const searchQuery = ref('');
  const sidebarCollapsed = ref(false);
  // Nonce para pedir foco en la barra de búsqueda desde otro componente (atajo "/").
  const searchFocusNonce = ref(0);

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }
  function focusSearch(): void {
    searchFocusNonce.value++;
  }

  return { searchQuery, sidebarCollapsed, searchFocusNonce, toggleSidebar, focusSearch };
});
