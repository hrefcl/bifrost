<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { AxiosError } from 'axios';
import { api } from '@/lib/http';

/** Panel admin de política de firmas (firmas F6). /api/admin/config/signature-policy (gate branding.manage). */
const { t } = useI18n();

interface Tpl {
  id: string;
  nameKey: string;
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
    const { data } = await api.get<{ policy: Policy; templates: Tpl[] }>(
      '/admin/config/signature-policy'
    );
    policy.value = data.policy;
    templates.value = data.templates;
  } catch {
    error.value = t('admin.signatures.errLoad');
  } finally {
    loading.value = false;
  }
}

function toggleAllowed(id: string) {
  saved.value = false;
  const arr = policy.value.allowedTemplateIds;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
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
    <div v-else class="sigpol-form" @change="saved = false">
      <div class="block">
        <h3>{{ t('admin.signatures.allowed') }}</h3>
        <p class="hint">{{ t('admin.signatures.allowedHint') }}</p>
        <div class="tpl-list">
          <label v-for="tpl in templates" :key="tpl.id" class="tpl-check">
            <input
              type="checkbox"
              :checked="policy.allowedTemplateIds.includes(tpl.id)"
              @change="toggleAllowed(tpl.id)"
            />
            {{ t(tpl.nameKey) }}
          </label>
        </div>
      </div>

      <label class="opt">
        <input v-model="policy.lockTemplate" type="checkbox" />
        <span>
          <strong>{{ t('admin.signatures.lockTemplate') }}</strong>
          <span class="hint">{{ t('admin.signatures.lockTemplateHint') }}</span>
        </span>
      </label>
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
.sigpol-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 560px;
}
.block h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 700;
}
.hint {
  font-size: 12.5px;
  color: var(--text-3);
  display: block;
}
.tpl-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}
.tpl-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.tpl-check input {
  accent-color: var(--accent);
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
