<script setup lang="ts">
/**
 * Home autenticado de Bifrost Meet: el punto de entrada que faltaba en el webmail. Permite CREAR una
 * reunión instantánea (POST /api/meet/rooms → sala personal → link para compartir + entrar) y UNIRSE a una
 * con un link o código. La sala de la llamada en sí vive en `/meet/:slug` (MeetJoinView, guestOk). El gate
 * de disponibilidad usa la misma config pública que la agenda (useMeetConfig → /config/public.meetEnabled).
 */
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '@/lib/http';
import { meetSlugFromInput } from '@/lib/meet';
import { useMeetConfig } from '@/composables/useMeetConfig';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';

interface CreatedRoom {
  slug: string;
  name: string;
  meetUrl: string;
}

const router = useRouter();
const { t } = useI18n();
const { load: loadMeetConfig } = useMeetConfig();

const ready = ref(false);
const meetAvailable = ref(false);
const creating = ref(false);
const created = ref<CreatedRoom | null>(null);
const errorMsg = ref('');
const joinInput = ref('');
const copied = ref(false);

onMounted(async () => {
  try {
    const c = await loadMeetConfig();
    meetAvailable.value = c.meetEnabled;
  } catch {
    meetAvailable.value = false;
  } finally {
    ready.value = true;
  }
});

async function newMeeting() {
  if (creating.value) return;
  creating.value = true;
  errorMsg.value = '';
  try {
    // El backend responde 200 `{disabled:true}` si Meet se apagó (TOCTOU: la config pública pudo cargar
    // antes de que el admin lo deshabilite). Manejar la unión, no asumir que todo 200 trae `room`. [B/D-MED]
    const { data } = await api.post<{ room?: CreatedRoom; disabled?: boolean }>('/meet/rooms', {
      name: t('meet.instantName'),
    });
    if (data.disabled) {
      meetAvailable.value = false; // Meet quedó apagado → la vista muestra el aviso de deshabilitado
      return;
    }
    if (!data.room) {
      errorMsg.value = t('meet.createError');
      return;
    }
    created.value = data.room;
  } catch {
    errorMsg.value = t('meet.createError');
  } finally {
    creating.value = false;
  }
}

function enterCreated() {
  if (created.value)
    void router.push({ name: 'public-meet-room', params: { slug: created.value.slug } });
}

function joinExisting() {
  errorMsg.value = ''; // limpiar un error previo (p.ej. de un intento fallido) [D-LOW]
  const slug = meetSlugFromInput(joinInput.value);
  if (!slug) {
    errorMsg.value = t('meet.joinInvalid');
    return;
  }
  void router.push({ name: 'public-meet-room', params: { slug } });
}

// Timer del feedback "Copiado": se limpia entre clicks y al desmontar (sin timers huérfanos). [B/D-LOW]
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copyLink() {
  if (!created.value) return;
  try {
    await navigator.clipboard.writeText(created.value.meetUrl);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1800);
  } catch {
    /* clipboard bloqueado: el usuario puede copiar a mano del input */
  }
}
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <AppLayout>
    <div class="meet-home">
      <div class="wrap">
        <p v-if="!ready" class="loading">…</p>

        <div v-else-if="!meetAvailable" class="notice">
          <AppIcon name="video" :size="20" />
          <span>{{ t('meet.disabled') }}</span>
        </div>

        <template v-else>
          <!-- HERO: acción principal (crear reunión) o resultado (link listo) -->
          <section class="hero">
            <div class="hero-icon"><AppIcon name="video" :size="34" /></div>
            <h1>{{ t('meet.title') }}</h1>
            <p class="hero-sub">{{ t('meet.subtitle') }}</p>

            <div v-if="!created" class="hero-body">
              <button class="btn btn-primary btn-lg" :disabled="creating" @click="newMeeting">
                <AppIcon name="plus" :size="20" />
                <span>{{ creating ? t('meet.creating') : t('meet.newBtn') }}</span>
              </button>
              <p class="hero-hint">{{ t('meet.newDesc') }}</p>
            </div>

            <div v-else class="hero-body ready">
              <div class="ready-badge">
                <span class="dot" />
                {{ t('meet.readyTitle') }}
              </div>
              <div class="link-row">
                <AppIcon name="link" :size="16" class="link-ico" />
                <input
                  class="link-input"
                  :value="created.meetUrl"
                  readonly
                  @focus="($event.target as HTMLInputElement).select()"
                />
                <button class="btn btn-ghost sm" :title="t('meet.copy')" @click="copyLink">
                  <AppIcon name="copy" :size="16" />
                  <span>{{ copied ? t('meet.copied') : t('meet.copy') }}</span>
                </button>
              </div>
              <div class="actions">
                <button class="btn btn-primary btn-lg" @click="enterCreated">
                  <AppIcon name="video" :size="18" />
                  <span>{{ t('meet.enter') }}</span>
                </button>
                <button class="btn btn-ghost" @click="created = null">
                  {{ t('meet.newAnother') }}
                </button>
              </div>
            </div>
          </section>

          <!-- Unirse a una reunión existente -->
          <section class="join-card">
            <div class="join-text">
              <h2>{{ t('meet.joinTitle') }}</h2>
              <p class="muted">{{ t('meet.joinDesc') }}</p>
            </div>
            <div class="join-row">
              <input
                v-model="joinInput"
                class="join-input"
                :placeholder="t('meet.joinPlaceholder')"
                @keyup.enter="joinExisting"
              />
              <button class="btn btn-ghost" :disabled="!joinInput.trim()" @click="joinExisting">
                {{ t('meet.joinBtn') }}
              </button>
            </div>
          </section>

          <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
        </template>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.meet-home {
  height: 100%;
  overflow: auto;
  padding: 40px 20px;
}
.wrap {
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.loading {
  text-align: center;
  color: var(--text-3);
  padding: 40px 0;
}

/* ---- HERO: acción principal, estilo Google Meet ---- */
.hero {
  text-align: center;
  padding: 40px 28px 32px;
  border-radius: 20px;
  border: 1px solid var(--border);
  background:
    radial-gradient(
      120% 90% at 50% -10%,
      color-mix(in srgb, var(--accent) 12%, transparent),
      transparent 60%
    ),
    var(--surface);
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
}
.hero-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 16px;
  border-radius: 18px;
  display: grid;
  place-items: center;
  background: var(--accent);
  color: #fff;
  box-shadow: 0 6px 20px -6px color-mix(in srgb, var(--accent) 55%, transparent);
}
.hero h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: -0.01em;
  color: var(--text-1);
}
.hero-sub {
  margin: 6px auto 0;
  max-width: 400px;
  color: var(--text-2);
  font-size: 14.5px;
  line-height: 1.5;
}
.hero-body {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.hero-hint {
  margin: 0;
  color: var(--text-3);
  font-size: 12.5px;
}
.ready {
  width: 100%;
}
.ready-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--green-soft);
  color: var(--green);
  font-size: 12.5px;
  font-weight: 600;
}
.ready-badge .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 14px;
}

/* ---- JOIN ---- */
.join-card {
  padding: 18px 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
}
.join-text h2 {
  margin: 0 0 2px;
  font-size: 15px;
  color: var(--text-1);
}
.muted {
  color: var(--text-2);
  font-size: 13px;
  margin: 0;
}

/* ---- shared ---- */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  transition:
    filter 0.12s,
    background 0.12s;
}
.btn-lg {
  padding: 13px 26px;
  font-size: 15px;
  border-radius: 12px;
}
.btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.btn-primary {
  background: var(--accent);
  color: #fff;
}
.btn-primary:hover:not(:disabled) {
  filter: brightness(1.06);
}
.btn-ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text-1);
}
.btn-ghost:hover:not(:disabled) {
  background: var(--hover);
}
.btn.sm {
  padding: 7px 10px;
  font-size: 13px;
}
.link-row,
.join-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.link-ico {
  color: var(--text-3);
  flex-shrink: 0;
}
.link-input,
.join-input {
  flex: 1;
  min-width: 0;
  height: 42px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--search-bg);
  color: var(--text-1);
  font: inherit;
  font-size: 14px;
}
.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px dashed var(--border);
  color: var(--text-2);
  font-size: 14px;
}
.err {
  color: var(--danger);
  font-size: 13.5px;
  margin: 0;
  text-align: center;
}
</style>
