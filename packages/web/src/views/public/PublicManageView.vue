<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/lib/http';
import PublicLayout from '@/layouts/PublicLayout.vue';
import type { Booking } from '@webmail6/shared';

const route = useRoute();
const router = useRouter();
// Token REACTIVO (review B-HIGH): al reagendar, el backend emite un token NUEVO y retira el viejo.
// Mantenemos el token activo en estado y reescribimos la URL para que recargar siga funcionando.
const token = ref(String(route.params.token));

const booking = ref<Booking | null>(null);
const loadErr = ref(false);
const serverError = ref(false);
const loading = ref(true);
const busy = ref(false);
const msg = ref('');

// reagendar
const rescheduling = ref(false);
const dayOffset = ref(0);
const slots = ref<string[]>([]);
const slotsLoading = ref(false);
// Guarda anti-respuestas-fuera-de-orden (review B/D-MED): sólo aplica la última petición de slots.
let slotsReq = 0;

const inviteeTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const selectedDay = computed(() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset.value);
  return d;
});
const dayLabel = computed(() =>
  selectedDay.value.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
);

const startLabel = computed(() =>
  booking.value
    ? new Date(booking.value.startAt).toLocaleString(undefined, {
        dateStyle: 'full',
        timeStyle: 'short',
      })
    : ''
);
const isActive = computed(() => booking.value?.status === 'confirmed');

async function load() {
  try {
    const { data } = await api.get<Booking>(`/schedule/public/booking/${token.value}`);
    booking.value = data;
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 404 || status === 410) loadErr.value = true;
    else serverError.value = true;
  } finally {
    loading.value = false;
  }
}

async function cancel() {
  if (!confirm('¿Cancelar esta reunión?')) return;
  busy.value = true;
  msg.value = '';
  try {
    const { data } = await api.post<Booking>(`/schedule/public/booking/${token.value}/cancel`, {});
    booking.value = data;
    msg.value = 'Reunión cancelada.';
  } catch {
    msg.value = 'No se pudo cancelar. Intenta de nuevo.';
  } finally {
    busy.value = false;
  }
}

function startReschedule() {
  rescheduling.value = true;
  dayOffset.value = 0; // siempre abrir en hoy (review D-LOW #11)
  void loadSlots();
}

async function loadSlots() {
  // El booking público no expone userSlug/eventSlug; pedimos los slots por el token de gestión
  // (GET /booking/:token/slots), que el backend resuelve excluyendo el propio booking del busy.
  const req = ++slotsReq;
  slotsLoading.value = true;
  slots.value = [];
  const from = new Date(selectedDay.value);
  const to = new Date(selectedDay.value);
  to.setDate(to.getDate() + 1);
  try {
    const { data } = await api.get<{ slots: { start: string }[] }>(
      `/schedule/public/booking/${token.value}/slots`,
      { params: { from: from.toISOString(), to: to.toISOString(), tz: inviteeTz } }
    );
    if (req !== slotsReq) return; // llegó una respuesta más nueva: descartar
    slots.value = data.slots.map((s) => s.start);
  } catch {
    if (req === slotsReq) slots.value = [];
  } finally {
    if (req === slotsReq) slotsLoading.value = false;
  }
}

function changeDay(delta: number) {
  const next = dayOffset.value + delta;
  if (next < 0) return;
  dayOffset.value = next;
  void loadSlots();
}

async function confirmReschedule(startAt: string) {
  if (!confirm(`¿Mover la reunión a ${new Date(startAt).toLocaleString()}?`)) return;
  busy.value = true;
  msg.value = '';
  try {
    const { data } = await api.post<{ booking: Booking; managementToken: string }>(
      `/schedule/public/booking/${token.value}/reschedule`,
      { startAt }
    );
    booking.value = data.booking;
    // El reschedule retira el token viejo y emite uno NUEVO: adoptarlo y reescribir la URL (review B-HIGH)
    // para que recargar/cancelar/volver a reagendar siga apuntando a la reserva vigente.
    if (data.managementToken) {
      token.value = data.managementToken;
      void router.replace({ name: 'public-manage', params: { token: data.managementToken } });
    }
    rescheduling.value = false;
    msg.value = 'Reunión reagendada. Revisa tu correo con los nuevos detalles.';
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 409) {
      msg.value = 'Ese horario ya no está disponible. Elige otro.';
      await loadSlots();
    } else if (status === 503) {
      msg.value = 'Servicio ocupado, intenta de nuevo en un momento.';
    } else {
      msg.value = 'No se pudo reagendar. Intenta de nuevo.';
    }
  } finally {
    busy.value = false;
  }
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const statusLabel: Record<string, string> = {
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
  rescheduled: 'Reagendada',
};

onMounted(load);
</script>

<template>
  <PublicLayout>
    <div v-if="loading" class="state"><div class="spinner" /></div>
    <div v-else-if="serverError" class="state notfound">
      <h2>Algo salió mal</h2>
      <p class="muted">No pudimos cargar tu reserva. Intenta de nuevo en un momento.</p>
    </div>
    <div v-else-if="loadErr || !booking" class="state notfound" data-testid="pub-notfound">
      <h2>Reserva no encontrada</h2>
      <p class="muted">El enlace puede haber expirado o ser inválido.</p>
    </div>
    <div v-else class="manage" data-testid="pub-manage">
      <div class="card">
        <span class="badge" :class="booking.status">{{
          statusLabel[booking.status] ?? booking.status
        }}</span>
        <h1>{{ booking.snapshot.title }}</h1>
        <p class="when">{{ startLabel }}</p>
        <p class="muted">{{ booking.invitee.name }} · {{ booking.invitee.email }}</p>

        <p v-if="msg" class="msg">{{ msg }}</p>

        <div v-if="isActive && !rescheduling" class="actions">
          <button class="primary" :disabled="busy" @click="startReschedule">Reagendar</button>
          <button class="danger" :disabled="busy" @click="cancel">Cancelar</button>
        </div>
      </div>

      <section v-if="rescheduling" class="card picker">
        <h3>Elige un nuevo horario</h3>
        <div class="daynav">
          <button
            class="ghost"
            :disabled="dayOffset === 0"
            aria-label="Día anterior"
            @click="changeDay(-1)"
          >
            ‹
          </button>
          <strong class="dayname">{{ dayLabel }}</strong>
          <button class="ghost" aria-label="Día siguiente" @click="changeDay(1)">›</button>
        </div>
        <div v-if="slotsLoading" class="muted center">Buscando horarios…</div>
        <div v-else-if="slots.length === 0" class="muted empty">No hay horarios este día.</div>
        <div v-else class="slots">
          <button
            v-for="s in slots"
            :key="s"
            type="button"
            class="slot"
            :disabled="busy"
            @click="confirmReschedule(s)"
          >
            {{ fmtTime(s) }}
          </button>
        </div>
        <button class="back" @click="rescheduling = false">Cancelar reagendado</button>
      </section>
    </div>
  </PublicLayout>
</template>

<style scoped>
.muted {
  color: var(--text-3);
}
.center {
  text-align: center;
}
.state {
  text-align: center;
  padding: 56px 0;
}
.spinner {
  width: 34px;
  height: 34px;
  margin: 0 auto;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 22px;
  box-shadow: var(--shadow-sm);
  margin-bottom: 14px;
}
.badge {
  display: inline-block;
  padding: 3px 11px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  background: var(--surface-dim);
  color: var(--text-2);
}
.badge.confirmed {
  background: color-mix(in srgb, #16a34a 14%, transparent);
  color: var(--green, #16a34a);
}
.badge.cancelled {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.badge.rescheduled {
  background: color-mix(in srgb, #d97706 16%, transparent);
  color: var(--amber, #d97706);
}
.manage h1 {
  margin: 10px 0 4px;
  font-size: 21px;
  font-weight: 700;
}
.when {
  font-weight: 600;
}
.msg {
  padding: 10px 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  border-radius: 9px;
  margin: 12px 0;
  font-size: 13.5px;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}
.primary,
.danger {
  padding: 11px 18px;
  border-radius: 9px;
  border: none;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.primary {
  background: var(--accent);
  color: #fff;
}
.primary:disabled,
.danger:disabled {
  opacity: 0.55;
  cursor: default;
}
.danger {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}
.daynav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 0;
}
.dayname {
  text-transform: capitalize;
}
.ghost {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 9px;
  width: 38px;
  height: 38px;
  font-size: 18px;
  cursor: pointer;
  color: var(--text-1);
}
.ghost:disabled {
  opacity: 0.35;
  cursor: default;
}
.slots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}
.slot {
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text-1);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.slot:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.empty {
  padding: 20px 0;
  text-align: center;
}
.back {
  margin-top: 14px;
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font: inherit;
  font-weight: 600;
}
.picker h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.notfound {
  padding: 48px 0;
}
.notfound h2 {
  margin: 0 0 6px;
}
</style>
