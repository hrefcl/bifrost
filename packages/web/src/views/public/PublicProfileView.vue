<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/lib/http';
import PublicLayout from '@/layouts/PublicLayout.vue';
import type { PublicSchedulingProfile } from '@webmail6/shared';

const route = useRoute();
const router = useRouter();
const profile = ref<PublicSchedulingProfile | null>(null);
const error = ref(false);
const loading = ref(true);

onMounted(async () => {
  const slug = String(route.params.userSlug);
  try {
    const { data } = await api.get<PublicSchedulingProfile>(`/schedule/public/${slug}`);
    profile.value = data;
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});

function book(eventSlug: string) {
  void router.push({
    name: 'public-book',
    params: { userSlug: String(route.params.userSlug), eventSlug },
  });
}
const locLabel: Record<string, string> = {
  video: 'Videollamada',
  in_person: 'Presencial',
  phone: 'Teléfono',
  custom: 'Personalizado',
};
</script>

<template>
  <PublicLayout>
    <div v-if="loading" class="muted">Cargando…</div>
    <div v-else-if="error || !profile" class="notfound">
      <h2>Página no encontrada</h2>
    </div>
    <div v-else class="profile">
      <h1>{{ profile.displayName }}</h1>
      <p class="muted">Agenda una reunión</p>
      <ul class="types">
        <li v-for="ev in profile.eventTypes" :key="ev.slug" class="type" @click="book(ev.slug)">
          <div>
            <strong>{{ ev.title }}</strong>
            <div class="muted">{{ ev.durationMinutes }} min · {{ locLabel[ev.location.type] }}</div>
            <p v-if="ev.description" class="desc">{{ ev.description }}</p>
          </div>
          <span class="arrow">→</span>
        </li>
      </ul>
      <p v-if="profile.eventTypes.length === 0" class="muted">
        Esta persona no tiene reuniones disponibles por ahora.
      </p>
    </div>
  </PublicLayout>
</template>

<style scoped>
.profile h1 {
  margin: 8px 0 0;
}
.muted {
  color: var(--text-3, #8a8a8a);
}
.types {
  list-style: none;
  padding: 0;
  margin-top: 16px;
}
.type {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 12px;
  margin-bottom: 10px;
  cursor: pointer;
}
.type:hover {
  border-color: var(--accent);
}
.desc {
  margin: 6px 0 0;
  font-size: 13px;
}
.arrow {
  color: var(--accent);
  font-size: 20px;
}
.notfound {
  text-align: center;
  padding: 48px 0;
}
</style>
