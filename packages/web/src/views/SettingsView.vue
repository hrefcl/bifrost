<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon, { type IconName } from '@/components/AppIcon.vue';
import { useSettingsStore } from '@/stores/settings';
import { useAuthStore } from '@/stores/auth';
import { brand } from '@/config/brand';
import { api } from '@/lib/http';
import { SUPPORTED_LOCALES, LOCALE_NAMES, setLocale, type Locale } from '@/i18n';

const settings = useSettingsStore();
const auth = useAuthStore();
const { t, locale } = useI18n();

type Section = 'appearance' | 'signature' | 'security';
const section = ref<Section>('appearance');
const NAV: { id: Section; icon: IconName }[] = [
  { id: 'appearance', icon: 'sun' },
  { id: 'signature', icon: 'pencil' },
  { id: 'security', icon: 'shield' },
];

const THEMES: { id: 'light' | 'dark' | 'system'; icon: IconName; label: string }[] = [
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

// ── Firmas white-label (F4): elegir template + datos + preview en vivo ──
interface SigTemplate {
  id: string;
  nameKey: string;
}
interface SigOptions {
  templates: SigTemplate[];
  policy: { lockTemplate: boolean; allowCustomHtml: boolean; enforceSignature: boolean };
  current: { source?: 'template' | 'custom'; templateId?: string; includePhoto?: boolean } | null;
  hasPhoto: boolean;
}
const sigTemplates = ref<SigTemplate[]>([]);
const sigPolicy = ref({ lockTemplate: false, allowCustomHtml: true, enforceSignature: false });
const sigMode = ref<'template' | 'custom'>('template');
const selectedTemplate = ref('');
const includePhoto = ref(true);
const previewHtml = ref('');
const previewLoading = ref(false);
const prof = ref({ jobTitle: '', department: '', phone: '' });
const photoUrl = ref<string | null>(null);
const profSaving = ref(false);

async function loadSigOptions() {
  try {
    const { data } = await api.get<SigOptions>('/auth/me/signature/options');
    sigTemplates.value = data.templates;
    sigPolicy.value = data.policy;
    const cur = data.current;
    const legacyCustom = Boolean(auth.user?.preferences.defaultSignature);
    sigMode.value = cur?.source ?? (legacyCustom ? 'custom' : 'template');
    if (!data.policy.allowCustomHtml) sigMode.value = 'template';
    const firstId = data.templates[0]?.id ?? '';
    const chosen = cur?.templateId;
    selectedTemplate.value = data.policy.lockTemplate ? firstId : (chosen ?? firstId);
    includePhoto.value = cur?.includePhoto ?? true;
    prof.value = {
      jobTitle: auth.user?.jobTitle ?? '',
      department: auth.user?.department ?? '',
      phone: auth.user?.phone ?? '',
    };
    photoUrl.value = auth.user?.photoUrl ?? null;
    if (sigMode.value === 'custom') void nextTick(fillSigEl);
    else loadPreview();
  } catch {
    /* la sección muestra su estado igual */
  }
}

let previewTimer: ReturnType<typeof setTimeout> | undefined;
function loadPreview() {
  if (sigMode.value !== 'template' || !selectedTemplate.value) {
    previewHtml.value = '';
    return;
  }
  clearTimeout(previewTimer);
  previewLoading.value = true;
  previewTimer = setTimeout(() => {
    void (async () => {
      try {
        const { data } = await api.get<{ html: string }>('/auth/me/signature/preview', {
          params: { templateId: selectedTemplate.value, includePhoto: includePhoto.value },
        });
        previewHtml.value = data.html;
      } catch {
        previewHtml.value = '';
      } finally {
        previewLoading.value = false;
      }
    })();
  }, 250);
}

async function saveSigPref() {
  await api.patch('/auth/me/signature', {
    source: sigMode.value,
    templateId: selectedTemplate.value || undefined,
    includePhoto: includePhoto.value,
  });
}
async function chooseTemplate(id: string) {
  if (sigPolicy.value.lockTemplate) return;
  selectedTemplate.value = id;
  await saveSigPref();
  loadPreview();
}
async function setSigMode(m: 'template' | 'custom') {
  sigMode.value = m;
  await saveSigPref();
  if (m === 'custom') void nextTick(fillSigEl);
  else loadPreview();
}
async function toggleIncludePhoto() {
  await saveSigPref();
  loadPreview();
}

async function saveProfile() {
  profSaving.value = true;
  saved.value = false;
  try {
    const { data } = await api.patch<{
      jobTitle?: string;
      department?: string;
      phone?: string;
    }>('/auth/me/profile', {
      jobTitle: prof.value.jobTitle,
      department: prof.value.department,
      phone: prof.value.phone,
    });
    if (auth.user) {
      auth.user.jobTitle = data.jobTitle;
      auth.user.department = data.department;
      auth.user.phone = data.phone;
    }
    saved.value = true;
    loadPreview();
  } catch {
    error.value = t('settings.signature.error');
  } finally {
    profSaving.value = false;
  }
}

const PHOTO_MAX = 2 * 1024 * 1024;
function onPhotoPick(e: Event) {
  error.value = '';
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    error.value = t('settings.signature.photoType');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl || dataUrl.length * 0.75 > PHOTO_MAX) {
      error.value = t('settings.signature.photoSize');
      return;
    }
    void (async () => {
      try {
        const { data } = await api.patch<{ photoUrl?: string }>('/auth/me/profile', {
          photoDataUrl: dataUrl,
        });
        photoUrl.value = data.photoUrl ?? null;
        if (auth.user) auth.user.photoUrl = data.photoUrl;
        loadPreview();
      } catch {
        error.value = t('settings.signature.photoType');
      }
    })();
  };
  reader.readAsDataURL(file);
}
async function clearPhoto() {
  const { data } = await api.patch<{ photoUrl?: string }>('/auth/me/profile', { clearPhoto: true });
  photoUrl.value = data.photoUrl ?? null;
  if (auth.user) auth.user.photoUrl = data.photoUrl;
  loadPreview();
}

// Cargar opciones al entrar a la sección firma (además del onMounted de abajo).
watch(section, (s) => {
  if (s === 'signature') void loadSigOptions();
});
onMounted(() => {
  if (section.value === 'signature') void loadSigOptions();
});
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
              <div class="row-desc">
                {{ brand.lockAccentColor ? t('settings.accentLocked') : t('settings.accentDesc') }}
              </div>
            </div>
            <div v-if="!brand.lockAccentColor" class="swatches">
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
            <span v-else class="badge ok-badge"
              ><AppIcon name="lock" :size="13" />{{ t('settings.locked') }}</span
            >
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

        <!-- Firma (white-label F4) -->
        <template v-else-if="section === 'signature'">
          <h2 class="section-h">{{ t('settings.signature.title') }}</h2>
          <p class="section-desc">{{ t('settings.signature.desc') }}</p>

          <p v-if="sigPolicy.enforceSignature" class="sig-policy-note">
            {{ t('settings.signature.enforced') }}
          </p>

          <!-- Toggle template / HTML propio (custom sólo si la política lo permite) -->
          <div v-if="sigPolicy.allowCustomHtml && !sigPolicy.lockTemplate" class="sig-modes">
            <button
              class="sig-mode"
              :class="{ active: sigMode === 'template' }"
              @click="setSigMode('template')"
            >
              {{ t('settings.signature.modeTemplate') }}
            </button>
            <button
              class="sig-mode"
              :class="{ active: sigMode === 'custom' }"
              @click="setSigMode('custom')"
            >
              {{ t('settings.signature.modeCustom') }}
            </button>
          </div>

          <!-- MODO TEMPLATE -->
          <div v-if="sigMode === 'template'" class="sig-tpl">
            <!-- Datos personales que rellenan la firma -->
            <div class="sig-fields">
              <label class="fld"
                ><span>{{ t('settings.signature.jobTitle') }}</span
                ><input v-model="prof.jobTitle" class="inp" maxlength="120"
              /></label>
              <label class="fld"
                ><span>{{ t('settings.signature.department') }}</span
                ><input v-model="prof.department" class="inp" maxlength="120"
              /></label>
              <label class="fld"
                ><span>{{ t('settings.signature.phone') }}</span
                ><input v-model="prof.phone" class="inp" maxlength="40"
              /></label>
              <div class="fld">
                <span>{{ t('settings.signature.photo') }}</span>
                <div class="photo-row">
                  <span class="photo-prev" :class="{ empty: !photoUrl }">
                    <img v-if="photoUrl" :src="photoUrl" alt="foto" />
                  </span>
                  <label class="ghost-btn file-btn">
                    {{ t('settings.signature.pickPhoto') }}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      hidden
                      @change="onPhotoPick"
                    />
                  </label>
                  <button v-if="photoUrl" class="link-btn" @click="clearPhoto">
                    {{ t('settings.signature.removePhoto') }}
                  </button>
                </div>
              </div>
            </div>
            <div class="save-row">
              <button class="primary-btn" :disabled="profSaving" @click="saveProfile">
                {{ profSaving ? t('settings.signature.saving') : t('settings.signature.saveData') }}
              </button>
              <label class="check-row inline">
                <input v-model="includePhoto" type="checkbox" @change="toggleIncludePhoto" />
                {{ t('settings.signature.includePhoto') }}
              </label>
            </div>

            <!-- Galería de templates (radiogroup) -->
            <div
              class="sig-gallery"
              role="radiogroup"
              :aria-label="t('settings.signature.chooseTemplate')"
            >
              <button
                v-for="tpl in sigTemplates"
                :key="tpl.id"
                class="sig-card"
                :class="{ active: selectedTemplate === tpl.id }"
                role="radio"
                :aria-checked="selectedTemplate === tpl.id"
                :disabled="sigPolicy.lockTemplate"
                @click="chooseTemplate(tpl.id)"
              >
                <span class="sig-card-name">{{ t(tpl.nameKey) }}</span>
                <AppIcon
                  v-if="selectedTemplate === tpl.id"
                  name="check"
                  :size="16"
                  class="sig-card-check"
                />
              </button>
            </div>

            <!-- Preview en vivo -->
            <div class="sig-preview-wrap">
              <div class="sig-preview-head">{{ t('settings.signature.preview') }}</div>
              <div class="sig-preview">
                <p v-if="previewLoading" class="muted sm">{{ t('common.loading') }}</p>
                <!-- previewHtml viene saneado SERVER-SIDE (mismo pipeline sanitizeEmailHtml que el
                     envío) — fuente única, no se rendiza HTML del cliente. -->
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div v-else-if="previewHtml" v-html="previewHtml"></div>
                <p v-else class="muted sm">{{ t('settings.signature.previewEmpty') }}</p>
              </div>
            </div>
          </div>

          <!-- MODO CUSTOM (HTML pegado) -->
          <div v-else class="sig-custom">
            <div
              ref="sigEl"
              class="sig-editor"
              contenteditable="true"
              role="textbox"
              aria-multiline="true"
              @input="onSigInput"
            ></div>
            <p class="sig-hint">{{ t('settings.signature.htmlHint') }}</p>
            <div class="save-row">
              <button class="primary-btn" :disabled="saving" @click="saveSignature">
                {{ saving ? t('settings.signature.saving') : t('settings.signature.save') }}
              </button>
            </div>
          </div>

          <label v-if="!sigPolicy.enforceSignature" class="check-row">
            <input v-model="autoInclude" type="checkbox" @change="saveSignature" />
            {{ t('settings.signature.autoInclude') }}
          </label>
          <div class="save-row">
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
  color: var(--green);
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
  color: var(--green);
  background: var(--green-soft);
}

/* ── Firma white-label (F4) ── */
.sig-policy-note {
  font-size: 13px;
  color: var(--accent-ink);
  background: var(--accent-soft);
  border-radius: 8px;
  padding: 8px 12px;
  margin: 0 0 14px;
}
.sig-modes {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  background: var(--surface-dim);
  border-radius: 9px;
  margin-bottom: 16px;
}
.sig-mode {
  border: none;
  background: transparent;
  padding: 6px 14px;
  border-radius: 7px;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
}
.sig-mode.active {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-sm);
}
.sig-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.inp {
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font: inherit;
  font-weight: 400;
  background: var(--surface);
  color: var(--text-1);
}
.photo-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.photo-prev {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--surface-dim);
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.photo-prev img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ghost-btn {
  padding: 7px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.file-btn {
  display: inline-block;
}
.link-btn {
  border: none;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.check-row.inline {
  margin: 0;
}
.sig-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 16px 0;
}
.sig-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1.5px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-1);
  cursor: pointer;
}
.sig-card:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.sig-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.sig-card:disabled {
  opacity: 0.6;
  cursor: default;
}
.sig-card-check {
  color: var(--accent);
}
.sig-preview-wrap {
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.sig-preview-head {
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3);
  background: var(--surface-dim);
  border-bottom: 1px solid var(--border);
}
.sig-preview {
  padding: 18px;
  background: var(--surface);
  min-height: 60px;
}
.muted {
  color: var(--text-3);
}
.sm {
  font-size: 12.5px;
}
@media (max-width: 560px) {
  .sig-fields {
    grid-template-columns: 1fr;
  }
}
</style>
