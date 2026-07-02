<script setup lang="ts">
import { ref, shallowRef, onMounted, onBeforeUnmount, computed, markRaw } from 'vue';
import { useI18n } from 'vue-i18n';
import { Room, RoomEvent, Track } from 'livekit-client';
import type { Participant } from 'livekit-client';
import { api } from '@/lib/http';
import { useAuthStore } from '@/stores/auth';
import MeetVideoTile from '@/components/meet/MeetVideoTile.vue';
import AppIcon from '@/components/AppIcon.vue';

const props = defineProps<{
  slug: string;
  displayName: string;
  cam: boolean;
  mic: boolean;
}>();

const { t } = useI18n();
const auth = useAuthStore();

interface TokenResponse {
  token: string;
  wsUrl: string;
  room: string;
  identity: string;
  role: 'host' | 'internal' | 'external';
  expiresInSeconds: number;
}

interface Tile {
  id: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  videoTrack?: Track | null;
  audioTrack?: Track | null;
}

const room = shallowRef<Room | null>(null);
const status = ref<'connecting' | 'connected' | 'error' | 'left' | 'reconnecting'>('connecting');
const errorMsg = ref('');
const tiles = ref<Tile[]>([]);
const screenTile = ref<Tile | null>(null); // pantalla compartida activa (spotlight)
const micOn = ref(props.mic);
const camOn = ref(props.cam);
const screenOn = ref(false);
const linkCopied = ref(false);

// Guards de ciclo de vida (review B-HIGH/D-003/C-M5): `disposed` corta cualquier connect en vuelo cuando
// el componente se desmonta; `connectGen` invalida un connect superado por un retry; `connecting` evita
// double-connect (dos Rooms publicando, una huérfana con el device prendido).
let disposed = false;
let connectGen = 0;
const connecting = ref(false);
// Intención MANUAL del usuario sobre mic/cam (review B/D-MED): si togueó durante el bootstrap del publish,
// `publishLocalMedia` NO aplica el default de props sobre esa fuente (su acción más reciente gana).
let manualMic = false;
let manualCam = false;

const participantCount = computed(() => tiles.value.length);

/** Marca un track como NO-reactivo (review C-M3): evitar que Vue lo envuelva en un Proxy (anti-patrón LiveKit). */
function raw<T>(track: T | null | undefined): T | null {
  return track ? markRaw(track) : null;
}

/** Mensaje de error legible: prioriza el `message` del backend (p.ej. 403 too_early/window_closed — C-M1). */
function extractError(e: unknown): string {
  const ax = e as { response?: { data?: { message?: string } }; message?: string };
  const backend = ax.response?.data?.message;
  const reasonKey: Record<string, string> = {
    too_early: 'meet.call.tooEarly',
    window_closed: 'meet.call.windowClosed',
    external_forbidden: 'meet.call.externalForbidden',
  };
  if (backend && reasonKey[backend]) return t(reasonKey[backend]);
  return backend ?? ax.message ?? t('meet.call.connectError');
}

/** Desconecta y libera la Room actual (idempotente). */
async function teardownRoom() {
  const r = room.value;
  room.value = null;
  if (r) {
    r.removeAllListeners(); // defensa en profundidad: ningún listener viejo sobrevive al rejoin (review C)
    await r.disconnect().catch(() => undefined);
  }
}

// Grilla responsiva: nº de columnas según cantidad de tiles.
const gridStyle = computed<Record<string, string>>(() => {
  const n = tiles.value.length || 1;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  return { gridTemplateColumns: `repeat(${String(cols)}, minmax(0, 1fr))` };
});

function nameOf(p: Participant): string {
  const n = p.name?.trim();
  if (n) return n;
  return p.isLocal ? t('meet.call.you') : t('meet.join.guest');
}

/** Reconstruye los tiles desde el estado actual de la sala (llamado en cada evento relevante). */
function refresh() {
  const r = room.value;
  if (!r) return;
  const parts: Participant[] = [r.localParticipant, ...r.remoteParticipants.values()];
  const next: Tile[] = [];
  let screen: Tile | null = null;

  for (const p of parts) {
    const camPub = p.getTrackPublication(Track.Source.Camera);
    const micPub = p.getTrackPublication(Track.Source.Microphone);
    const screenPub = p.getTrackPublication(Track.Source.ScreenShare);
    const screenAudioPub = p.getTrackPublication(Track.Source.ScreenShareAudio);
    next.push({
      id: p.identity,
      name: nameOf(p),
      isLocal: p.isLocal,
      speaking: p.isSpeaking,
      micMuted: micPub ? micPub.isMuted : true,
      videoTrack: raw(camPub?.track),
      audioTrack: p.isLocal ? null : raw(micPub?.track),
    });
    if (screenPub?.track) {
      screen = {
        id: `${p.identity}-screen`,
        name: nameOf(p),
        isLocal: p.isLocal,
        speaking: false,
        micMuted: false,
        videoTrack: raw(screenPub.track),
        // Audio de la pantalla compartida (review D-005): se oye (salvo el propio, para no eco).
        audioTrack: p.isLocal ? null : raw(screenAudioPub?.track),
      };
    }
  }
  tiles.value = next;
  screenTile.value = screen;

  // Reflejar el estado real de los toggles locales (por si el SDK los cambió, p.ej. screen share terminado).
  const lp = r.localParticipant;
  micOn.value = !(lp.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true);
  camOn.value = Boolean(
    lp.getTrackPublication(Track.Source.Camera)?.track &&
    !lp.getTrackPublication(Track.Source.Camera)?.isMuted
  );
  screenOn.value = Boolean(lp.getTrackPublication(Track.Source.ScreenShare)?.track);
}

async function fetchToken(): Promise<TokenResponse> {
  // Usuario logueado → endpoint autenticado (host/interno); invitado → endpoint público (externo).
  const endpoint = auth.isAuthenticated
    ? `/meet/rooms/${props.slug}/token`
    : `/meet/public/${props.slug}/token`;
  const { data } = await api.post<TokenResponse>(endpoint, { displayName: props.displayName });
  return data;
}

function wireEvents(r: Room) {
  const relevant: RoomEvent[] = [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.ActiveSpeakersChanged,
    RoomEvent.TrackPublished,
  ];
  // TODOS los handlers se SCOPEAN a la room actual (`room.value === r`): tras un rejoin, los listeners de
  // una room vieja (aún no GC) no deben mutar el estado de la nueva conexión (review C-R1).
  const onRefresh = () => {
    if (room.value === r) refresh();
  };
  for (const ev of relevant) r.on(ev, onRefresh);
  // Auto-reconexión del SDK ante blips de red (review D-004/C-L1): la UI lo refleja en vez de exigir retry.
  r.on(RoomEvent.Reconnecting, () => {
    if (!disposed && room.value === r && status.value !== 'left') status.value = 'reconnecting';
  });
  r.on(RoomEvent.Reconnected, () => {
    if (!disposed && room.value === r && status.value !== 'left') {
      status.value = 'connected';
      refresh();
    }
  });
  r.on(RoomEvent.Disconnected, () => {
    if (room.value !== r) return;
    if (status.value !== 'left') status.value = 'reconnecting';
    refresh(); // limpiar tiles (no dejar el último frame congelado — review C-L5)
  });
}

// ¿Este connect quedó obsoleto? (componente desmontado o superado por un retry). Helper para no disparar
// el falso-positivo de narrowing de TS sobre `disposed`, que SÍ puede cambiar (closure) a través del await.
function staleGen(g: number): boolean {
  return disposed || g !== connectGen;
}

async function connect() {
  if (connecting.value) return; // anti double-connect (review C-M5)
  connecting.value = true;
  const gen = ++connectGen;
  status.value = 'connecting';
  errorMsg.value = '';
  await teardownRoom(); // soltar cualquier Room previa antes de crear otra (review D-003)
  let r: Room | null = null;
  try {
    const tok = await fetchToken();
    if (staleGen(gen)) return; // desmontado/superado durante el fetch
    r = markRaw(new Room({ adaptiveStream: true, dynacast: true }));
    wireEvents(r);
    // Publicar `room.value` ANTES de `connect()`: así un unmount DURANTE la conexión llega a esta Room vía
    // `teardownRoom()` y la desconecta de inmediato (review B-MEDIUM). El template no renderiza tiles aún
    // (status='connecting'), así que exponerla temprano es seguro.
    room.value = r;
    await r.connect(tok.wsUrl, tok.token);
    if (staleGen(gen)) {
      // Se desmontó/superó MIENTRAS conectaba → soltar la Room (review B-HIGH).
      await teardownRoom();
      return;
    }
    // La Room YA está conectada → mostrar 'connected' de INMEDIATO. NO bloquear el estado en el publish de
    // mic/cam: un `setXEnabled` lento o COLGADO (permiso demorado, cámara lenta, encode) dejaba al usuario en
    // "Conectando…" para siempre con la sala conectada. El publish va best-effort, desacoplado (abajo).
    status.value = 'connected';
    refresh();
    void publishLocalMedia(r, gen);
  } catch (e) {
    if (r) {
      await r.disconnect().catch(() => undefined); // soltar la Room a medio crear (review C-L3)
      if (room.value === r) room.value = null;
    }
    if (staleGen(gen)) return;
    errorMsg.value = extractError(e);
    status.value = 'error';
  } finally {
    if (gen === connectGen) connecting.value = false;
  }
}

/**
 * Bootstrap best-effort de mic/cam, DESACOPLADO del estado 'connected' (un publish lento/colgado no debe dejar
 * la UI en "Conectando…" ni bloquear un reconnect). Guards de ciclo de vida (review B/D):
 *  - Re-chequea `staleGen` ANTES de cada `setXEnabled` (que PRENDE el dispositivo) → no enciende tras un
 *    unmount/retry.
 *  - HIGH (review B+D): NUNCA llama `teardownRoom()` desde una corrida obsoleta — ese helper opera sobre
 *    `room.value`, que un `connect()` nuevo pudo reemplazar → desconectaría la Room NUEVA. El cleanup de la
 *    Room vieja lo hacen el nuevo `connect()` (su teardownRoom inicial) y `onBeforeUnmount`. Acá sólo `return`.
 *  - MED (review B): no pisa una intención MANUAL: si el usuario ya togueó mic/cam durante el bootstrap,
 *    NO aplicamos el default de props (su acción más reciente gana).
 * Autocontenida: nunca lanza (se invoca con `void`).
 */
async function publishLocalMedia(r: Room, gen: number): Promise<void> {
  try {
    if (!staleGen(gen) && !manualMic) await r.localParticipant.setMicrophoneEnabled(props.mic);
    if (!staleGen(gen) && !manualCam) await r.localParticipant.setCameraEnabled(props.cam);
  } catch {
    /* permisos denegados → entra sin publicar; el usuario reintenta con los toggles */
  }
  if (staleGen(gen)) return; // obsoleto → el nuevo connect / unmount ya limpian; NO tocar room.value acá
  refresh();
}

async function toggleMic() {
  const lp = room.value?.localParticipant;
  if (!lp) return;
  manualMic = true; // intención manual → el bootstrap no la pisa (review B/D-MED)
  try {
    await lp.setMicrophoneEnabled(!micOn.value);
  } catch {
    /* permiso de micrófono denegado */
  } finally {
    refresh();
  }
}
async function toggleCam() {
  const lp = room.value?.localParticipant;
  if (!lp) return;
  manualCam = true; // intención manual → el bootstrap no la pisa (review B/D-MED)
  try {
    await lp.setCameraEnabled(!camOn.value);
  } catch {
    /* permiso de cámara denegado */
  } finally {
    refresh();
  }
}
async function toggleScreen() {
  const lp = room.value?.localParticipant;
  if (!lp) return;
  try {
    await lp.setScreenShareEnabled(!screenOn.value);
  } catch {
    /* el usuario canceló el selector de getDisplayMedia → no-op */
  }
  refresh();
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    linkCopied.value = true;
    setTimeout(() => (linkCopied.value = false), 1500);
  } catch {
    /* clipboard no disponible */
  }
}

function leave() {
  status.value = 'left';
  // Invalidar cualquier publishLocalMedia pendiente (review B-MED): sin esto, un publish colgado podía
  // resolver DESPUÉS de salir (staleGen=false) y hacer refresh()/tocar una Room ya cerrada.
  connectGen++;
  void teardownRoom();
}

function rejoin() {
  void connect();
}

onMounted(connect);
onBeforeUnmount(() => {
  disposed = true; // corta cualquier connect en vuelo y evita publicar tras desmontar (review B-HIGH)
  void teardownRoom();
});
</script>

<template>
  <div class="fixed inset-0 bg-neutral-900 text-neutral-100 flex flex-col">
    <!-- Estados no-conectados -->
    <div
      v-if="status === 'connecting'"
      class="flex-1 flex items-center justify-center text-neutral-400"
    >
      {{ t('meet.call.connecting') }}
    </div>
    <div
      v-else-if="status === 'error'"
      class="flex-1 flex flex-col items-center justify-center gap-3"
    >
      <p class="text-red-400">{{ errorMsg || t('meet.call.connectError') }}</p>
      <button
        type="button"
        class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500"
        @click="rejoin"
      >
        {{ t('meet.call.retry') }}
      </button>
    </div>
    <div
      v-else-if="status === 'left'"
      class="flex-1 flex flex-col items-center justify-center gap-3 text-neutral-400"
    >
      <p>{{ t('meet.call.youLeft') }}</p>
      <button
        type="button"
        class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
        @click="rejoin"
      >
        {{ t('meet.call.rejoin') }}
      </button>
    </div>

    <!-- En llamada -->
    <template v-else>
      <div v-if="status === 'reconnecting'" class="bg-amber-600/80 text-center text-sm py-1">
        {{ t('meet.call.reconnecting') }}
        <button type="button" class="underline ml-2" @click="rejoin">
          {{ t('meet.call.retry') }}
        </button>
      </div>

      <!-- Spotlight de pantalla compartida (si hay) -->
      <div v-if="screenTile" class="flex-1 p-2 min-h-0">
        <MeetVideoTile
          :key="screenTile.id"
          :name="screenTile.name"
          :video-track="screenTile.videoTrack"
          :audio-track="screenTile.audioTrack"
          :is-screen="true"
          :is-local="screenTile.isLocal"
          class="w-full h-full"
        />
      </div>

      <!-- Grilla de cámaras (o pantalla completa si no hay screen share) -->
      <div
        class="grid gap-2 p-2 min-h-0"
        :class="
          screenTile
            ? 'grid-flow-col auto-cols-[12rem] overflow-x-auto h-40'
            : 'flex-1 auto-rows-fr'
        "
        :style="!screenTile ? gridStyle : undefined"
      >
        <MeetVideoTile
          v-for="tile in tiles"
          :key="tile.id"
          :name="tile.name"
          :video-track="tile.videoTrack"
          :audio-track="tile.audioTrack"
          :speaking="tile.speaking"
          :mic-muted="tile.micMuted"
          :is-local="tile.isLocal"
        />
      </div>

      <!-- Barra de control inferior estilo Google Meet -->
      <div class="meet-controls">
        <button
          type="button"
          class="ctl"
          :class="micOn ? '' : 'ctl-off'"
          :aria-pressed="micOn"
          :title="t('meet.call.mic')"
          @click="toggleMic"
        >
          <AppIcon :name="micOn ? 'mic' : 'micOff'" :size="22" />
        </button>
        <button
          type="button"
          class="ctl"
          :class="camOn ? '' : 'ctl-off'"
          :aria-pressed="camOn"
          :title="t('meet.call.cam')"
          @click="toggleCam"
        >
          <AppIcon :name="camOn ? 'video' : 'videoOff'" :size="22" />
        </button>
        <button
          type="button"
          class="ctl"
          :class="screenOn ? 'ctl-active' : ''"
          :aria-pressed="screenOn"
          :title="t('meet.call.shareScreen')"
          @click="toggleScreen"
        >
          <AppIcon name="screenShare" :size="22" />
        </button>
        <button type="button" class="ctl" :title="t('meet.call.copyLink')" @click="copyLink">
          <AppIcon :name="linkCopied ? 'check' : 'link'" :size="22" />
        </button>
        <div class="ctl-count">
          <AppIcon name="users" :size="16" />
          <span>{{ participantCount }}</span>
        </div>
        <button type="button" class="ctl ctl-leave" :title="t('meet.call.leave')" @click="leave">
          <AppIcon name="phone" :size="22" />
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Barra de controles estilo Google Meet: fila centrada, botones circulares, hang-up rojo tipo pill. */
.meet-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 14px 16px calc(14px + env(safe-area-inset-bottom, 0px));
  background: linear-gradient(to top, rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0.3));
}
.ctl {
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 9999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: rgba(60, 64, 67, 0.9); /* gris neutro Google Meet */
  cursor: pointer;
  transition:
    background 0.15s,
    transform 0.1s;
}
.ctl:hover {
  background: rgba(82, 86, 90, 0.95);
}
.ctl:active {
  transform: scale(0.94);
}
/* Muteado (mic/cam off): rojo Google. */
.ctl-off {
  background: #ea4335;
}
.ctl-off:hover {
  background: #f2534a;
}
/* Activo (compartiendo pantalla): azul claro Google, icono oscuro. */
.ctl-active {
  background: #8ab4f8;
  color: #202124;
}
.ctl-active:hover {
  background: #a6c8fb;
}
/* Colgar: pill rojo más ancho, como el "end call" de Meet. */
.ctl-leave {
  width: 64px;
  background: #ea4335;
}
.ctl-leave:hover {
  background: #f2534a;
}
/* Contador de participantes: sutil, con icono duotone. */
.ctl-count {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  color: rgba(255, 255, 255, 0.75);
  font-size: 14px;
  font-weight: 600;
}
</style>
