<script setup lang="ts">
import { useSettingsStore } from '@/stores/settings';

const settings = useSettingsStore();
settings.applyTheme();
</script>

<template>
  <router-view />
</template>
