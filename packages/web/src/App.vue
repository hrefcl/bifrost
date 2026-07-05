<script setup lang="ts">
import { useSettingsStore } from '@/stores/settings';
import PwaUi from '@/components/PwaUi.vue';

const settings = useSettingsStore();
settings.applyTheme();
settings.applyAccent();
</script>

<template>
  <router-view />
  <!-- Capa PWA (offline / actualizar / instalar), global y por encima de las vistas. -->
  <PwaUi />
</template>
