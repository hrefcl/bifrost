<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { AxiosError } from 'axios';
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
    error.value = 'No se pudo cargar la configuración de almacenamiento';
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
      error.value =
        'Datos de S3 inválidos. Revisá los campos: endpoint (http/https, sin ruta), región (ej. us-east-1) y credenciales.';
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
                <span class="ml-2 rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                  >Disponible</span
                >
                <span class="block text-sm text-gray-500">
                  Los archivos se guardan en un bucket S3. Requiere endpoint, bucket, región y
                  credenciales (la clave secreta se cifra y nunca se muestra).
                </span>
              </span>
            </label>

            <!-- Campos de configuración S3. @input en el contenedor (los eventos burbujean)
                 descarta el "Guardado"/error previo al editar cualquier campo. -->
            <div
              v-if="selected === 's3'"
              class="space-y-2 rounded-lg bg-gray-50 p-4 dark:bg-gray-800"
              @input="clearStatus"
            >
              <label class="block text-sm font-medium">Endpoint (opcional para AWS)</label>
              <input
                v-model="s3.endpoint"
                class="adminput"
                placeholder="https://s3.amazonaws.com o http://minio:9000"
              />
              <label class="block text-sm font-medium">Bucket</label>
              <input v-model="s3.bucket" class="adminput" placeholder="mi-bucket" />
              <label class="block text-sm font-medium">Región</label>
              <input v-model="s3.region" class="adminput" placeholder="us-east-1" />
              <label class="block text-sm font-medium">Access Key ID</label>
              <input v-model="s3.accessKeyId" class="adminput" placeholder="AKIA…" />
              <label class="block text-sm font-medium">
                Secret Access Key
                <span v-if="secretAlreadyConfigured" class="text-xs font-normal text-gray-500">
                  (ya configurada — re-ingresala para cambiar la configuración)
                </span>
              </label>
              <input
                v-model="s3.secretAccessKey"
                type="password"
                class="adminput"
                :placeholder="
                  secretAlreadyConfigured ? 'Re-ingresar secret para cambiar' : 'Secret Access Key'
                "
                autocomplete="new-password"
              />
            </div>

            <div class="flex flex-wrap items-center gap-3 pt-2">
              <button
                v-if="selected === 's3'"
                class="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                :disabled="testing || s3Incomplete()"
                @click="testConnection"
              >
                {{ testing ? 'Probando…' : 'Probar conexión' }}
              </button>
              <span v-if="tested === 'ok'" class="text-sm text-green-600">✓ Conexión OK</span>
              <span v-if="tested === 'fail'" class="text-sm text-red-600">
                ✗ No se pudo conectar al bucket
              </span>
              <button
                class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                :disabled="saving || s3Incomplete()"
                @click="save"
              >
                {{ saving ? 'Guardando…' : 'Guardar' }}
              </button>
              <span v-if="saved" class="text-sm text-green-600">Guardado</span>
              <span v-if="error" class="text-sm text-red-600">{{ error }}</span>
            </div>
            <p
              v-if="selected === 's3' && tested !== 'ok' && !s3Incomplete()"
              class="text-xs text-amber-600"
            >
              Sugerido: probá la conexión antes de guardar — si los datos son incorrectos, los
              adjuntos nuevos fallarán.
            </p>
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
