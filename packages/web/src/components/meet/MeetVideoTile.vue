<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';

/**
 * Tile de un participante: adjunta su track de video (cámara o pantalla) a un <video> y, si es remoto,
 * su audio a un <audio> oculto (para oírlo; el audio LOCAL nunca se adjunta → evita eco). El attach/detach
 * sigue el ciclo de vida del track: re-adjunta cuando el track cambia, detacha al desmontar.
 *
 * El track se tipa ESTRUCTURALMENTE (sólo `attach`/`detach` que usamos): evita la fricción de identidad
 * de clase del `Track` de livekit-client entre SFCs bajo vue-tsc. Cualquier Track satisface esta forma.
 */
interface AttachableTrack {
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(): HTMLMediaElement[];
}

const props = defineProps<{
  name: string;
  videoTrack?: AttachableTrack | null;
  audioTrack?: AttachableTrack | null; // sólo remotos
  speaking?: boolean;
  micMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
}>();

const videoEl = ref<HTMLVideoElement | null>(null);
const audioEl = ref<HTMLAudioElement | null>(null);

function attachVideo(track?: AttachableTrack | null) {
  if (videoEl.value && track) track.attach(videoEl.value);
}
function attachAudio(track?: AttachableTrack | null) {
  if (audioEl.value && track) track.attach(audioEl.value);
}

watch(
  () => props.videoTrack,
  (next, prev) => {
    if (prev) prev.detach();
    attachVideo(next);
  }
);
watch(
  () => props.audioTrack,
  (next, prev) => {
    if (prev) prev.detach();
    attachAudio(next);
  }
);
// attach inicial cuando el elemento se monta.
watch(videoEl, () => {
  attachVideo(props.videoTrack);
});
watch(audioEl, () => {
  attachAudio(props.audioTrack);
});

onBeforeUnmount(() => {
  props.videoTrack?.detach();
  props.audioTrack?.detach();
});
</script>

<template>
  <div
    class="relative rounded-xl overflow-hidden bg-black flex items-center justify-center"
    :class="speaking ? 'ring-2 ring-blue-400' : ''"
  >
    <video
      v-show="!!videoTrack"
      ref="videoEl"
      autoplay
      playsinline
      :muted="isLocal"
      class="w-full h-full"
      :class="isScreen ? 'object-contain' : 'object-cover'"
    ></video>
    <!-- Sin video → avatar con la inicial -->
    <div
      v-show="!videoTrack"
      class="w-16 h-16 rounded-full bg-neutral-700 text-neutral-200 flex items-center justify-center text-2xl"
    >
      {{ name.charAt(0).toUpperCase() }}
    </div>
    <!-- Audio remoto (oculto) -->
    <audio v-if="!isLocal && audioTrack" ref="audioEl" autoplay></audio>
    <!-- Etiqueta -->
    <div
      class="absolute bottom-1 left-1 px-2 py-0.5 rounded bg-black/60 text-xs text-neutral-100 flex items-center gap-1 max-w-[90%] truncate"
    >
      <span v-if="micMuted" aria-hidden="true">🔇</span>
      <span class="truncate">{{ name }}{{ isScreen ? ' · 🖥️' : '' }}</span>
    </div>
  </div>
</template>
