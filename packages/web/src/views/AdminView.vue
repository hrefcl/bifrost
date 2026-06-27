<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { AxiosError } from 'axios';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import { api } from '@/lib/http';

/**
 * Panel de administración — Paso 1: almacenamiento de adjuntos.
 *
 * El backend (`/api/admin/config/storage`) exige rol admin. Soporta `local` (sin config) y
 * `s3` (endpoint opcional + bucket/region/keys; el secret se cifra server-side y nunca vuelve).
 * El secret NO se pre-rellena al editar: si ya está configurado, hay que re-ingresarlo para
 * guardar cambios (el backend lo exige).
 */
type ProviderType = 'local' | 's3';

interface PublicS3 {
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretConfigured: boolean;
}

interface StorageConfig {
  providerType: ProviderType;
  s3?: PublicS3;
  updatedBy?: string;
  updatedAt?: string;
}

const { t, locale } = useI18n();

/** Fecha legible y localizada (en vez del ISO crudo — review D). */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' });
}

const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');
const selected = ref<ProviderType>('local');
const current = ref<StorageConfig | null>(null);

// Formulario S3 (el secret nunca llega del backend; arranca vacío).
const s3 = ref({ endpoint: '', bucket: '', region: '', accessKeyId: '', secretAccessKey: '' });
const secretAlreadyConfigured = ref(false);

onMounted(async () => {
  try {
    const { data } = await api.get<StorageConfig>('/admin/config/storage');
    current.value = data;
    selected.value = data.providerType;
    if (data.s3) {
      s3.value.endpoint = data.s3.endpoint ?? '';
      s3.value.bucket = data.s3.bucket;
      s3.value.region = data.s3.region;
      s3.value.accessKeyId = data.s3.accessKeyId;
      secretAlreadyConfigured.value = data.s3.secretConfigured;
    }
  } catch {
    error.value = t('admin.errLoad');
  } finally {
    loading.value = false;
  }
});

function choose(provider: ProviderType) {
  selected.value = provider;
  saved.value = false;
  error.value = '';
  tested.value = null; // el resultado de "Probar conexión" no aplica al nuevo provider.
  // Defensa en profundidad: no retener el secret si el admin se va de S3 sin guardar.
  if (provider !== 's3') s3.value.secretAccessKey = '';
}

/** Limpia el "Guardado"/error/resultado-de-test previo al editar los campos (input handler). */
function clearStatus() {
  saved.value = false;
  error.value = '';
  tested.value = null;
}

/** Faltan datos obligatorios para guardar S3 (el secret SIEMPRE se exige al guardar). */
function s3Incomplete(): boolean {
  return (
    selected.value === 's3' &&
    (!s3.value.bucket.trim() ||
      !s3.value.region.trim() ||
      !s3.value.accessKeyId.trim() ||
      !s3.value.secretAccessKey)
  );
}

/** Objeto S3 con los campos del form (endpoint omitido si vacío). */
function s3Payload() {
  return {
    ...(s3.value.endpoint.trim() ? { endpoint: s3.value.endpoint.trim() } : {}),
    bucket: s3.value.bucket.trim(),
    region: s3.value.region.trim(),
    accessKeyId: s3.value.accessKeyId.trim(),
    secretAccessKey: s3.value.secretAccessKey,
  };
}

const testing = ref(false);
const tested = ref<'ok' | 'fail' | null>(null);

/** Prueba la conexión S3 sin persistir (round-trip real en el backend). Feedback ✓/✗. */
async function testConnection() {
  testing.value = true;
  tested.value = null;
  error.value = '';
  try {
    await api.post('/admin/config/storage/test', s3Payload());
    tested.value = 'ok';
  } catch {
    tested.value = 'fail';
  } finally {
    testing.value = false;
  }
}

async function save() {
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    const payload =
      selected.value === 's3'
        ? { providerType: 's3' as const, s3: s3Payload() }
        : { providerType: 'local' as const };
    const { data } = await api.patch<StorageConfig>('/admin/config/storage', payload);
    current.value = data;
    selected.value = data.providerType;
    if (data.s3) secretAlreadyConfigured.value = data.s3.secretConfigured;
    s3.value.secretAccessKey = ''; // no retener el secret en memoria tras guardar
    saved.value = true;
  } catch (err) {
    // 400 = datos S3 inválidos (endpoint/region/campos rechazados por el backend).
    if (err instanceof AxiosError && err.response?.status === 400) {
      error.value = t('admin.errInvalid');
    } else {
      error.value = t('admin.errSave');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppLayout>
    <div class="admin">
      <div class="admin-inner">
        <h1 class="admin-title">{{ t('admin.title') }}</h1>
        <p class="admin-step">{{ t('admin.step') }}</p>

        <div class="card">
          <h2 class="card-h">{{ t('admin.question') }}</h2>
          <p class="card-desc">{{ t('admin.questionDesc') }}</p>

          <p v-if="loading" class="muted">{{ t('common.loading') }}</p>

          <div v-else class="options">
            <!-- LOCAL -->
            <label class="option" :class="{ active: selected === 'local' }">
              <input
                type="radio"
                name="provider"
                value="local"
                :checked="selected === 'local'"
                @change="choose('local')"
              />
              <span class="option-body">
                <span class="option-title">
                  {{ t('admin.localTitle') }}
                  <span class="badge ok">{{ t('admin.available') }}</span>
                </span>
                <span class="option-desc">{{ t('admin.localDesc') }}</span>
              </span>
            </label>

            <!-- S3 -->
            <label class="option" :class="{ active: selected === 's3' }">
              <input
                type="radio"
                name="provider"
                value="s3"
                :checked="selected === 's3'"
                @change="choose('s3')"
              />
              <span class="option-body">
                <span class="option-title">
                  {{ t('admin.s3Title') }}
                  <span class="badge ok">{{ t('admin.available') }}</span>
                </span>
                <span class="option-desc">{{ t('admin.s3Desc') }}</span>
              </span>
            </label>

            <!-- Campos S3. @input descarta el "Guardado"/error previo al editar. -->
            <div v-if="selected === 's3'" class="s3-fields" @input="clearStatus">
              <label class="fld-lbl">{{ t('admin.endpoint') }}</label>
              <input
                v-model="s3.endpoint"
                class="adminput"
                placeholder="https://s3.amazonaws.com · http://minio:9000"
              />
              <label class="fld-lbl">{{ t('admin.bucket') }}</label>
              <input v-model="s3.bucket" class="adminput" placeholder="mi-bucket" />
              <label class="fld-lbl">{{ t('admin.region') }}</label>
              <input v-model="s3.region" class="adminput" placeholder="us-east-1" />
              <label class="fld-lbl">{{ t('admin.accessKeyId') }}</label>
              <input v-model="s3.accessKeyId" class="adminput" placeholder="AKIA…" />
              <label class="fld-lbl">
                {{ t('admin.secret') }}
                <span v-if="secretAlreadyConfigured" class="fld-hint">{{
                  t('admin.secretConfigured')
                }}</span>
              </label>
              <input
                v-model="s3.secretAccessKey"
                type="password"
                class="adminput"
                :placeholder="
                  secretAlreadyConfigured ? t('admin.secretPlaceholderSet') : t('admin.secret')
                "
                autocomplete="new-password"
              />
            </div>

            <div class="actions">
              <button
                v-if="selected === 's3'"
                class="btn-secondary"
                :disabled="testing || s3Incomplete()"
                @click="testConnection"
              >
                {{ testing ? t('admin.testing') : t('admin.test') }}
              </button>
              <span v-if="tested === 'ok'" class="ok-text">{{ t('admin.testOk') }}</span>
              <span v-if="tested === 'fail'" class="err-text">{{ t('admin.testFail') }}</span>
              <button class="btn-primary" :disabled="saving || s3Incomplete()" @click="save">
                {{ saving ? t('admin.saving') : t('admin.save') }}
              </button>
              <span v-if="saved" class="ok-text">{{ t('admin.saved') }}</span>
              <span v-if="error" class="err-text">{{ error }}</span>
            </div>

            <p v-if="selected === 's3' && tested !== 'ok' && !s3Incomplete()" class="warn-text">
              {{ t('admin.testHint') }}
            </p>
            <p v-if="current?.updatedAt" class="current" data-testid="storage-current">
              {{
                t('admin.current', {
                  provider: current.providerType,
                  date: fmtDate(current.updatedAt),
                })
              }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.admin {
  height: 100%;
  overflow-y: auto;
  background: var(--surface);
}
.admin-inner {
  max-width: 640px;
  margin: 0 auto;
  padding: 28px 32px;
}
.admin-title {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 2px;
}
.admin-step {
  font-size: 13px;
  color: var(--text-3);
  margin: 0 0 22px;
}
.card {
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 24px;
  background: var(--bg);
}
.card-h {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 4px;
}
.card-desc {
  font-size: 13.5px;
  color: var(--text-3);
  line-height: 1.5;
  margin: 0 0 18px;
}
.muted {
  font-size: 14px;
  color: var(--text-3);
}
.options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  transition:
    border-color 0.12s,
    box-shadow 0.12s;
}
.option.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.option input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.option-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.option-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.option-desc {
  font-size: 13px;
  color: var(--text-3);
  line-height: 1.5;
}
.badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 5px;
}
.badge.ok {
  color: #16a34a;
  background: color-mix(in srgb, #16a34a 14%, transparent);
}
.s3-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  border-radius: 10px;
  background: var(--surface-dim);
  border: 1px solid var(--border);
}
.fld-lbl {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  margin-top: 6px;
}
.fld-hint {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-3);
  margin-left: 4px;
}
.adminput {
  width: 100%;
  padding: 9px 12px;
  font: inherit;
  font-size: 13.5px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-1);
  outline: none;
}
.adminput:focus {
  border-color: var(--accent);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding-top: 6px;
}
.btn-primary {
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
.btn-primary:hover:not(:disabled) {
  background: var(--accent-700);
}
.btn-secondary {
  padding: 9px 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
}
.btn-secondary:hover:not(:disabled) {
  background: var(--hover);
}
.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: 0.55;
  cursor: default;
}
.ok-text {
  font-size: 13.5px;
  color: #16a34a;
  font-weight: 600;
}
.err-text {
  font-size: 13.5px;
  color: var(--danger);
}
.warn-text {
  font-size: 12px;
  color: #d97706;
  margin: 8px 0 0;
}
.current {
  font-size: 12px;
  color: var(--text-3);
  margin: 8px 0 0;
}
</style>
