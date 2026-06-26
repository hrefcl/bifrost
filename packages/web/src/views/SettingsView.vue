<script setup lang="ts">
import { ref, onMounted } from 'vue';
import AppLayout from '@/layouts/AppLayout.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';
import { useSettingsStore } from '@/stores/settings';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/lib/http';

const settings = useSettingsStore();
const auth = useAuthStore();

const signature = ref('');
const autoInclude = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

onMounted(() => {
  const prefs = auth.user?.preferences;
  signature.value = prefs?.defaultSignature ?? '';
  autoInclude.value = prefs?.autoIncludeSignature ?? true;
});

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
    saved.value = true;
  } catch {
    error.value = 'No se pudo guardar la firma';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppLayout>
    <div class="p-6">
      <h1 class="mb-4 text-2xl font-bold">Settings</h1>
      <div class="max-w-xl space-y-6">
        <div class="space-y-4 rounded-xl border p-6 dark:border-gray-700">
          <label class="block">
            <span class="text-sm font-medium">Theme</span>
            <select
              v-model="settings.theme"
              class="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </label>
        </div>

        <div class="space-y-3 rounded-xl border p-6 dark:border-gray-700">
          <h2 class="text-sm font-semibold">Signature</h2>
          <RichTextEditor v-model="signature" />
          <label class="flex items-center gap-2 text-sm">
            <input v-model="autoInclude" type="checkbox" />
            Include automatically in new emails
          </label>
          <div class="flex items-center gap-3">
            <button
              class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              :disabled="saving"
              @click="saveSignature"
            >
              {{ saving ? 'Saving...' : 'Save signature' }}
            </button>
            <span v-if="saved" class="text-sm text-green-600">Saved</span>
            <span v-if="error" class="text-sm text-red-600">{{ error }}</span>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
