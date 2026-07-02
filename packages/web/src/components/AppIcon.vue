<script setup lang="ts">
/**
 * Icono de Bifrost — **Phosphor Icons (weight duotone)** para una sola línea gráfica coherente
 * (licencia MIT, apta para OSS). El mapa nombre→componente vive en `@/lib/icons`; acá sólo el wrapper.
 * La API (`name`, `size`) se mantiene 1:1 con el set anterior: ningún consumidor `<AppIcon name="…" />`
 * cambia.
 *
 * Cada icono Phosphor es un componente con root `<svg>`, así que renderizamos con `<component :is>`
 * (sin `v-html` → sin superficie de inyección, sin hack de CSP). `weight="duotone"` da el efecto de
 * dos tonos; el color secundario hereda `currentColor` a opacidad reducida → se adapta al contexto.
 */
import { computed } from 'vue';
import { ICONS, type IconName } from '@/lib/icons';

// Re-export para los consumidores que hacían `import AppIcon, { type IconName } from '…/AppIcon.vue'`.
export type { IconName };

const props = withDefaults(
  defineProps<{
    // Unión CERRADA de nombres válidos: impide pasar datos dinámicos/usuario.
    name: IconName;
    size?: number;
    // Compat con el set anterior (lucide/FA). Phosphor maneja su propio trazo/relleno → no-ops;
    // se conservan para no romper llamadas existentes que los pasaban.
    strokeWidth?: number;
    fill?: string;
  }>(),
  { size: 20, strokeWidth: 2, fill: 'none' }
);

const iconComponent = computed(() => ICONS[props.name]);
</script>

<template>
  <component
    :is="iconComponent"
    :size="size"
    weight="duotone"
    class="app-icon"
    aria-hidden="true"
  />
</template>

<style scoped>
.app-icon {
  display: block;
  flex-shrink: 0;
}
</style>
