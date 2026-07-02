<script setup lang="ts">
/**
 * Icono de Bifrost — FontAwesome Pro **duotone** (una sola línea gráfica coherente). El mapa de
 * iconos y el render viven en `@/lib/icons` (módulo puro, testeable); acá sólo el wrapper Vue.
 * La API (`name`, `size`) se mantiene 1:1 con el set anterior (lucide): ningún consumidor cambia.
 *
 * `v-html` es seguro: el markup lo produce `renderIconHtml()` sobre definiciones estáticas del
 * bundle (sin dato de usuario). CSP: ver nota sobre `autoAddCss` en `@/lib/icons`.
 */
import { computed } from 'vue';
import { renderIconHtml, type IconName } from '@/lib/icons';

// Re-export para los consumidores que hacían `import AppIcon, { type IconName } from '…/AppIcon.vue'`.
export type { IconName };

const props = withDefaults(
  defineProps<{
    // Unión CERRADA de nombres válidos: impide pasar datos dinámicos/usuario al render.
    name: IconName;
    size?: number;
    // Compat con el set anterior (lucide, trazo). Duotone es relleno → estos props son no-ops;
    // se conservan para no romper llamadas existentes que los pasaban.
    strokeWidth?: number;
    fill?: string;
  }>(),
  { size: 20, strokeWidth: 2, fill: 'none' }
);

const html = computed(() => renderIconHtml(props.name));
</script>

<template>
  <!-- v-html: markup producido por `renderIconHtml()` sobre defs estáticas del bundle → seguro. -->
  <!-- eslint-disable vue/no-v-html -->
  <span class="app-icon" :style="{ fontSize: `${size}px` }" aria-hidden="true" v-html="html" />
  <!-- eslint-enable vue/no-v-html -->
</template>

<style scoped>
.app-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  flex-shrink: 0;
}
/* CSS mínimo de FA (no importamos su hoja por CSP). El SVG escala con el font-size del wrapper;
   height:1em + width:auto preserva el aspect-ratio del viewBox de cada icono. */
.app-icon :deep(svg) {
  height: 1em;
  width: auto;
  display: block;
  fill: currentColor;
  overflow: visible;
}
/* Efecto duotone: capa secundaria atenuada, primaria plena. Ambas heredan currentColor → el icono
   se adapta a su contexto (sidebar, botón sobre acento, badges, etc.). */
.app-icon :deep(.fa-secondary) {
  opacity: 0.4;
}
.app-icon :deep(.fa-primary) {
  opacity: 1;
}
</style>
