<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import { brand } from '@/config/brand';

withDefaults(defineProps<{ size?: number; wordmark?: boolean }>(), {
  size: 32,
  wordmark: true,
});
</script>

<template>
  <div class="logo">
    <!-- Logo de empresa (white-label) si el admin lo configuró; si no, el ícono por defecto. -->
    <img
      v-if="brand.logoUrl"
      :src="brand.logoUrl"
      :alt="brand.name"
      class="logo-img"
      :style="{ height: size + 'px', borderRadius: size * 0.18 + 'px' }"
    />
    <div
      v-else
      class="mark"
      :style="{ width: size + 'px', height: size + 'px', borderRadius: size * 0.28 + 'px' }"
    >
      <AppIcon name="mail" :size="size * 0.56" :stroke-width="2.2" />
    </div>
    <span v-if="wordmark" class="wordmark" :style="{ fontSize: size * 0.5 + 'px' }">
      {{ brand.name }}
      <span v-if="!brand.logoUrl" class="version" :style="{ fontSize: size * 0.34 + 'px' }">{{
        brand.version
      }}</span>
    </span>
  </div>
</template>

<style scoped>
.logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.logo-img {
  display: block;
  width: auto;
  max-width: 160px;
  object-fit: contain;
}
.mark {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-300) 100%);
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 35%, transparent);
}
.wordmark {
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-1);
  white-space: nowrap;
}
.version {
  color: var(--accent);
  font-weight: 600;
  vertical-align: middle;
  margin-left: 1px;
}
</style>
