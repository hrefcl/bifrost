<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
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
  appStoreUrl: '',
  googlePlayUrl: '',
});

// ── Estilo componible (tab Estilo, "biblia"): tipografía, foto, alineación, separador, campos + orden ──
type FieldKey =
  | 'photo'
  | 'name'
  | 'title'
  | 'company'
  | 'phone'
  | 'email'
  | 'website'
  | 'address'
  | 'tagline'
  | 'social';
const FONTS = ['Arial', 'Helvetica', 'Georgia', 'Verdana', 'Trebuchet', 'Tahoma'];
const SEPS = ['·', '|', '–', ''];
const STACK_DEFAULT: FieldKey[] = [
  'name',
  'title',
  'company',
  'phone',
  'email',
  'website',
  'address',
  'tagline',
  'social',
];
// Campos que NO se pueden ocultar (siempre visibles): nombre y cargo.
const ALWAYS_ON: FieldKey[] = ['name', 'title'];
// Etiqueta i18n del campo (review D: no hardcodear español; el UI puede estar en inglés).
const fieldLabel = (f: FieldKey) => t(`admin.signatures.field.${f}`);

const sig = ref<{
  fontFamily: string;
  photoSizePx: number;
  align: 'left' | 'center';
  separator: string;
  hidden: FieldKey[];
  order: FieldKey[];
  socialAsIcons: boolean;
  logoWidthPx: number;
  logoAlign: 'left' | 'center' | 'right';
  logoPaddingPx: number;
  photoPaddingPx: number;
}>({
  fontFamily: 'Arial',
  photoSizePx: 68,
  align: 'left',
  separator: '·',
  hidden: [],
  order: [...STACK_DEFAULT],
  socialAsIcons: true,
  logoWidthPx: 130,
  logoAlign: 'left',
  logoPaddingPx: 0,
  photoPaddingPx: 0,
});
function setLogoAlign(a: 'left' | 'center' | 'right') {
  saved.value = false;
  sig.value.logoAlign = a;
}

const isFieldOn = (f: FieldKey) => !sig.value.hidden.includes(f);
function toggleField(f: FieldKey) {
  if (ALWAYS_ON.includes(f)) return; // nombre/cargo no se ocultan
  saved.value = false;
  const i = sig.value.hidden.indexOf(f);
  if (i >= 0) sig.value.hidden.splice(i, 1);
  else sig.value.hidden.push(f);
}
function setFont(f: string) {
  saved.value = false;
  sig.value.fontFamily = f;
}
function setAlign(a: 'left' | 'center') {
  saved.value = false;
  sig.value.align = a;
}
function setSep(s: string) {
  saved.value = false;
  sig.value.separator = s;
}

// Drag & drop del orden de campos (HTML5 nativo, sin dependencia).
const dragIndex = ref(-1);
const dragOverIndex = ref(-1);
function onDragStart(i: number) {
  dragIndex.value = i;
}
function onDragEnter(i: number) {
  if (dragIndex.value >= 0) dragOverIndex.value = i;
}
function onDragEnd() {
  // Limpia el estado aunque el usuario cancele el drag (Esc / soltar afuera) — review D.
  dragIndex.value = -1;
  dragOverIndex.value = -1;
}
function onDrop(i: number) {
  const from = dragIndex.value;
  onDragEnd();
  if (from < 0 || from === i) return;
  saved.value = false;
  const arr = sig.value.order;
  const [moved] = arr.splice(from, 1);
  arr.splice(i, 0, moved);
}
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
        appStoreUrl: string | null;
        googlePlayUrl: string | null;
        signatureStyle: {
          fontFamily?: string;
          photoSizePx?: number;
          align?: 'left' | 'center';
          separator?: string;
          hidden?: FieldKey[];
          order?: FieldKey[];
          socialAsIcons?: boolean;
          logoWidthPx?: number;
          logoAlign?: 'left' | 'center' | 'right';
          logoPaddingPx?: number;
          photoPaddingPx?: number;
        } | null;
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
      appStoreUrl: brand.data.appStoreUrl ?? '',
      googlePlayUrl: brand.data.googlePlayUrl ?? '',
    };
    const st = brand.data.signatureStyle;
    if (st) {
      // Orden guardado + cualquier campo nuevo del catálogo al final (robusto a versiones).
      const ord = (st.order ?? []).filter((k) => STACK_DEFAULT.includes(k));
      const order = [...ord, ...STACK_DEFAULT.filter((k) => !ord.includes(k))];
      sig.value = {
        fontFamily: st.fontFamily ?? 'Arial',
        photoSizePx: Math.min(Math.max(st.photoSizePx ?? 68, 24), 160), // acota al rango del slider

        align: st.align ?? 'left',
        separator: st.separator ?? '·',
        hidden: (st.hidden ?? []).filter((k) => !ALWAYS_ON.includes(k)),
        order,
        socialAsIcons: st.socialAsIcons ?? true,
        logoWidthPx: Math.min(Math.max(st.logoWidthPx ?? 130, 40), 400),
        logoAlign: st.logoAlign ?? 'left',
        logoPaddingPx: Math.min(Math.max(st.logoPaddingPx ?? 0, 0), 60),
        photoPaddingPx: Math.min(Math.max(st.photoPaddingPx ?? 0, 0), 60),
      };
    }
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
  // Validar el tamaño REAL ANTES de leer (review B: un archivo grande congelaba la pestaña leyéndolo
  // entero; review D-005: usar file.size evita la discrepancia de cálculo cliente/servidor).
  if (file.size > LOGO_MAX) {
    error.value = t('admin.branding.errSize');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => {
    error.value = t('admin.branding.errType'); // review D-010: feedback si la lectura falla
  };
  reader.onload = () => {
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl) return;
    if (kind === 'h') estilo.value.logoDataUrl = dataUrl;
    else estilo.value.logoVerticalDataUrl = dataUrl;
  };
  reader.readAsDataURL(file);
}

/** Quita un logo y marca cambios pendientes (review B-LOW: quitar no marcaba saved=false). */
function clearLogo(kind: 'h' | 'v') {
  saved.value = false;
  if (kind === 'h') estilo.value.logoDataUrl = '';
  else estilo.value.logoVerticalDataUrl = '';
}

// Preview grande EN VIVO (debounced): rendiza el template seleccionado con el estilo sin guardar.
let previewTimer: ReturnType<typeof setTimeout> | undefined;
// Contador monotónico: sólo aplica la respuesta de la petición MÁS reciente → una respuesta vieja no
// pisa una nueva (review B/C/D: race de preview sin cancelación).
let previewSeq = 0;
async function refreshPreview() {
  if (!selectedId.value) return;
  const seq = ++previewSeq;
  try {
    const { data } = await api.post<{ html: string }>('/admin/config/signature-preview', {
      templateId: selectedId.value,
      accentColor: estilo.value.accentColor,
      companyName: estilo.value.companyName,
      tagline: estilo.value.tagline,
      logoDataUrl: estilo.value.logoDataUrl,
      logoVerticalDataUrl: estilo.value.logoVerticalDataUrl,
      appStoreUrl: estilo.value.appStoreUrl,
      googlePlayUrl: estilo.value.googlePlayUrl,
      signatureStyle: sig.value,
    });
    if (seq === previewSeq) previewHtml.value = data.html; // ignora respuestas stale
  } catch {
    /* preview best-effort */
  }
}
watch(
  [selectedId, estilo, sig],
  () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void refreshPreview(), 350);
  },
  { deep: true }
);
// Limpieza al desmontar (review B-LOW: el debounce podía disparar una request tardía).
onBeforeUnmount(() => {
  clearTimeout(previewTimer);
  previewSeq++; // invalida cualquier respuesta en vuelo
});

const canSave = computed(
  () => !policy.value.lockTemplate || policy.value.allowedTemplateIds.length > 0
);

/** Re-carga las miniaturas con el branding recién guardado (review C-L2/D-007: galería quedaba stale). */
async function reloadPreviews() {
  try {
    const { data } = await api.get<{ previews: Tpl[] }>('/admin/config/signature-previews');
    const htmlById = new Map(data.previews.map((p) => [p.id, p.html]));
    templates.value = templates.value.map((tp) => ({
      ...tp,
      html: htmlById.get(tp.id) ?? tp.html,
    }));
  } catch {
    /* best-effort */
  }
}

async function save() {
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    // Guardado COMBINADO atómico-first (review B/C/D M1): un solo endpoint valida la política ANTES de
    // escribir el branding → si algo falla, no queda branding aplicado con la política sin guardar.
    const { data } = await api.put<{ policy: Policy }>('/admin/config/signature-settings', {
      branding: {
        accentColor: estilo.value.accentColor,
        companyName: estilo.value.companyName,
        tagline: estilo.value.tagline,
        logoDataUrl: estilo.value.logoDataUrl, // '' limpia
        logoVerticalDataUrl: estilo.value.logoVerticalDataUrl,
        appStoreUrl: estilo.value.appStoreUrl,
        googlePlayUrl: estilo.value.googlePlayUrl,
        signatureStyle: sig.value,
      },
      policy: policy.value,
    });
    policy.value = data.policy;
    saved.value = true;
    await reloadPreviews();
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
              <span>
                <strong>{{ t('admin.signatures.modeChoose') }}</strong>
                <span class="hint">{{ t('admin.signatures.modeChooseHint') }}</span>
              </span>
            </label>
            <label class="mode" :class="{ on: policy.lockTemplate }">
              <input type="radio" :checked="policy.lockTemplate" @change="setLock(true)" />
              <span>
                <strong>{{ t('admin.signatures.modeStandard') }}</strong>
                <span class="hint">{{ t('admin.signatures.modeStandardHint') }}</span>
              </span>
            </label>
          </div>
          <!-- Aclara la semántica de allowedTemplateIds vacío (review B-MEDIUM v2). -->
          <p v-if="policy.lockTemplate && policy.allowedTemplateIds.length === 0" class="hint warn">
            {{ t('admin.signatures.pickStandardHint') }}
          </p>
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

          <!-- TIPOGRAFÍA -->
          <div class="ctl">
            <span class="ctl-h">{{ t('admin.signatures.styleFont') }}</span>
            <div class="chips">
              <button
                v-for="f in FONTS"
                :key="f"
                type="button"
                class="chip"
                :class="{ on: sig.fontFamily === f }"
                @click="setFont(f)"
              >
                {{ f }}
              </button>
            </div>
          </div>

          <!-- TAMAÑO DE FOTO -->
          <div class="ctl">
            <span class="ctl-h"
              >{{ t('admin.signatures.stylePhoto') }}
              <b class="val">{{ sig.photoSizePx }} px</b></span
            >
            <input
              v-model.number="sig.photoSizePx"
              type="range"
              min="24"
              max="160"
              class="range"
              @input="saved = false"
            />
          </div>

          <!-- PADDING DE FOTO -->
          <div class="ctl">
            <span class="ctl-h"
              >{{ t('admin.signatures.stylePhotoPad') }}
              <b class="val">{{ sig.photoPaddingPx }} px</b></span
            >
            <input
              v-model.number="sig.photoPaddingPx"
              type="range"
              min="0"
              max="60"
              class="range"
              @input="saved = false"
            />
          </div>

          <!-- LOGO: tamaño, alineación, padding -->
          <div class="ctl">
            <span class="ctl-h"
              >{{ t('admin.signatures.styleLogoSize') }}
              <b class="val">{{ sig.logoWidthPx }} px</b></span
            >
            <input
              v-model.number="sig.logoWidthPx"
              type="range"
              min="40"
              max="400"
              class="range"
              @input="saved = false"
            />
          </div>
          <div class="ctl">
            <span class="ctl-h">{{ t('admin.signatures.styleLogoAlign') }}</span>
            <div class="chips">
              <button
                v-for="a in ['left', 'center', 'right'] as const"
                :key="a"
                type="button"
                class="chip"
                :class="{ on: sig.logoAlign === a }"
                @click="setLogoAlign(a)"
              >
                {{ t('admin.signatures.align' + a[0].toUpperCase() + a.slice(1)) }}
              </button>
            </div>
          </div>
          <div class="ctl">
            <span class="ctl-h"
              >{{ t('admin.signatures.styleLogoPad') }}
              <b class="val">{{ sig.logoPaddingPx }} px</b></span
            >
            <input
              v-model.number="sig.logoPaddingPx"
              type="range"
              min="0"
              max="60"
              class="range"
              @input="saved = false"
            />
          </div>

          <!-- ALINEACIÓN -->
          <div class="ctl">
            <span class="ctl-h">{{ t('admin.signatures.styleAlign') }}</span>
            <div class="chips two">
              <button
                type="button"
                class="chip"
                :class="{ on: sig.align === 'left' }"
                @click="setAlign('left')"
              >
                {{ t('admin.signatures.alignLeft') }}
              </button>
              <button
                type="button"
                class="chip"
                :class="{ on: sig.align === 'center' }"
                @click="setAlign('center')"
              >
                {{ t('admin.signatures.alignCenter') }}
              </button>
            </div>
          </div>

          <!-- SEPARADOR -->
          <div class="ctl">
            <span class="ctl-h">{{ t('admin.signatures.styleSep') }}</span>
            <div class="chips">
              <button
                v-for="s in SEPS"
                :key="s"
                type="button"
                class="chip sep"
                :class="{ on: sig.separator === s }"
                @click="setSep(s)"
              >
                {{ s || 'ø' }}
              </button>
            </div>
          </div>

          <!-- MOSTRAR Y ORDENAR CAMPOS (drag & drop) -->
          <div class="ctl">
            <span class="ctl-h">{{ t('admin.signatures.styleFields') }}</span>
            <p class="hint">{{ t('admin.signatures.styleFieldsHint') }}</p>
            <!-- Foto: no va en el stack ordenable (su posición la define el diseño), sólo mostrar/ocultar. -->
            <div class="frow static">
              <span class="grip ghost">⋮⋮</span>
              <span class="fname">{{ fieldLabel('photo') }}</span>
              <label class="sw">
                <input
                  type="checkbox"
                  :checked="isFieldOn('photo')"
                  @change="toggleField('photo')"
                />
                <span class="track"></span>
              </label>
            </div>
            <ul class="fields">
              <li
                v-for="(f, i) in sig.order"
                :key="f"
                class="frow"
                :class="{ dragging: dragIndex === i, over: dragOverIndex === i && dragIndex !== i }"
                draggable="true"
                @dragstart="onDragStart(i)"
                @dragenter="onDragEnter(i)"
                @dragover.prevent
                @drop.prevent="onDrop(i)"
                @dragend="onDragEnd"
              >
                <span class="grip">⋮⋮</span>
                <span class="fname">{{ fieldLabel(f) }}</span>
                <label class="sw" :class="{ locked: ALWAYS_ON.includes(f) }">
                  <input
                    type="checkbox"
                    :checked="isFieldOn(f)"
                    :disabled="ALWAYS_ON.includes(f)"
                    @change="toggleField(f)"
                  />
                  <span class="track"></span>
                </label>
              </li>
            </ul>
            <div class="frow static">
              <span class="grip ghost">⋮⋮</span>
              <span class="fname">{{ t('admin.signatures.fieldSocialIcons') }}</span>
              <label class="sw">
                <input v-model="sig.socialAsIcons" type="checkbox" @change="saved = false" />
                <span class="track"></span>
              </label>
            </div>
          </div>

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
              <button v-if="estilo.logoDataUrl" class="lnk" @click="clearLogo('h')">
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
              <button v-if="estilo.logoVerticalDataUrl" class="lnk" @click="clearLogo('v')">
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
/* Habilitada (elegible por el equipo) vs. seleccionada/activa (la que se previsualiza) — review D-006. */
.card.on {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
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
.ctl {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ctl-h {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.ctl-h .val {
  color: var(--accent);
  float: right;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chips.two .chip {
  flex: 1;
}
.chip {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  background: #fff;
  font: inherit;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.chip.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent);
}
.chip.sep {
  min-width: 44px;
  text-align: center;
  font-size: 16px;
}
.range {
  width: 100%;
  accent-color: var(--accent);
}
.fields {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.frow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
}
.frow[draggable='true'] {
  cursor: grab;
}
.frow.dragging {
  opacity: 0.4;
}
.frow.over {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.grip {
  color: var(--text-3);
  font-size: 13px;
  letter-spacing: -2px;
  cursor: grab;
  user-select: none;
}
.grip.ghost {
  visibility: hidden;
}
.fname {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
}
.sw {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 22px;
  cursor: pointer;
  flex: none;
}
.sw.locked {
  opacity: 0.45;
  cursor: not-allowed;
}
.sw input {
  opacity: 0;
  width: 0;
  height: 0;
}
.sw .track {
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 999px;
  transition: 0.15s;
}
.sw .track::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 3px;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  transition: 0.15s;
}
.sw input:checked + .track {
  background: var(--accent);
}
.sw input:checked + .track::before {
  transform: translateX(16px);
}
.hint {
  font-size: 12px;
  color: var(--text-3);
}
.hint.warn {
  color: var(--danger);
  margin-top: 8px;
}
.mode {
  align-items: flex-start;
}
.mode strong {
  display: block;
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
