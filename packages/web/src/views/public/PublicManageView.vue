<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/lib/http';
import PublicLayout from '@/layouts/PublicLayout.vue';
import type { Booking } from '@webmail6/shared';

const route = useRoute();
const token = String(route.params.token);

const booking = ref<Booking | null>(null);
const loadErr = ref(false);
const loading = ref(true);
const busy = ref(false);
const msg = ref('');

// reagendar
const rescheduling = ref(false);
const dayOffset = ref(0);
const slots = ref<string[]>([]);
const slotsLoading = ref(false);

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
    const { data } = await api.get<Booking>(`/schedule/public/booking/${token}`);
    booking.value = data;
  } catch {
    loadErr.value = true;
  } finally {
    loading.value = false;
  }
}

async function cancel() {
  if (!confirm('¿Cancelar esta reunión?')) return;
  busy.value = true;
  msg.value = '';
  try {
    const { data } = await api.post<Booking>(`/schedule/public/booking/${token}/cancel`, {});
    booking.value = data;
    msg.value = 'Reunión cancelada.';
  } catch {
    msg.value = 'No se pudo cancelar. Intenta de nuevo.';
  } finally {
    busy.value = false;
  }
}

// Para reagendar necesitamos los slots del mismo tipo: derivamos user/event del booking no expuestos,
// así que usamos las rutas públicas con username/slug del snapshot no disponibles → se reusa el endpoint
// de reschedule directamente con el startAt elegido. Los slots se piden vía el endpoint público del tipo.
function startReschedule() {
  rescheduling.value = true;
  void loadSlots();
}

async function loadSlots() {
  // El booking público no expone userSlug/eventSlug; el endpoint de reschedule revalida el slot server-side
  // (overlap + disponibilidad). Aquí ofrecemos elegir día/hora con los slots del propio tipo vía /slots,
  // que el backend resuelve por el token de gestión.
  slotsLoading.value = true;
  slots.value = [];
  const from = new Date(selectedDay.value);
  const to = new Date(selectedDay.value);
  to.setDate(to.getDate() + 1);
  try {
    const { data } = await api.get<{ slots: { start: string }[] }>(
      `/schedule/public/booking/${token}/slots`,
      { params: { from: from.toISOString(), to: to.toISOString(), tz: inviteeTz } }
    );
    slots.value = data.slots.map((s) => s.start);
  } catch {
    slots.value = [];
  } finally {
    slotsLoading.value = false;
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
      `/schedule/public/booking/${token}/reschedule`,
      { startAt }
    );
    booking.value = data.booking;
    rescheduling.value = false;
    msg.value = 'Reunión reagendada. Revisa tu correo con los nuevos detalles.';
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    msg.value =
      status === 409
        ? 'Ese horario ya no está disponible. Elige otro.'
        : 'No se pudo reagendar. Intenta de nuevo.';
    if (status === 409) await loadSlots();
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
    <div v-if="loading" class="muted">Cargando…</div>
    <div v-else-if="loadErr || !booking" class="notfound">
      <h2>Reserva no encontrada</h2>
      <p class="muted">El enlace puede haber expirado o ser inválido.</p>
    </div>
    <div v-else class="manage">
      <span class="badge" :class="booking.status">{{
        statusLabel[booking.status] ?? booking.status
      }}</span>
      <h1>{{ booking.snapshot.title }}</h1>
      <p class="when">{{ startLabel }}</p>
      <p class="muted">{{ booking.invitee.name }} · {{ booking.invitee.email }}</p>

      <p v-if="msg" class="msg">{{ msg }}</p>

      <template v-if="isActive && !rescheduling">
        <div class="actions">
          <button class="primary" :disabled="busy" @click="startReschedule">Reagendar</button>
          <button class="danger" :disabled="busy" @click="cancel">Cancelar</button>
        </div>
      </template>

      <section v-if="rescheduling" class="picker">
        <h3>Elige un nuevo horario</h3>
        <div class="daynav">
          <button class="ghost" :disabled="dayOffset === 0" @click="changeDay(-1)">‹</button>
          <strong class="dayname">{{ dayLabel }}</strong>
          <button class="ghost" @click="changeDay(1)">›</button>
        </div>
        <div v-if="slotsLoading" class="muted">Buscando horarios…</div>
        <div v-else-if="slots.length === 0" class="muted empty">No hay horarios este día.</div>
        <div v-else class="slots">
          <button
            v-for="s in slots"
            :key="s"
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
  color: var(--text-3, #8a8a8a);
}
.badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--surface-2, #eee);
}
.badge.confirmed {
  background: #e6f4ea;
  color: #1e7e34;
}
.badge.cancelled {
  background: #fdecea;
  color: #c0392b;
}
.badge.rescheduled {
  background: #fff4e5;
  color: #b26a00;
}
.manage h1 {
  margin: 8px 0 4px;
}
.when {
  font-weight: 600;
}
.msg {
  padding: 10px;
  background: var(--surface-2, #f0f0f0);
  border-radius: 8px;
  margin: 12px 0;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}
.primary,
.danger {
  padding: 11px 18px;
  border-radius: 8px;
  border: none;
  font-weight: 600;
  cursor: pointer;
}
.primary {
  background: var(--accent);
  color: #fff;
}
.danger {
  background: #fdecea;
  color: #c0392b;
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
  background: none;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  width: 38px;
  height: 38px;
  font-size: 18px;
  cursor: pointer;
}
.ghost:disabled {
  opacity: 0.35;
}
.slots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}
.slot {
  padding: 12px;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  background: var(--surface, #fff);
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
}
.picker h3 {
  margin: 20px 0 0;
}
.notfound {
  text-align: center;
  padding: 48px 0;
}
</style>
