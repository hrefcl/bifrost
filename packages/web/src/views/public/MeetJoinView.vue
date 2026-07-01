<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '@/lib/http';
import { useMeetConfig } from '@/composables/useMeetConfig';
import MeetCallView from './MeetCallView.vue';

const route = useRoute();
const { t } = useI18n();
const slug = String(route.params.slug);

const loading = ref(true);
const unavailable = ref(false); // 404 / disabled / Meet off
const roomName = ref('');
const requiresName = ref(true);

const displayName = ref('');
const camOn = ref(true);
const micOn = ref(true);
const joined = ref(false);

// Preview local de cámara (pre-join). SÓLO video: el micrófono NO se captura acá (review B-MED1/C-L2 —
// togglear "mic off" en pre-join no debe dejar el mic del SO capturando; su estado se pasa a la llamada).
// `previewGen` serializa getUserMedia: clics rápidos no dejan streams huérfanos (review D-002).
const previewVideo = ref<HTMLVideoElement | null>(null);
let previewStream: MediaStream | null = null;
let previewGen = 0;
const previewError = ref('');

async function startPreview() {
  if (!camOn.value) return;
  const gen = ++previewGen;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    if (gen !== previewGen || destroyed) {
      // Superado por otro toggle (o desmontado) mientras se abría → soltar este stream, no asignarlo.
      s.getTracks().forEach((tk) => {
        tk.stop();
      });
      return;
    }
    previewStream = s;
    if (previewVideo.value) previewVideo.value.srcObject = s;
  } catch {
    previewError.value = t('meet.join.devicesBlocked');
  }
}

function stopPreview() {
  previewGen++; // invalida cualquier startPreview en vuelo
  previewStream?.getTracks().forEach((tk) => {
    tk.stop();
  });
  previewStream = null;
  if (previewVideo.value) previewVideo.value.srcObject = null;
}

async function toggleCam() {
  camOn.value = !camOn.value;
  stopPreview();
  await startPreview();
}
function toggleMic() {
  micOn.value = !micOn.value; // sólo el flag; el mic no se captura en pre-join
}

let destroyed = false;

onMounted(async () => {
  // Cargar config (wsUrl) + metadata de la sala en paralelo. AMBAS con catch: un fallo de red/backend
  // NO debe dejar una pantalla de pre-join rota con título vacío → se trata como "no disponible"
  // (review D-001/B-MED2/C-M2).
  const { load } = useMeetConfig();
  try {
    const [cfg, meta] = await Promise.all([
      load().catch(() => null),
      api
        .get<{ room?: { slug: string; name: string }; requiresName?: boolean; disabled?: boolean }>(
          `/meet/public/${slug}`
        )
        .then((r) => r.data)
        .catch(() => null),
    ]);
    if (!cfg?.meetEnabled || !meta?.room) {
      unavailable.value = true;
    } else {
      roomName.value = meta.room.name;
      requiresName.value = meta.requiresName !== false;
    }
  } finally {
    loading.value = false;
    if (!unavailable.value && !destroyed) await startPreview();
  }
});

onBeforeUnmount(() => {
  destroyed = true;
  stopPreview();
});

function join() {
  if (requiresName.value && displayName.value.trim().length === 0) return;
  stopPreview(); // liberar la cámara del preview antes de que el SDK tome los devices
  joined.value = true;
}
</script>

<template>
  <!-- En llamada: la vista de call ocupa todo. -->
  <MeetCallView
    v-if="joined"
    :slug="slug"
    :display-name="displayName.trim() || t('meet.join.guest')"
    :cam="camOn"
    :mic="micOn"
  />

  <!-- Pre-join -->
  <div
    v-else
    class="min-h-screen bg-neutral-900 text-neutral-100 flex items-center justify-center p-4"
  >
    <div v-if="loading" class="text-neutral-400">{{ t('meet.join.loading') }}</div>

    <div v-else-if="unavailable" class="max-w-md text-center space-y-3">
      <h1 class="text-xl font-semibold">{{ t('meet.join.unavailableTitle') }}</h1>
      <p class="text-neutral-400">{{ t('meet.join.unavailableBody') }}</p>
    </div>

    <div v-else class="w-full max-w-3xl grid gap-6 md:grid-cols-2 items-center">
      <!-- Preview -->
      <div
        class="relative aspect-video bg-black rounded-xl overflow-hidden flex items-center justify-center"
      >
        <video
          v-show="camOn"
          ref="previewVideo"
          autoplay
          muted
          playsinline
          class="w-full h-full object-cover"
        ></video>
        <div v-show="!camOn" class="text-neutral-500 text-sm">{{ t('meet.call.cameraOff') }}</div>
        <div
          v-if="previewError"
          class="absolute bottom-2 left-2 right-2 text-xs text-amber-300 bg-black/60 rounded px-2 py-1"
        >
          {{ previewError }}
        </div>
      </div>

      <!-- Controles de unión -->
      <div class="space-y-4">
        <h1 class="text-2xl font-semibold">{{ roomName }}</h1>
        <div class="flex gap-2">
          <button
            type="button"
            class="px-3 py-2 rounded-lg border border-neutral-600 hover:bg-neutral-800"
            :class="micOn ? '' : 'bg-red-600/80 border-red-600'"
            :aria-pressed="micOn"
            @click="toggleMic"
          >
            {{ micOn ? t('meet.call.mic') : t('meet.call.micOff') }}
          </button>
          <button
            type="button"
            class="px-3 py-2 rounded-lg border border-neutral-600 hover:bg-neutral-800"
            :class="camOn ? '' : 'bg-red-600/80 border-red-600'"
            :aria-pressed="camOn"
            @click="toggleCam"
          >
            {{ camOn ? t('meet.call.cam') : t('meet.call.camOff') }}
          </button>
        </div>
        <label v-if="requiresName" class="block">
          <span class="text-sm text-neutral-400">{{ t('meet.join.yourName') }}</span>
          <input
            v-model="displayName"
            type="text"
            maxlength="120"
            class="mt-1 w-full rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            @keyup.enter="join"
          />
        </label>
        <button
          type="button"
          class="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 font-medium disabled:opacity-50"
          :disabled="requiresName && displayName.trim().length === 0"
          @click="join"
        >
          {{ t('meet.join.joinNow') }}
        </button>
      </div>
    </div>
  </div>
</template>
