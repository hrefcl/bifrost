<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { AxiosError } from 'axios';
import { api } from '@/lib/http';

/**
 * Panel admin de firmas (F6) — GALERÍA VISUAL: la empresa VE cada diseño (preview real renderizado
 * server-side, mismo pipeline que el envío) y elige el estándar. /api/admin/config/signature-policy
 * (+ /signature-previews), gate branding.manage. El `v-html` va sobre HTML ya saneado por el backend.
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

const templates = ref<Tpl[]>([]);
const policy = ref<Policy>({
  allowedTemplateIds: [],
  lockTemplate: false,
  enforceSignature: false,
  allowCustomHtml: true,
});
const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [pol, prev] = await Promise.all([
      api.get<{ policy: Policy; templates: { id: string; nameKey: string }[] }>(
        '/admin/config/signature-policy'
      ),
      api.get<{ previews: Tpl[] }>('/admin/config/signature-previews'),
    ]);
    policy.value = pol.data.policy;
    // Merge: metadata del catálogo + html del preview (por id).
    const htmlById = new Map(prev.data.previews.map((p) => [p.id, p.html]));
    templates.value = pol.data.templates.map((tp) => ({
      ...tp,
      html: htmlById.get(tp.id) ?? '',
    }));
  } catch {
    error.value = t('admin.signatures.errLoad');
  } finally {
    loading.value = false;
  }
}

function isSelected(id: string): boolean {
  return policy.value.allowedTemplateIds.includes(id);
}

/** Click en una tarjeta: en modo estándar único, la fija; en modo elección, la habilita/deshabilita. */
function pick(id: string) {
  saved.value = false;
  if (policy.value.lockTemplate) {
    policy.value.allowedTemplateIds = [id];
  } else {
    const arr = policy.value.allowedTemplateIds;
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(id);
  }
}

/** Cambia el modo. Al pasar a "estándar único" deja sólo la primera habilitada (o ninguna). */
function setLock(v: boolean) {
  saved.value = false;
  policy.value.lockTemplate = v;
  if (v && policy.value.allowedTemplateIds.length > 1) {
    policy.value.allowedTemplateIds = [policy.value.allowedTemplateIds[0]];
  }
}

async function save() {
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
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
  <div class="sigpol">
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <div v-else>
      <!-- Modo: estándar único vs. cada usuario elige -->
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

      <!-- Galería de diseños con preview real -->
      <div class="gallery">
        <button
          v-for="tpl in templates"
          :key="tpl.id"
          type="button"
          class="card"
          :class="{ active: isSelected(tpl.id) }"
          @click="pick(tpl.id)"
        >
          <div class="preview-wrap">
            <!-- HTML saneado en el backend (sanitizeEmailHtml, mismo pipeline que el envío) -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="preview" v-html="tpl.html"></div>
          </div>
          <div class="card-foot">
            <span class="name">{{ t(tpl.nameKey) }}</span>
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

      <!-- Reglas de empresa -->
      <div class="opts" @change="saved = false">
        <label class="opt">
          <input v-model="policy.enforceSignature" type="checkbox" />
          <span>
            <strong>{{ t('admin.signatures.enforce') }}</strong>
            <span class="hint">{{ t('admin.signatures.enforceHint') }}</span>
          </span>
        </label>
        <label class="opt">
          <input v-model="policy.allowCustomHtml" type="checkbox" />
          <span>
            <strong>{{ t('admin.signatures.allowCustom') }}</strong>
            <span class="hint">{{ t('admin.signatures.allowCustomHint') }}</span>
          </span>
        </label>
      </div>

      <div class="actions">
        <button class="btn" :disabled="saving" @click="save">
          {{ saving ? t('admin.saving') : t('admin.save') }}
        </button>
        <span v-if="saved" class="ok">{{ t('admin.saved') }}</span>
        <span v-if="error" class="err">{{ error }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.muted {
  color: var(--text-3);
}
.modebar {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}
.mode {
  flex: 1 1 260px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
}
.mode.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
.mode input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.mode strong {
  display: block;
  font-size: 13.5px;
}
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
  margin-bottom: 22px;
}
.card {
  text-align: left;
  padding: 0;
  background: #fff;
  border: 2px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  font: inherit;
  transition:
    border-color 0.12s,
    box-shadow 0.12s;
}
.card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
}
.preview-wrap {
  height: 150px;
  overflow: hidden;
  background: #fff;
  padding: 16px;
  display: flex;
  align-items: center;
}
.preview {
  transform: scale(0.82);
  transform-origin: left center;
}
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: #fafbfc;
}
.name {
  font-size: 13.5px;
  font-weight: 600;
}
.badge {
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  padding: 2px 9px;
  border-radius: 999px;
}
.opts {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 20px;
  max-width: 560px;
}
.opt {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  cursor: pointer;
}
.opt input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.opt strong {
  display: block;
  font-size: 13.5px;
}
.hint {
  font-size: 12.5px;
  color: var(--text-3);
  display: block;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
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
  font-size: 13.5px;
}
.err {
  color: var(--danger);
  font-size: 13.5px;
}
</style>
