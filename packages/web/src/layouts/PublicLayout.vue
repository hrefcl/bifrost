<script setup lang="ts">
import { computed } from 'vue';
import { brand } from '@/config/brand';
import AppLogo from '@/components/AppLogo.vue';

// La página pública usa la MARCA DEL ADMIN (logo/nombre/color) — decisión del PM. `brand` es reactivo
// y se hidrata desde GET /api/branding en el arranque.
const accentStyle = computed(() => ({ '--accent': brand.accent }));
</script>

<template>
  <div class="pub" :style="accentStyle">
    <header class="pub__brand">
      <AppLogo :size="28" />
      <span class="pub__name">{{ brand.name }}</span>
    </header>
    <main class="pub__main">
      <slot />
    </main>
    <footer class="pub__foot">{{ brand.tagline }}</footer>
  </div>
</template>

<style scoped>
.pub {
  min-height: 100vh;
  background: var(--bg, #f5f6f8);
  color: var(--text-1, #1a1a1a);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pub__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px;
  width: 100%;
  max-width: 640px;
}
.pub__name {
  font-weight: 600;
  font-size: 16px;
}
.pub__main {
  width: 100%;
  max-width: 640px;
  padding: 0 18px 32px;
  flex: 1;
}
.pub__foot {
  padding: 18px;
  color: var(--text-3, #8a8a8a);
  font-size: 12px;
}
</style>
