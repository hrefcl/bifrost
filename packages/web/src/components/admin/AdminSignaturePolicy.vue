<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { AxiosError } from 'axios';
import { api } from '@/lib/http';

/**
 * Editor de firmas de empresa (admin) — estructura del diseño-biblia: pestañas **Plantilla** y **Estilo**
 * + **preview grande en vivo**. La empresa elige el diseño estándar y su estilo (color + logo horizontal/
 * vertical + eslogan); aplica a todo el equipo. El `v-html` va sobre HTML saneado por el backend.
 */
const { t } = useI18n();

interface Tpl {
  id: string;
  nameKey: string;
  html: string;
}
interface Policy {
  allowedTemplateIds: string[];
  lockTemplate: boolean;
  enforceSignature: boolean;
  allowCustomHtml: boolean;
}

const tab = ref<'plantilla' | 'estilo'>('plantilla');
const templates = ref<Tpl[]>([]);
const policy = ref<Policy>({
  allowedTemplateIds: [],
  lockTemplate: false,
  enforceSignature: false,
  allowCustomHtml: true,
});
// Estilo = campos de branding que alimentan la firma (se guardan en /admin/config/branding).
const estilo = ref({
  accentColor: '#1b66ff',
  companyName: '',
  tagline: '',
  logoDataUrl: '',
  logoVerticalDataUrl: '',
});
const selectedId = ref('');
const previewHtml = ref('');
const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

const LOGO_MAX = 256 * 1024;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [pol, prev, brand] = await Promise.all([
      api.get<{ policy: Policy; templates: { id: string; nameKey: string }[] }>(
        '/admin/config/signature-policy'
      ),
      api.get<{ previews: Tpl[] }>('/admin/config/signature-previews'),
      api.get<{
        accentColor: string | null;
        companyName: string | null;
        tagline: string | null;
        logoDataUrl: string | null;
        logoVerticalDataUrl: string | null;
      }>('/admin/config/branding'),
    ]);
    policy.value = pol.data.policy;
    const htmlById = new Map(prev.data.previews.map((p) => [p.id, p.html]));
    templates.value = pol.data.templates.map((tp) => ({ ...tp, html: htmlById.get(tp.id) ?? '' }));
    estilo.value = {
      accentColor: brand.data.accentColor ?? '#1b66ff',
      companyName: brand.data.companyName ?? '',
      tagline: brand.data.tagline ?? '',
      logoDataUrl: brand.data.logoDataUrl ?? '',
      logoVerticalDataUrl: brand.data.logoVerticalDataUrl ?? '',
    };
    selectedId.value = policy.value.allowedTemplateIds.at(0) ?? templates.value.at(0)?.id ?? '';
    await refreshPreview();
  } catch {
    error.value = t('admin.signatures.errLoad');
  } finally {
    loading.value = false;
  }
}

const isSelected = (id: string) => policy.value.allowedTemplateIds.includes(id);

function pick(id: string) {
  saved.value = false;
  selectedId.value = id;
  if (policy.value.lockTemplate) {
    policy.value.allowedTemplateIds = [id];
  } else {
    const arr = policy.value.allowedTemplateIds;
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(id);
  }
}
function setLock(v: boolean) {
  saved.value = false;
  policy.value.lockTemplate = v;
  if (v && policy.value.allowedTemplateIds.length > 1) {
    policy.value.allowedTemplateIds = [selectedId.value || policy.value.allowedTemplateIds[0]];
  }
}

function onLogoPick(e: Event, kind: 'h' | 'v') {
  error.value = '';
  saved.value = false;
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    error.value = t('admin.branding.errType');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl) return;
    if (dataUrl.length * 0.75 > LOGO_MAX) {
      error.value = t('admin.branding.errSize');
      return;
    }
    if (kind === 'h') estilo.value.logoDataUrl = dataUrl;
    else estilo.value.logoVerticalDataUrl = dataUrl;
  };
  reader.readAsDataURL(file);
}

// Preview grande EN VIVO (debounced): rendiza el template seleccionado con el estilo sin guardar.
let previewTimer: ReturnType<typeof setTimeout> | undefined;
async function refreshPreview() {
  if (!selectedId.value) return;
  try {
    const { data } = await api.post<{ html: string }>('/admin/config/signature-preview', {
      templateId: selectedId.value,
      accentColor: estilo.value.accentColor,
      companyName: estilo.value.companyName,
      tagline: estilo.value.tagline,
      logoDataUrl: estilo.value.logoDataUrl,
      logoVerticalDataUrl: estilo.value.logoVerticalDataUrl,
    });
    previewHtml.value = data.html;
  } catch {
    /* preview best-effort */
  }
}
watch(
  [selectedId, estilo],
  () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void refreshPreview(), 350);
  },
  { deep: true }
);

const canSave = computed(
  () => !policy.value.lockTemplate || policy.value.allowedTemplateIds.length > 0
);

async function save() {
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    await api.put('/admin/config/branding', {
      accentColor: estilo.value.accentColor,
      companyName: estilo.value.companyName,
      tagline: estilo.value.tagline,
      logoDataUrl: estilo.value.logoDataUrl, // '' limpia
      logoVerticalDataUrl: estilo.value.logoVerticalDataUrl,
    });
    const { data } = await api.put<Policy>('/admin/config/signature-policy', policy.value);
    policy.value = data;
    saved.value = true;
  } catch (e) {
    error.value =
      e instanceof AxiosError && e.response?.status === 400
        ? t('admin.signatures.errInvalid')
        : t('admin.signatures.errSave');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="siged">
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <div v-else class="grid">
      <!-- Panel izquierdo: pestañas + controles -->
      <div class="panel">
        <div class="tabs">
          <button :class="{ on: tab === 'plantilla' }" @click="tab = 'plantilla'">
            {{ t('admin.signatures.tabTemplate') }}
          </button>
          <button :class="{ on: tab === 'estilo' }" @click="tab = 'estilo'">
            {{ t('admin.signatures.tabStyle') }}
          </button>
        </div>

        <!-- PLANTILLA -->
        <div v-show="tab === 'plantilla'">
          <div class="modebar">
            <label class="mode" :class="{ on: !policy.lockTemplate }">
              <input type="radio" :checked="!policy.lockTemplate" @change="setLock(false)" />
              <strong>{{ t('admin.signatures.modeChoose') }}</strong>
            </label>
            <label class="mode" :class="{ on: policy.lockTemplate }">
              <input type="radio" :checked="policy.lockTemplate" @change="setLock(true)" />
              <strong>{{ t('admin.signatures.modeStandard') }}</strong>
            </label>
          </div>
          <div class="gallery">
            <button
              v-for="tpl in templates"
              :key="tpl.id"
              type="button"
              class="card"
              :class="{ active: selectedId === tpl.id, on: isSelected(tpl.id) }"
              @click="pick(tpl.id)"
            >
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div class="mini" v-html="tpl.html"></div>
              <div class="card-foot">
                <span>{{ t(tpl.nameKey) }}</span>
                <span v-if="isSelected(tpl.id)" class="badge">
                  {{
                    policy.lockTemplate
                      ? t('admin.signatures.badgeStandard')
                      : t('admin.signatures.badgeOn')
                  }}
                </span>
              </div>
            </button>
          </div>
          <label class="opt">
            <input v-model="policy.enforceSignature" type="checkbox" @change="saved = false" />
            <span>{{ t('admin.signatures.enforce') }}</span>
          </label>
          <label class="opt">
            <input v-model="policy.allowCustomHtml" type="checkbox" @change="saved = false" />
            <span>{{ t('admin.signatures.allowCustom') }}</span>
          </label>
        </div>

        <!-- ESTILO -->
        <div v-show="tab === 'estilo'" class="estilo">
          <label class="fld"
            ><span>{{ t('admin.signatures.styleCompany') }}</span>
            <input v-model="estilo.companyName" class="in" maxlength="60" @input="saved = false"
          /></label>
          <label class="fld"
            ><span>{{ t('admin.signatures.styleTagline') }}</span>
            <input v-model="estilo.tagline" class="in" maxlength="80" @input="saved = false"
          /></label>
          <label class="fld"
            ><span>{{ t('admin.signatures.styleColor') }}</span>
            <span class="color-row">
              <input
                v-model="estilo.accentColor"
                type="color"
                class="swatch"
                @input="saved = false"
              />
              <input v-model="estilo.accentColor" class="in" maxlength="7" @input="saved = false" />
            </span>
          </label>
          <div class="logos">
            <div class="logobox">
              <span class="lbl">{{ t('admin.signatures.styleLogoH') }}</span>
              <div class="logoprev" :class="{ empty: !estilo.logoDataUrl }">
                <img v-if="estilo.logoDataUrl" :src="estilo.logoDataUrl" alt="logo" />
              </div>
              <label class="btn-sec"
                >{{ t('admin.branding.pickLogo') }}
                <input type="file" accept="image/*" hidden @change="onLogoPick($event, 'h')"
              /></label>
              <button v-if="estilo.logoDataUrl" class="lnk" @click="estilo.logoDataUrl = ''">
                {{ t('admin.branding.removeLogo') }}
              </button>
            </div>
            <div class="logobox">
              <span class="lbl">{{ t('admin.signatures.styleLogoV') }}</span>
              <div class="logoprev v" :class="{ empty: !estilo.logoVerticalDataUrl }">
                <img
                  v-if="estilo.logoVerticalDataUrl"
                  :src="estilo.logoVerticalDataUrl"
                  alt="logo v"
                />
              </div>
              <label class="btn-sec"
                >{{ t('admin.branding.pickLogo') }}
                <input type="file" accept="image/*" hidden @change="onLogoPick($event, 'v')"
              /></label>
              <button
                v-if="estilo.logoVerticalDataUrl"
                class="lnk"
                @click="estilo.logoVerticalDataUrl = ''"
              >
                {{ t('admin.branding.removeLogo') }}
              </button>
            </div>
          </div>
          <p class="hint">{{ t('admin.signatures.styleLogoHint') }}</p>
        </div>

        <div class="actions">
          <button class="btn" :disabled="saving || !canSave" @click="save">
            {{ saving ? t('admin.saving') : t('admin.save') }}
          </button>
          <span v-if="saved" class="ok">{{ t('admin.saved') }}</span>
          <span v-if="error" class="err">{{ error }}</span>
        </div>
      </div>

      <!-- Panel derecho: preview grande en vivo -->
      <div class="preview-panel">
        <div class="preview-head">{{ t('admin.signatures.preview') }}</div>
        <div class="preview-body">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="big" v-html="previewHtml"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.muted {
  color: var(--text-3);
}
.grid {
  display: grid;
  grid-template-columns: minmax(340px, 440px) 1fr;
  gap: 20px;
  align-items: start;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
.tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.tabs button {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 12px;
  font: inherit;
  font-weight: 600;
  color: var(--text-3);
  cursor: pointer;
}
.tabs button.on {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
.modebar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.mode {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.mode.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
.mode input {
  accent-color: var(--accent);
}
.gallery {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 14px;
}
.card {
  text-align: left;
  padding: 0;
  background: #fff;
  border: 2px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  font: inherit;
}
.card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.mini {
  height: 92px;
  overflow: hidden;
  padding: 10px;
  transform: scale(0.62);
  transform-origin: top left;
  width: 160%;
}
.card-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 10px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
}
.badge {
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  padding: 1px 7px;
  border-radius: 999px;
}
.opt {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  margin-top: 8px;
  cursor: pointer;
}
.opt input {
  accent-color: var(--accent);
}
.estilo {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
}
.in {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font: inherit;
}
.color-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.swatch {
  width: 42px;
  height: 38px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.logos {
  display: flex;
  gap: 14px;
}
.logobox {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
}
.lbl {
  font-weight: 600;
}
.logoprev {
  height: 60px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
}
.logoprev.v {
  height: 88px;
}
.logoprev img {
  max-width: 100%;
  max-height: 100%;
}
.btn-sec {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  text-align: center;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
}
.lnk {
  background: none;
  border: none;
  color: var(--danger);
  font-size: 12px;
  cursor: pointer;
}
.hint {
  font-size: 12px;
  color: var(--text-3);
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
}
.btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 9px 18px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.55;
}
.ok {
  color: var(--green);
  font-weight: 600;
  font-size: 13px;
}
.err {
  color: var(--danger);
  font-size: 13px;
}
.preview-panel {
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  position: sticky;
  top: 12px;
}
.preview-head {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
  background: #fafbfc;
}
.preview-body {
  padding: 40px 32px;
  background: #fff;
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
