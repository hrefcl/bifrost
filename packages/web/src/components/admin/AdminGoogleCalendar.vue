<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import AppIcon from '@/components/AppIcon.vue';
import { api } from '@/lib/http';

/**
 * Config admin de las credenciales OAuth de Google Calendar (F-gcal admin-config). El admin pega
 * Client ID / Secret / Redirect URI; el secret se guarda cifrado en el backend y NUNCA vuelve por la API
 * (patrón "reingresá para cambiar"). Incluye guía paso a paso con links a Google Cloud Console.
 */
const { t } = useI18n();

interface GcalSettings {
  clientId: string;
  redirectUri: string;
  hasClientSecret: boolean;
  source: 'db' | 'env' | 'error' | 'none';
}

const loading = ref(true);
const saving = ref(false);
const error = ref('');
const saved = ref(false);
const source = ref<GcalSettings['source']>('none');
const hasSecret = ref(false);

const clientId = ref('');
const redirectUri = ref('');
const clientSecret = ref(''); // vacío = no cambiar

/** Redirect URI sugerido si no hay ninguno configurado (para que el admin lo registre en Google). */
const suggestedRedirect = `${window.location.origin}/api/calendar/google/callback`;
const copied = ref(false);

const sourceLabel = computed(() => {
  switch (source.value) {
    case 'db':
      return t('admin.gcal.sourceDb');
    case 'env':
      return t('admin.gcal.sourceEnv');
    case 'error':
      return t('admin.gcal.sourceError');
    default:
      return t('admin.gcal.sourceNone');
  }
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get<{ settings: GcalSettings }>('/admin/google-calendar/settings');
    const s = data.settings;
    source.value = s.source;
    hasSecret.value = s.hasClientSecret;
    clientId.value = s.clientId;
    redirectUri.value = s.redirectUri || suggestedRedirect;
    clientSecret.value = '';
  } catch {
    error.value = t('admin.gcal.errLoad');
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = '';
  saved.value = false;
  try {
    const payload: Record<string, string> = {
      clientId: clientId.value.trim(),
      redirectUri: redirectUri.value.trim(),
    };
    // El secret sólo se manda si el admin escribió algo (vacío = preservar el actual).
    if (clientSecret.value !== '') payload.clientSecret = clientSecret.value;
    await api.patch('/admin/google-calendar/settings', payload);
    saved.value = true;
    await load();
  } catch (e) {
    const err = e as { response?: { data?: { message?: string } } };
    error.value = err.response?.data?.message ?? t('admin.gcal.errSave');
  } finally {
    saving.value = false;
  }
}

/** Limpia toda la config (borra el secret y vuelve a "no configurado"). */
async function disconnect(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    await api.patch('/admin/google-calendar/settings', { clientId: '', redirectUri: '', clientSecret: '' });
    await load();
  } catch {
    error.value = t('admin.gcal.errSave');
  } finally {
    saving.value = false;
  }
}

async function copyRedirect(): Promise<void> {
  try {
    await navigator.clipboard.writeText(redirectUri.value || suggestedRedirect);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard no disponible */
  }
}

onMounted(load);
</script>

<template>
  <div class="card gcal">
    <div v-if="loading" class="gcal-loading">{{ t('common.loading') }}</div>

    <template v-else>
      <p class="gcal-status" :class="`src-${source}`">
        <AppIcon :name="source === 'db' || source === 'env' ? 'check' : 'globe'" :size="15" />
        <span>{{ sourceLabel }}</span>
      </p>

      <!-- Guía paso a paso -->
      <details class="gcal-guide">
        <summary>{{ t('admin.gcal.guideTitle') }}</summary>
        <ol>
          <li>
            {{ t('admin.gcal.guide1') }}
            <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">
              console.cloud.google.com <AppIcon name="externalLink" :size="12" />
            </a>
          </li>
          <li>
            <strong>{{ t('admin.gcal.guideEnableApi') }}</strong>
            <a
              href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google Calendar API → Enable <AppIcon name="externalLink" :size="12" />
            </a>
          </li>
          <li>
            {{ t('admin.gcal.guide2') }}
            <a
              href="https://console.cloud.google.com/apis/credentials/consent"
              target="_blank"
              rel="noopener noreferrer"
            >
              OAuth consent screen <AppIcon name="externalLink" :size="12" />
            </a>
          </li>
          <li>
            {{ t('admin.gcal.guide3') }}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
            >
              Credentials → Create OAuth client ID <AppIcon name="externalLink" :size="12" />
            </a>
          </li>
          <li>{{ t('admin.gcal.guide4') }} <code>{{ redirectUri || suggestedRedirect }}</code></li>
          <li>{{ t('admin.gcal.guide5') }}</li>
        </ol>
      </details>

      <!-- Redirect URI (a copiar en Google) -->
      <label class="gcal-field">
        <span class="gcal-label">{{ t('admin.gcal.redirectUri') }}</span>
        <div class="gcal-redirect">
          <input v-model="redirectUri" type="text" class="gcal-input" spellcheck="false" />
          <button type="button" class="gcal-copy" :title="t('common.copy')" @click="copyRedirect">
            <AppIcon :name="copied ? 'check' : 'copy'" :size="15" />
          </button>
        </div>
        <small class="gcal-hint">{{ t('admin.gcal.redirectHint') }}</small>
      </label>

      <!-- Client ID -->
      <label class="gcal-field">
        <span class="gcal-label">{{ t('admin.gcal.clientId') }}</span>
        <input v-model="clientId" type="text" class="gcal-input" spellcheck="false" autocomplete="off" />
      </label>

      <!-- Client Secret (patrón reingresá-para-cambiar) -->
      <label class="gcal-field">
        <span class="gcal-label">
          {{ t('admin.gcal.clientSecret') }}
          <em v-if="hasSecret" class="gcal-configured">{{ t('admin.secretConfigured') }}</em>
        </span>
        <input
          v-model="clientSecret"
          type="password"
          class="gcal-input"
          autocomplete="new-password"
          :placeholder="hasSecret ? t('admin.secretPlaceholderSet') : ''"
        />
      </label>

      <p v-if="error" class="gcal-msg err" role="alert">{{ error }}</p>
      <p
        v-else-if="saved && (source === 'db' || source === 'env')"
        class="gcal-msg ok"
        role="status"
      >
        {{ t('admin.gcal.saved') }}
      </p>
      <p v-else-if="saved" class="gcal-msg warn" role="status">
        {{ t('admin.gcal.savedIncomplete') }}
      </p>

      <div class="gcal-actions">
        <button class="gcal-btn" :disabled="saving" @click="save">
          {{ saving ? t('common.loading') : t('admin.gcal.save') }}
        </button>
        <button
          v-if="source === 'db'"
          class="gcal-btn ghost"
          :disabled="saving"
          @click="disconnect"
        >
          {{ t('admin.gcal.clear') }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gcal {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}
.gcal-loading {
  color: var(--text-2);
}
.gcal-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}
.gcal-status.src-db,
.gcal-status.src-env {
  color: var(--success, #16a34a);
}
.gcal-status.src-error {
  color: var(--danger);
}
.gcal-status.src-none {
  color: var(--text-2);
}
.gcal-guide {
  background: var(--surface-dim, var(--bg));
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
}
.gcal-guide summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text-1);
}
.gcal-guide ol {
  margin: 10px 0 0;
  padding-left: 20px;
  color: var(--text-2);
  line-height: 1.7;
}
.gcal-guide a {
  color: var(--accent);
  text-decoration: none;
  white-space: nowrap;
}
.gcal-guide a:hover {
  text-decoration: underline;
}
.gcal-guide code {
  background: var(--hover);
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 12px;
  word-break: break-all;
}
.gcal-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.gcal-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
}
.gcal-configured {
  font-weight: 400;
  font-style: normal;
  color: var(--text-2);
  font-size: 12px;
}
.gcal-input {
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-1);
  font-size: 13px;
  width: 100%;
}
.gcal-input:focus {
  outline: none;
  border-color: var(--accent);
}
.gcal-redirect {
  display: flex;
  gap: 6px;
}
.gcal-copy {
  flex-shrink: 0;
  width: 38px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-1);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.gcal-copy:hover {
  background: var(--hover);
}
.gcal-hint {
  font-size: 12px;
  color: var(--text-2);
}
.gcal-msg {
  margin: 0;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 8px;
}
.gcal-msg.err {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
}
.gcal-msg.ok {
  color: var(--success, #16a34a);
  background: color-mix(in srgb, var(--success, #16a34a) 10%, var(--surface));
}
.gcal-msg.warn {
  color: var(--warning, #b45309);
  background: color-mix(in srgb, var(--warning, #b45309) 12%, var(--surface));
}
.gcal-actions {
  display: flex;
  gap: 10px;
}
.gcal-btn {
  padding: 9px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.gcal-btn:hover {
  background: var(--accent-700);
}
.gcal-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.gcal-btn.ghost {
  background: var(--surface);
  color: var(--text-1);
}
.gcal-btn.ghost:hover {
  background: var(--hover);
}
</style>
