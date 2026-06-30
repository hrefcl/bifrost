<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/lib/http';
import PublicLayout from '@/layouts/PublicLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import type { PublicSchedulingProfile } from '@webmail6/shared';

const route = useRoute();
const router = useRouter();
const profile = ref<PublicSchedulingProfile | null>(null);
const notFound = ref(false);
const serverError = ref(false);
const loading = ref(true);

onMounted(async () => {
  const slug = String(route.params.userSlug);
  try {
    const { data } = await api.get<PublicSchedulingProfile>(`/schedule/public/${slug}`);
    profile.value = data;
  } catch (e) {
    // 404 (no existe / agenda apagada) vs error real de servidor (review D-MED).
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 404) notFound.value = true;
    else serverError.value = true;
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
// Datos del host = sólo texto interpolado con `{{ }}` (Vue escapa). NUNCA v-html aquí (review D-007).
const locLabel: Record<string, string> = {
  video: 'Videollamada',
  in_person: 'Presencial',
  phone: 'Teléfono',
  custom: 'Personalizado',
};
const avatarSrc = computed(() =>
  profile.value?.avatarUrl?.startsWith('data:') ? profile.value.avatarUrl : ''
);
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}
</script>

<template>
  <PublicLayout>
    <div v-if="loading" class="state">
      <div class="spinner" />
    </div>

    <div v-else-if="serverError" class="state notfound" data-testid="pub-error">
      <div class="nf-ico"><AppIcon name="x" :size="28" /></div>
      <h2>Algo salió mal</h2>
      <p class="muted">No pudimos cargar esta página. Intenta de nuevo en un momento.</p>
    </div>

    <div v-else-if="notFound || !profile" class="state notfound" data-testid="pub-notfound">
      <div class="nf-ico"><AppIcon name="calendar" :size="28" /></div>
      <h2>Página no encontrada</h2>
      <p class="muted">El enlace que buscas no existe o ya no está disponible para agendar.</p>
    </div>

    <div v-else class="profile" data-testid="pub-profile">
      <div class="profile__head">
        <div class="avatar">
          <!-- Sólo data: URLs (logo/avatar embebido). NO se cargan imágenes remotas: evita requests
               externos / tracking en la página pública, coherente con "sin assets externos" (review B-LOW). -->
          <img v-if="avatarSrc" :src="avatarSrc" alt="" />
          <span v-else>{{ initials(profile.displayName) }}</span>
        </div>
        <h1>{{ profile.displayName }}</h1>
        <p class="muted">Agenda una reunión conmigo</p>
      </div>

      <ul class="types">
        <li v-for="ev in profile.eventTypes" :key="ev.slug">
          <button
            type="button"
            class="type"
            :data-testid="`pub-eventtype-${ev.slug}`"
            :style="{ '--dot': ev.color || 'var(--accent)' }"
            @click="book(ev.slug)"
          >
            <span class="type__dot" />
            <span class="type__body">
              <strong>{{ ev.title }}</strong>
              <span class="muted block"
                >{{ ev.durationMinutes }} min · {{ locLabel[ev.location.type] }}</span
              >
              <span v-if="ev.description" class="desc block">{{ ev.description }}</span>
            </span>
            <AppIcon name="arrowRight" :size="18" class="arrow" />
          </button>
        </li>
      </ul>

      <p v-if="profile.eventTypes.length === 0" class="muted empty">
        Esta persona no tiene reuniones disponibles por ahora.
      </p>
    </div>
  </PublicLayout>
</template>

<style scoped>
.muted {
  color: var(--text-3);
}
.block {
  display: block;
}
.state {
  text-align: center;
  padding: 56px 0;
}
.spinner {
  width: 34px;
  height: 34px;
  margin: 0 auto;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}
.notfound .nf-ico {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 14px;
  background: var(--surface-dim);
  color: var(--text-3);
}
.notfound h2 {
  margin: 0 0 6px;
}
/* Perfil */
.profile__head {
  text-align: center;
  padding: 8px 0 22px;
}
.avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  margin: 0 auto 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
  overflow: hidden;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.profile__head h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}
.types {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.type {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  text-align: left;
  padding: 16px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  cursor: pointer;
  font: inherit;
  color: inherit;
  box-shadow: var(--shadow-sm);
  transition:
    border-color 0.12s,
    box-shadow 0.12s,
    transform 0.06s;
}
.type:hover,
.type:focus-visible {
  border-color: var(--accent);
  box-shadow: var(--shadow-md);
  outline: none;
}
.type:active {
  transform: translateY(1px);
}
.type__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--dot);
  flex-shrink: 0;
}
.type__body {
  display: block;
  flex: 1;
  min-width: 0;
}
.type__body strong {
  font-size: 15.5px;
}
.desc {
  margin: 6px 0 0;
  font-size: 13px;
}
.arrow {
  color: var(--accent);
  flex-shrink: 0;
}
.empty {
  text-align: center;
  padding: 24px 0;
}
</style>
