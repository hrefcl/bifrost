<script setup lang="ts">
/**
 * UI de la PWA (montada una vez en App.vue, fuera del <router-view>):
 *  - Banner "sin conexión" (el correo requiere red).
 *  - Toast "actualizar" cuando hay un service worker nuevo esperando.
 *  - Banner de instalación (Android/desktop, flujo nativo `beforeinstallprompt`).
 *  - Hint de iOS Safari ("Agregar a pantalla de inicio", que no tiene flujo automático).
 *
 * Los CTA de instalación NO se muestran en páginas públicas de invitado (guestOk) para no
 * molestar a externos que sólo reservan/entran a una reunión.
 */
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import AppIcon from '@/components/AppIcon.vue';
import { usePwa } from '@/composables/usePwa';

const { t } = useI18n();
const route = useRoute();
const pwa = usePwa();

const isGuestRoute = computed(() => route.meta.guestOk === true);
const showInstall = computed(() => pwa.showInstallBanner.value && !isGuestRoute.value);
const showIos = computed(() => pwa.showIosHint.value && !isGuestRoute.value);

const installing = ref(false);
async function onInstall() {
  if (installing.value) return; // evita doble invocación (review C-LOW-4)
  installing.value = true;
  try {
    const outcome = await pwa.promptInstall();
    // Sólo descartar si el usuario RECHAZÓ. En 'unavailable' (prompt ya consumido / doble click)
    // no se persiste el descarte para no ocultar el CTA tras una instalación aceptada en vuelo.
    if (outcome === 'dismissed') pwa.dismissInstall();
  } finally {
    installing.value = false;
  }
}

// El banner offline es `position: fixed` arriba. Para NO tapar el topbar (que es flujo normal, no
// fixed), se expone su alto real como `--pwa-top-inset` en <html>; los layouts (.shell/.pub) lo
// consumen para empujar el contenido. Online → 0px (comportamiento idéntico al de antes).
const offlineBar = ref<HTMLElement | null>(null);
let ro: ResizeObserver | null = null;
function setInset(px: number) {
  document.documentElement.style.setProperty('--pwa-top-inset', `${String(px)}px`);
}
function measure() {
  setInset(offlineBar.value?.offsetHeight ?? 40);
}
watch(
  () => pwa.online.value,
  async (isOnline) => {
    ro?.disconnect();
    ro = null;
    if (isOnline) {
      setInset(0);
      return;
    }
    await nextTick(); // esperar a que el banner exista para medir su alto (incluye safe-area)
    measure();
    // El banner puede WRAPPEAR a 2–3 líneas en pantallas angostas o cambiar de alto al rotar
    // (safe-area). Sin re-medir, el inset quedaría corto y el banner fixed taparía el topbar
    // (review C-MED-2). El ResizeObserver mantiene `--pwa-top-inset` sincronizado con el alto real.
    if (offlineBar.value && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        measure();
      });
      ro.observe(offlineBar.value);
    }
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  ro?.disconnect();
  setInset(0);
});
</script>

<template>
  <!-- Sin conexión: banner claro y persistente arriba. NO bloquea lo ya cargado (product decision). -->
  <div
    v-if="!pwa.online.value"
    ref="offlineBar"
    class="pwa-offline"
    role="status"
    aria-live="polite"
  >
    <AppIcon name="wifiSlash" :size="18" />
    <span
      ><strong>{{ t('pwa.offline.title') }}.</strong> {{ t('pwa.offline.body') }}</span
    >
  </div>

  <!-- Nueva versión disponible: toast con acción explícita (no recarga sola). -->
  <div v-if="pwa.needRefresh.value" class="pwa-toast" role="status" aria-live="polite">
    <span>{{ t('pwa.update.title') }}</span>
    <button type="button" class="pwa-btn pwa-btn--accent" @click="pwa.applyUpdate()">
      <AppIcon name="refresh" :size="16" />
      {{ t('pwa.update.action') }}
    </button>
  </div>

  <!-- Instalación nativa (Android / desktop). -->
  <div v-if="showInstall" class="pwa-card" role="dialog" :aria-label="t('pwa.install.title')">
    <AppIcon name="download" :size="22" class="pwa-card__icon" />
    <div class="pwa-card__body">
      <p class="pwa-card__title">{{ t('pwa.install.title') }}</p>
      <p class="pwa-card__text">{{ t('pwa.install.body') }}</p>
    </div>
    <div class="pwa-card__actions">
      <button type="button" class="pwa-btn" @click="pwa.dismissInstall()">
        {{ t('pwa.install.dismiss') }}
      </button>
      <button
        type="button"
        class="pwa-btn pwa-btn--accent"
        :disabled="installing"
        @click="onInstall()"
      >
        {{ t('pwa.install.action') }}
      </button>
    </div>
  </div>

  <!-- Hint iOS Safari (no hay prompt automático → instrucciones). -->
  <div v-else-if="showIos" class="pwa-card" role="dialog" :aria-label="t('pwa.ios.title')">
    <AppIcon name="share" :size="22" class="pwa-card__icon" />
    <div class="pwa-card__body">
      <p class="pwa-card__title">{{ t('pwa.ios.title') }}</p>
      <ol class="pwa-card__steps">
        <li>{{ t('pwa.ios.step1') }}</li>
        <li>{{ t('pwa.ios.step2') }}</li>
      </ol>
    </div>
    <div class="pwa-card__actions">
      <button type="button" class="pwa-btn pwa-btn--accent" @click="pwa.dismissInstall()">
        {{ t('pwa.ios.dismiss') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.pwa-offline {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 12px;
  padding-top: calc(8px + env(safe-area-inset-top, 0px));
  background: #92400e;
  color: #fff;
  font-size: 13px;
  line-height: 1.3;
  text-align: center;
}

.pwa-toast {
  position: fixed;
  left: 50%;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 1001;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100vw - 24px);
  padding: 10px 12px 10px 16px;
  border-radius: 10px;
  background: var(--toast-bg, #1f2430);
  color: var(--toast-fg, #fff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  font-size: 14px;
}

.pwa-card {
  position: fixed;
  left: 50%;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 1001;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: min(420px, calc(100vw - 24px));
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--surface, #fff);
  color: var(--text-1, #1f2430);
  border: 1px solid var(--border, #e6e9f1);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
}

.pwa-card__icon {
  color: var(--accent, #1b66ff);
  margin-top: 2px;
}

.pwa-card__body {
  flex: 1;
  min-width: 0;
}

.pwa-card__title {
  font-weight: 600;
  font-size: 14px;
  margin: 0 0 2px;
}

.pwa-card__text {
  font-size: 13px;
  color: var(--text-2, #4b5563);
  margin: 0;
}

.pwa-card__steps {
  font-size: 13px;
  color: var(--text-2, #4b5563);
  margin: 4px 0 0;
  padding-left: 18px;
}

.pwa-card__steps li {
  margin: 2px 0;
}

.pwa-card__actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.pwa-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-strong, #c9cfdc);
  background: transparent;
  color: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.pwa-btn:hover {
  background: color-mix(in srgb, currentColor 8%, transparent);
}

.pwa-btn--accent {
  background: var(--accent, #1b66ff);
  border-color: var(--accent, #1b66ff);
  color: #fff;
}

.pwa-btn--accent:hover {
  background: var(--accent-700, #1550cc);
}

/* La barra offline empuja el layout con un pelín de aire arriba para no tapar el header. */
@media (max-width: 640px) {
  .pwa-card {
    flex-direction: column;
  }
  .pwa-card__actions {
    flex-direction: row;
    justify-content: flex-end;
    width: 100%;
  }
}
</style>
