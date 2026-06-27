<script setup lang="ts">
/* eslint-disable vue/require-default-prop -- name/email/color son opcionales por diseño. */
import { computed } from 'vue';
import { colorFor, initialsFor } from '@/lib/people';

const props = withDefaults(
  defineProps<{
    name?: string;
    email?: string;
    /** Color explícito; si falta se deriva de forma estable del email/nombre. */
    color?: string;
    size?: number;
  }>(),
  { size: 36 }
);

const initials = computed(() => initialsFor(props.name, props.email));
const bg = computed(() => props.color ?? colorFor(props.email ?? props.name ?? '?'));
</script>

<template>
  <div
    class="avatar"
    :style="{
      width: size + 'px',
      height: size + 'px',
      background: bg,
      fontSize: size * 0.4 + 'px',
    }"
  >
    {{ initials }}
  </div>
</template>

<style scoped>
.avatar {
  flex-shrink: 0;
  border-radius: 50%;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  letter-spacing: -0.01em;
  user-select: none;
}
</style>
