<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/lib/http';
import PublicLayout from '@/layouts/PublicLayout.vue';
import type { PublicEventType, Booking } from '@webmail6/shared';

const route = useRoute();
const userSlug = String(route.params.userSlug);
const eventSlug = String(route.params.eventSlug);
const inviteeTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const ev = ref<PublicEventType | null>(null);
const loadErr = ref(false);
const serverError = ref(false);
const loading = ref(true);

// step: 1=fecha, 2=hora, 3=datos, 4=confirmado
const step = ref<1 | 2 | 3 | 4>(1);

// ── navegación de día ──
const dayOffset = ref(0); // 0 = hoy
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

const slots = ref<string[]>([]);
const slotsLoading = ref(false);
const selectedSlot = ref<string | null>(null);
// Guarda anti-respuestas-fuera-de-orden (review B/D-MED): navegar días rápido podía pintar slots de un
// día anterior bajo el label actual. Sólo aplicamos la última petición.
let slotsReq = 0;

async function loadSlots() {
  const req = ++slotsReq;
  slotsLoading.value = true;
  slots.value = [];
  const from = new Date(selectedDay.value);
  const to = new Date(selectedDay.value);
  to.setDate(to.getDate() + 1);
  try {
    const { data } = await api.get<{ slots: { start: string }[] }>(
      `/schedule/public/${userSlug}/${eventSlug}/slots`,
      { params: { from: from.toISOString(), to: to.toISOString(), tz: inviteeTz } }
    );
    if (req !== slotsReq) return;
    slots.value = data.slots.map((s) => s.start);
  } catch {
    if (req === slotsReq) slots.value = [];
  } finally {
    if (req === slotsReq) slotsLoading.value = false;
  }
}

function changeDay(delta: number) {
  const next = dayOffset.value + delta;
  if (next < 0) return; // no se agenda en el pasado
  dayOffset.value = next;
  selectedSlot.value = null; // un slot elegido en otro día no aplica al nuevo (review D-MED #5)
  void loadSlots();
}

function pickSlot(s: string) {
  selectedSlot.value = s;
  // clave de idempotencia estable para reintentos de ESTE slot (review B: idempotencia desde el cliente).
  idempotencyKey.value = crypto.randomUUID();
  step.value = 3;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ── formulario ──
const form = ref({ name: '', email: '', phone: '' });
const answers = ref<Record<string, string | undefined>>({});
const idempotencyKey = ref('');
const submitting = ref(false);
const submitError = ref('');
const confirmed = ref<Booking | null>(null);
// `null` en replay idempotente: el backend NO reexpone el token de gestión (review B/D-MED). Mostramos
// un fallback ("revisa tu correo") en vez de un enlace roto.
const manageToken = ref<string | null>(null);

const locLabel: Record<string, string> = {
  video: 'Videollamada',
  in_person: 'Presencial',
  phone: 'Teléfono',
  custom: '',
};

const canSubmit = computed(() => {
  if (!form.value.name.trim() || !/.+@.+\..+/.test(form.value.email)) return false;
  for (const q of ev.value?.customQuestions ?? []) {
    if (q.required && !(answers.value[q.id] ?? '').trim()) return false;
  }
  return true;
});

async function submit() {
  if (!ev.value || !selectedSlot.value || !canSubmit.value) return;
  submitting.value = true;
  submitError.value = '';
  const payload = {
    startAt: selectedSlot.value,
    invitee: {
      name: form.value.name.trim(),
      email: form.value.email.trim(),
      timezone: inviteeTz,
      ...(form.value.phone.trim() ? { phone: form.value.phone.trim() } : {}),
    },
    answers: ev.value.customQuestions
      .map((q) => ({
        questionId: q.id,
        label: q.label,
        answer: (answers.value[q.id] ?? '').trim(),
      }))
      .filter((a) => a.answer.length > 0),
  };
  try {
    const { data } = await api.post<{ booking: Booking; managementToken: string | null }>(
      `/schedule/public/${userSlug}/${eventSlug}/book`,
      payload,
      { headers: { 'Idempotency-Key': idempotencyKey.value } }
    );
    confirmed.value = data.booking;
    manageToken.value = data.managementToken;
    step.value = 4;
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 409) {
      submitError.value = 'Ese horario ya no está disponible. Elige otro.';
      step.value = 2;
      await loadSlots();
    } else if (status === 503) {
      submitError.value = 'Servicio ocupado, intenta de nuevo en un momento.';
    } else {
      submitError.value = 'No se pudo confirmar. Revisa tus datos e intenta otra vez.';
    }
  } finally {
    submitting.value = false;
  }
}

const manageUrl = computed(() =>
  manageToken.value ? `${window.location.origin}/booking/${manageToken.value}` : ''
);

onMounted(async () => {
  try {
    const { data } = await api.get<PublicEventType>(`/schedule/public/${userSlug}/${eventSlug}`);
    ev.value = data;
    await loadSlots();
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 404) loadErr.value = true;
    else serverError.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PublicLayout>
    <div v-if="loading" class="muted">Cargando…</div>
    <div v-else-if="serverError" class="notfound">
      <h2>Algo salió mal</h2>
      <p class="muted">Intenta de nuevo en un momento.</p>
    </div>
    <div v-else-if="loadErr || !ev" class="notfound"><h2>Reunión no encontrada</h2></div>
    <div v-else class="book">
      <div class="head">
        <h1>{{ ev.title }}</h1>
        <p class="muted">
          {{ ev.durationMinutes }} min<span v-if="locLabel[ev.location.type]">
            · {{ locLabel[ev.location.type] }}</span
          >
        </p>
        <p v-if="ev.description" class="desc">{{ ev.description }}</p>
        <p class="tz muted">Tu zona horaria: {{ inviteeTz }}</p>
      </div>

      <!-- Paso 1+2: día y hora -->
      <section v-if="step === 1 || step === 2" class="picker">
        <div class="daynav">
          <button class="ghost" :disabled="dayOffset === 0" @click="changeDay(-1)">‹</button>
          <strong class="dayname">{{ dayLabel }}</strong>
          <button class="ghost" @click="changeDay(1)">›</button>
        </div>
        <div v-if="slotsLoading" class="muted">Buscando horarios…</div>
        <div v-else-if="slots.length === 0" class="muted empty">
          No hay horarios disponibles este día.
        </div>
        <div v-else class="slots">
          <button
            v-for="s in slots"
            :key="s"
            type="button"
            class="slot"
            :class="{ on: selectedSlot === s }"
            :aria-pressed="selectedSlot === s"
            @click="pickSlot(s)"
          >
            {{ fmtTime(s) }}
          </button>
        </div>
        <p v-if="submitError && step === 2" class="err">{{ submitError }}</p>
      </section>

      <!-- Paso 3: datos del invitado -->
      <form v-else-if="step === 3" class="formstep" @submit.prevent="submit">
        <button type="button" class="back" @click="step = 2">‹ Cambiar horario</button>
        <p class="chosen">
          {{
            selectedDay.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })
          }}
          · {{ selectedSlot ? fmtTime(selectedSlot) : '' }}
        </p>
        <label
          >Nombre *<input v-model="form.name" type="text" autocomplete="name" maxlength="200"
        /></label>
        <label
          >Email *<input v-model="form.email" type="email" autocomplete="email" maxlength="320"
        /></label>
        <label
          >Teléfono<input v-model="form.phone" type="tel" autocomplete="tel" maxlength="64"
        /></label>
        <label v-for="q in ev.customQuestions" :key="q.id">
          {{ q.label }}<span v-if="q.required"> *</span>
          <textarea v-model="answers[q.id]" maxlength="4096" rows="2" />
        </label>
        <p v-if="submitError" class="err">{{ submitError }}</p>
        <button type="submit" class="primary" :disabled="!canSubmit || submitting">
          {{ submitting ? 'Confirmando…' : 'Confirmar reunión' }}
        </button>
      </form>

      <!-- Paso 4: confirmado -->
      <section v-else class="done">
        <div class="check">✓</div>
        <h2>¡Reunión confirmada!</h2>
        <p>
          Te enviamos los detalles a <strong>{{ confirmed?.invitee.email }}</strong
          >.
        </p>
        <p class="muted">
          {{
            confirmed
              ? new Date(confirmed.startAt).toLocaleString(undefined, {
                  dateStyle: 'full',
                  timeStyle: 'short',
                })
              : ''
          }}
        </p>
        <a v-if="manageUrl" :href="manageUrl" class="managelink"
          >Gestionar reserva (cancelar / reagendar)</a
        >
        <p v-else class="muted">
          Para cancelar o reagendar, usa el enlace del correo de confirmación.
        </p>
      </section>
    </div>
  </PublicLayout>
</template>

<style scoped>
.muted {
  color: var(--text-3, #8a8a8a);
}
.head h1 {
  margin: 0 0 4px;
}
.desc {
  margin: 8px 0;
}
.tz {
  font-size: 12px;
}
.daynav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 16px 0;
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
  cursor: default;
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
.slot:hover,
.slot.on {
  border-color: var(--accent);
  color: var(--accent);
}
.empty {
  padding: 24px 0;
  text-align: center;
}
.formstep {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}
.formstep label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
}
.formstep input,
.formstep textarea {
  padding: 10px;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  font: inherit;
}
.chosen {
  font-weight: 600;
  text-transform: capitalize;
}
.back {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  align-self: flex-start;
}
.primary {
  margin-top: 8px;
  padding: 12px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.err {
  color: #c0392b;
  font-size: 13px;
}
.done {
  text-align: center;
  padding: 32px 0;
}
.check {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 12px;
}
.managelink {
  display: inline-block;
  margin-top: 16px;
  color: var(--accent);
}
.notfound {
  text-align: center;
  padding: 48px 0;
}
</style>
