<script setup lang="ts">
/**
 * Icono de Bifrost — **Phosphor Icons (MIT)** para una sola línea gráfica coherente, apta para OSS. El
 * mapa nombre→componente vive en `@/lib/icons`; acá sólo el wrapper. La API (`name`, `size`) se mantiene
 * 1:1 con el set anterior: ningún consumidor `<AppIcon name="…" />` cambia.
 *
 * Cada icono Phosphor es un componente con root `<svg>`, así que renderizamos con `<component :is>`
 * (sin `v-html` → sin superficie de inyección, sin hack de CSP). El **weight** (trazo: light/regular/
 * duotone/…) NO se hardcodea: lo elige el admin app-wide y viaja en `brand.iconWeight` (white-label —
 * la plataforma tiene el estilo que el admin quiere para sus empleados). Default `light`.
 */
import { computed } from 'vue';
import { ICONS, type IconName } from '@/lib/icons';
import { brand } from '@/config/brand';

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
    :weight="brand.iconWeight"
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
