<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/lib/http';
import AppAvatar from '@/components/AppAvatar.vue';

/**
 * Gate de COMPLETAR PERFIL. Se fuerza al entrar cuando el nombre está autogenerado (= prefijo del email,
 * como quedan las cuentas creadas vía API) o falta el teléfono. Pide nombre completo + teléfono
 * (obligatorios) y foto (opcional) para que las firmas corporativas salgan completas. El backend es la
 * autoridad: `needsProfileCompletion` se recalcula en `GET /auth/me` tras guardar.
 */
const auth = useAuthStore();
const router = useRouter();
const { t } = useI18n();

const email = computed(() => auth.user?.primaryEmail ?? '');
const emailPrefix = computed(() => email.value.split('@')[0].trim().toLowerCase());

// Prefill: el nombre actual suele ser el prefijo autogenerado → si es así, arrancamos vacío para que
// el usuario escriba su nombre real; si ya tenía un nombre (pero faltaba el teléfono), lo conservamos.
const initialName = (auth.user?.displayName ?? '').trim();
const displayName = ref(initialName.toLowerCase() === emailPrefix.value ? '' : initialName);
const phone = ref(auth.user?.phone ?? '');
const photoDataUrl = ref<string | null>(null);
const photoPreview = ref<string | null>(auth.user?.photoUrl ?? null);
const fileInput = ref<HTMLInputElement | null>(null);

const saving = ref(false);
const error = ref('');

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

// El nombre debe ser real: no vacío, ≥2 chars y distinto del usuario del correo (para no dejar "f.arenas").
const nameValid = computed(() => {
  const n = displayName.value.trim();
  return n.length >= 2 && n.toLowerCase() !== emailPrefix.value;
});
const phoneValid = computed(() => phone.value.trim().length >= 6);
const canSave = computed(() => nameValid.value && phoneValid.value && !saving.value);

function pickPhoto(): void {
  fileInput.value?.click();
}
function onPhotoPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = '';
  if (!file.type.startsWith('image/')) {
    error.value = t('profileGate.errPhoto');
    return;
  }
  if (file.size > MAX_PHOTO_BYTES) {
    error.value = t('profileGate.errPhotoSize');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    photoDataUrl.value = reader.result as string;
    photoPreview.value = reader.result as string;
  };
  reader.readAsDataURL(file);
  input.value = '';
}
function removePhoto(): void {
  photoDataUrl.value = null;
  photoPreview.value = null;
}

async function save(): Promise<void> {
  if (!canSave.value) {
    if (!nameValid.value) error.value = t('profileGate.errName');
    else if (!phoneValid.value) error.value = t('profileGate.errPhone');
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const payload: Record<string, unknown> = {
      displayName: displayName.value.trim(),
      phone: phone.value.trim(),
    };
    if (photoDataUrl.value) payload.photoDataUrl = photoDataUrl.value;
    await api.patch('/auth/me/profile', payload);
    // Refrescar el usuario: el backend recalcula needsProfileCompletion. Si ya está completo, el guard
    // del router deja pasar al inbox.
    await auth.refreshUser();
    if (auth.user?.needsProfileCompletion) {
      // No debería pasar (nombre+teléfono válidos), pero por si acaso: no dejar al usuario atrapado.
      error.value = t('profileGate.errSave');
      return;
    }
    await router.push({ name: 'inbox' });
  } catch {
    error.value = t('profileGate.errSave');
  } finally {
    saving.value = false;
  }
}

async function doLogout(): Promise<void> {
  await auth.logout();
  await router.push({ name: 'login' });
}

onMounted(() => {
  // Si por algún motivo el perfil ya está completo (p.ej. se completó en otra pestaña), salir.
  if (!auth.user?.needsProfileCompletion) void router.push({ name: 'inbox' });
});
</script>

<template>
  <div class="fixed inset-0 z-50 flex flex-col bg-gray-50 dark:bg-gray-900">
    <header
      class="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700"
    >
      <div>
        <h1 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {{ t('profileGate.title') }}
        </h1>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('profileGate.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
        @click="doLogout"
      >
        {{ t('profileGate.logout') }}
      </button>
    </header>

    <main class="flex flex-1 justify-center overflow-y-auto p-6">
      <form class="flex w-full max-w-md flex-col gap-5" @submit.prevent="save">
        <p class="text-sm text-gray-600 dark:text-gray-300">
          {{ t('profileGate.why', { email }) }}
        </p>

        <!-- Foto (opcional) -->
        <div class="flex items-center gap-4">
          <img
            v-if="photoPreview"
            :src="photoPreview"
            alt=""
            class="h-16 w-16 rounded-full object-cover"
          />
          <AppAvatar v-else :name="displayName || email" :email="email" :size="64" />
          <div class="flex flex-col gap-1">
            <div class="flex gap-2">
              <button
                type="button"
                class="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                @click="pickPhoto"
              >
                {{ t('profileGate.photoPick') }}
              </button>
              <button
                v-if="photoPreview"
                type="button"
                class="rounded-md px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                @click="removePhoto"
              >
                {{ t('profileGate.photoRemove') }}
              </button>
            </div>
            <span class="text-xs text-gray-400">{{ t('profileGate.photoHint') }}</span>
          </div>
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            class="hidden"
            @change="onPhotoPick"
          />
        </div>

        <!-- Nombre completo (obligatorio) -->
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-gray-700 dark:text-gray-200">
            {{ t('profileGate.nameLabel') }} <span class="text-red-500">*</span>
          </span>
          <input
            v-model="displayName"
            type="text"
            autocomplete="name"
            :placeholder="t('profileGate.namePlaceholder')"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
        </label>

        <!-- Teléfono (obligatorio) -->
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-gray-700 dark:text-gray-200">
            {{ t('profileGate.phoneLabel') }} <span class="text-red-500">*</span>
          </span>
          <input
            v-model="phone"
            type="tel"
            autocomplete="tel"
            :placeholder="t('profileGate.phonePlaceholder')"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
        </label>

        <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

        <button
          type="submit"
          :disabled="!canSave"
          class="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white enabled:hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ saving ? t('profileGate.saving') : t('profileGate.save') }}
        </button>
      </form>
    </main>
  </div>
</template>
