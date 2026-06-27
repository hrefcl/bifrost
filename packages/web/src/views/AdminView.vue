<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { AxiosError } from 'axios';
import AppLayout from '@/layouts/AppLayout.vue';
import { api } from '@/lib/http';

/**
 * Panel de administración — Paso 1: almacenamiento de adjuntos.
 *
 * El backend (`/api/admin/config/storage`) exige rol admin y hoy sólo persiste el provider
 * `local`. `s3` se mostrará como opción pero aún no se puede guardar (llega en una próxima
 * versión); la UI lo deja claro y, por defensa, traduce el 400 del backend a un mensaje amable.
 */
type ProviderType = 'local' | 's3';

interface StorageConfig {
  providerType: ProviderType;
  updatedBy?: string;
  updatedAt?: string;
}

const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');
const selected = ref<ProviderType>('local');
const current = ref<StorageConfig | null>(null);

onMounted(async () => {
  try {
    const { data } = await api.get<StorageConfig>('/admin/config/storage');
    current.value = data;
    selected.value = data.providerType;
  } catch {
    error.value = 'No se pudo cargar la configuración de almacenamiento';
  } finally {
    loading.value = false;
  }
});

function choose(provider: ProviderType) {
  selected.value = provider;
  saved.value = false;
  error.value = '';
}

async function save() {
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    const { data } = await api.patch<StorageConfig>('/admin/config/storage', {
      providerType: selected.value,
    });
    current.value = data;
    selected.value = data.providerType;
    saved.value = true;
  } catch (err) {
    // El backend rechaza s3 con 400 (aún no implementado): mensaje claro, no un crudo error.
    if (err instanceof AxiosError && err.response?.status === 400) {
      error.value = 'El almacenamiento S3 estará disponible en una próxima versión.';
    } else {
      error.value = 'No se pudo guardar la configuración';
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppLayout>
    <div class="p-6">
      <h1 class="mb-1 text-2xl font-bold">Administración</h1>
      <p class="mb-6 text-sm text-gray-500">Paso 1 de 1 — Almacenamiento de adjuntos</p>

      <div class="max-w-xl space-y-6">
        <div class="space-y-4 rounded-xl border p-6 dark:border-gray-700">
          <div>
            <h2 class="text-lg font-semibold">¿Dónde se guardan los adjuntos?</h2>
            <p class="mt-1 text-sm text-gray-500">
              Elegí el destino de los archivos que los usuarios adjuntan a sus correos. Podés
              cambiarlo más adelante; los adjuntos ya guardados se siguen leyendo de su origen.
            </p>
          </div>

          <p v-if="loading" class="text-sm text-gray-500">Cargando…</p>

          <div v-else class="space-y-3">
            <!-- LOCAL -->
            <label
              class="flex cursor-pointer items-start gap-3 rounded-lg border p-4 dark:border-gray-700"
              :class="
                selected === 'local' ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-300'
              "
            >
              <input
                type="radio"
                name="provider"
                value="local"
                :checked="selected === 'local'"
                class="mt-1"
                @change="choose('local')"
              />
              <span>
                <span class="font-medium">Servidor local (recomendado)</span>
                <span class="ml-2 rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                  >Disponible</span
                >
                <span class="block text-sm text-gray-500">
                  Los archivos se guardan en el disco del propio servidor. Sin configuración
                  adicional. Ideal para empezar o para instalaciones self-hosted.
                </span>
              </span>
            </label>

            <!-- S3 -->
            <label
              class="flex cursor-pointer items-start gap-3 rounded-lg border p-4 dark:border-gray-700"
              :class="
                selected === 's3' ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-300'
              "
            >
              <input
                type="radio"
                name="provider"
                value="s3"
                :checked="selected === 's3'"
                class="mt-1"
                @change="choose('s3')"
              />
              <span>
                <span class="font-medium">S3 / compatible (MinIO, R2, …)</span>
                <span class="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700"
                  >Próximamente</span
                >
                <span class="block text-sm text-gray-500">
                  Los archivos se guardan en un bucket S3. Requiere endpoint, bucket, región y
                  credenciales (la clave secreta se cifra y nunca se muestra).
                </span>
              </span>
            </label>

            <!-- Vista previa de los campos S3 (deshabilitada hasta que se implemente). -->
            <div
              v-if="selected === 's3'"
              class="space-y-2 rounded-lg bg-amber-50 p-4 text-sm dark:bg-amber-950/30"
            >
              <p class="text-amber-800 dark:text-amber-300">
                Estos datos se pedirán cuando S3 esté disponible:
              </p>
              <input
                class="adminput"
                placeholder="Endpoint (ej. https://s3.amazonaws.com)"
                disabled
              />
              <input class="adminput" placeholder="Bucket" disabled />
              <input class="adminput" placeholder="Región (ej. us-east-1)" disabled />
              <input class="adminput" placeholder="Access Key ID" disabled />
              <input class="adminput" type="password" placeholder="Secret Access Key" disabled />
            </div>

            <div class="flex items-center gap-3 pt-2">
              <button
                class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                :disabled="saving || selected === 's3'"
                @click="save"
              >
                {{ saving ? 'Guardando…' : 'Guardar' }}
              </button>
              <span v-if="saved" class="text-sm text-green-600">Guardado</span>
              <span v-if="error" class="text-sm text-red-600">{{ error }}</span>
            </div>
            <p
              v-if="current?.updatedAt"
              class="text-xs text-gray-400"
              data-testid="storage-current"
            >
              Actual: {{ current.providerType }} · actualizado {{ current.updatedAt }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.adminput {
  @apply w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-700 dark:bg-gray-800;
}
</style>
