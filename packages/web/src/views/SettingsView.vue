<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import { useSettingsStore } from '@/stores/settings';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/lib/http';
import { SUPPORTED_LOCALES, LOCALE_NAMES, setLocale, type Locale } from '@/i18n';

const settings = useSettingsStore();
const auth = useAuthStore();
const { t, locale } = useI18n();

type Section = 'appearance' | 'signature' | 'security';
const section = ref<Section>('appearance');
const NAV: { id: Section; icon: string }[] = [
  { id: 'appearance', icon: 'sun' },
  { id: 'signature', icon: 'pencil' },
  { id: 'security', icon: 'shield' },
];

const THEMES: { id: 'light' | 'dark' | 'system'; icon: string; label: string }[] = [
  { id: 'light', icon: 'sun', label: 'themeLight' },
  { id: 'dark', icon: 'moon', label: 'themeDark' },
  { id: 'system', icon: 'settings', label: 'themeSystem' },
];
const ACCENTS = ['#1b66ff', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

const signature = ref('');
const autoInclude = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

// Editor de firma = contenteditable CRUDO (no TipTap): al pegar la firma del generador (Cleverty,
// etc.) el navegador inserta el HTML rico tal cual (tablas/img/estilos), igual que Gmail. El backend
// lo sanea al guardar. TipTap lo habría destruido por su schema restrictivo.
const sigEl = ref<HTMLDivElement | null>(null);
function onSigInput() {
  if (sigEl.value) signature.value = sigEl.value.innerHTML;
}
function fillSigEl() {
  if (sigEl.value && sigEl.value.innerHTML !== signature.value) {
    sigEl.value.innerHTML = signature.value;
  }
}
// El contenteditable sólo existe cuando la sección 'signature' está activa → poblarlo al entrar.
watch(section, (s) => {
  if (s === 'signature') void nextTick(fillSigEl);
});

onMounted(() => {
  const prefs = auth.user?.preferences;
  signature.value = prefs?.defaultSignature ?? '';
  autoInclude.value = prefs?.autoIncludeSignature ?? true;
  if (section.value === 'signature') void nextTick(fillSigEl);
});

function pickLocale(l: Locale) {
  setLocale(l);
}

async function saveSignature() {
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    const { data } = await api.patch<{ defaultSignature?: string; autoIncludeSignature: boolean }>(
      '/auth/me/preferences',
      { defaultSignature: signature.value, autoIncludeSignature: autoInclude.value }
    );
    // Reflejar la versión SANEADA por el backend en el estado local.
    if (auth.user) {
      auth.user.preferences.defaultSignature = data.defaultSignature;
      auth.user.preferences.autoIncludeSignature = data.autoIncludeSignature;
    }
    signature.value = data.defaultSignature ?? '';
    void nextTick(fillSigEl); // mostrar la versión SANEADA por el backend en el editor
    saved.value = true;
  } catch {
    error.value = t('settings.signature.error');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppLayout>
    <div class="settings">
      <!-- Nav lateral -->
      <nav class="settings-nav">
        <h1 class="settings-title">{{ t('settings.title') }}</h1>
        <button
          v-for="s in NAV"
          :key="s.id"
          class="nav-item"
          :class="{ active: section === s.id }"
          @click="section = s.id"
        >
          <AppIcon :name="s.icon" :size="18" />
          {{ t('settings.nav.' + s.id) }}
        </button>
      </nav>

      <!-- Contenido -->
      <div class="settings-content">
        <!-- Apariencia -->
        <template v-if="section === 'appearance'">
          <h2 class="section-h">{{ t('settings.appearance') }}</h2>

          <div class="row">
            <div class="row-text">
              <div class="row-title">{{ t('settings.theme') }}</div>
              <div class="row-desc">{{ t('settings.themeDesc') }}</div>
            </div>
            <div class="segmented">
              <button
                v-for="th in THEMES"
                :key="th.id"
                class="seg"
                :class="{ on: settings.theme === th.id }"
                @click="settings.setTheme(th.id)"
              >
                <AppIcon :name="th.icon" :size="16" />{{ t('settings.' + th.label) }}
              </button>
            </div>
          </div>

          <div class="row">
            <div class="row-text">
              <div class="row-title">{{ t('settings.accent') }}</div>
              <div class="row-desc">{{ t('settings.accentDesc') }}</div>
            </div>
            <div class="swatches">
              <button
                v-for="c in ACCENTS"
                :key="c"
                class="swatch"
                :class="{ on: settings.accent.toLowerCase() === c }"
                :style="{ background: c, '--ring': c }"
                :aria-label="c"
                @click="settings.setAccent(c)"
              />
            </div>
          </div>

          <div class="row">
            <div class="row-text">
              <div class="row-title">{{ t('settings.language') }}</div>
              <div class="row-desc">{{ t('settings.languageDesc') }}</div>
            </div>
            <div class="segmented">
              <button
                v-for="l in SUPPORTED_LOCALES"
                :key="l"
                class="seg"
                :class="{ on: locale === l }"
                @click="pickLocale(l)"
              >
                {{ LOCALE_NAMES[l] }}
              </button>
            </div>
          </div>
        </template>

        <!-- Firma -->
        <template v-else-if="section === 'signature'">
          <h2 class="section-h">{{ t('settings.signature.title') }}</h2>
          <p class="section-desc">{{ t('settings.signature.desc') }}</p>
          <div
            ref="sigEl"
            class="sig-editor"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            @input="onSigInput"
          ></div>
          <p class="sig-hint">{{ t('settings.signature.htmlHint') }}</p>
          <label class="check-row">
            <input v-model="autoInclude" type="checkbox" />
            {{ t('settings.signature.autoInclude') }}
          </label>
          <div class="save-row">
            <button class="primary-btn" :disabled="saving" @click="saveSignature">
              {{ saving ? t('settings.signature.saving') : t('settings.signature.save') }}
            </button>
            <span v-if="saved" class="ok">{{ t('settings.signature.saved') }}</span>
            <span v-if="error" class="err">{{ error }}</span>
          </div>
        </template>

        <!-- Seguridad (lectura: hechos reales de la plataforma) -->
        <template v-else>
          <h2 class="section-h">{{ t('settings.security.title') }}</h2>
          <div class="row">
            <div class="row-text">
              <div class="row-title">{{ t('settings.security.credEnc') }}</div>
              <div class="row-desc">{{ t('settings.security.credEncDesc') }}</div>
            </div>
            <span class="badge ok-badge"
              ><AppIcon name="check" :size="13" />{{ t('settings.security.active') }}</span
            >
          </div>
          <div class="row">
            <div class="row-text">
              <div class="row-title">{{ t('settings.security.session') }}</div>
              <div class="row-desc">{{ t('settings.security.sessionDesc') }}</div>
            </div>
            <span class="badge ok-badge"
              ><AppIcon name="check" :size="13" />{{ t('settings.security.active') }}</span
            >
          </div>
          <div class="row">
            <div class="row-text">
              <div class="row-title">{{ t('settings.security.sanitize') }}</div>
              <div class="row-desc">{{ t('settings.security.sanitizeDesc') }}</div>
            </div>
            <span class="badge ok-badge"
              ><AppIcon name="check" :size="13" />{{ t('settings.security.server') }}</span
            >
          </div>
        </template>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.settings {
  display: flex;
  height: 100%;
  background: var(--surface);
}
.settings-nav {
  width: 230px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 20px 12px;
  background: var(--bg);
}
.settings-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0 0 16px;
  padding: 0 12px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 0 12px;
  height: 40px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  background: transparent;
  color: var(--text-1);
  margin-bottom: 2px;
  text-align: left;
}
.nav-item:hover {
  background: var(--hover);
}
.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 700;
}
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 28px 40px;
  max-width: 760px;
}
.section-h {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 8px;
}
.section-desc {
  font-size: 13.5px;
  color: var(--text-3);
  margin: 0 0 16px;
}
.row {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.row-text {
  flex: 1;
}
.row-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 2px;
}
.row-desc {
  font-size: 13px;
  color: var(--text-3);
  line-height: 1.5;
}
.segmented {
  display: flex;
  background: var(--bg);
  border-radius: 9px;
  padding: 3px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.seg {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 16px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  background: transparent;
  color: var(--text-2);
}
.seg.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-sm);
}
.swatches {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.swatch {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 3px solid transparent;
  cursor: pointer;
  padding: 0;
}
.swatch.on {
  border-color: var(--surface);
  box-shadow: 0 0 0 2px var(--ring);
}
.editor-box {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 14px;
}
.editor-box :deep(.ProseMirror) {
  min-height: 120px;
  outline: none;
}
/* Editor de firma: contenteditable crudo que preserva el HTML pegado (firmas ricas tipo Gmail). */
.sig-editor {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  min-height: 130px;
  outline: none;
  overflow: auto;
  background: var(--bg);
  color: var(--text-1);
}
.sig-editor:focus {
  border-color: var(--accent);
}
.sig-editor :deep(img) {
  max-width: 100%;
}
.sig-hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 6px 0 14px;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-1);
  margin-bottom: 16px;
}
.save-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.primary-btn {
  padding: 9px 20px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.primary-btn:hover:not(:disabled) {
  background: var(--accent-700);
}
.primary-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.ok {
  font-size: 13.5px;
  color: #16a34a;
  font-weight: 600;
}
.err {
  font-size: 13.5px;
  color: var(--danger);
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 6px;
  flex-shrink: 0;
}
.ok-badge {
  color: #16a34a;
  background: color-mix(in srgb, #16a34a 14%, transparent);
}
</style>
