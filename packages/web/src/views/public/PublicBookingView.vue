<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/lib/http';
import PublicLayout from '@/layouts/PublicLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
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

// ── Calendario mensual ──
const now = new Date();
const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const viewMonth = ref(new Date(now.getFullYear(), now.getMonth(), 1));
const selectedDate = ref<Date | null>(null);

const monthLabel = computed(() =>
  viewMonth.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
);
const canPrevMonth = computed(
  () =>
    viewMonth.value.getFullYear() > startOfToday.getFullYear() ||
    (viewMonth.value.getFullYear() === startOfToday.getFullYear() &&
      viewMonth.value.getMonth() > startOfToday.getMonth())
);
// Iniciales de día derivadas del locale del navegador (consistentes con el mes; review D-017).
// 2024-01-01 fue lunes → generamos Lun..Dom en el idioma activo.
const WEEKDAY_LABELS = (() => {
  const f = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  return [0, 1, 2, 3, 4, 5, 6].map((i) => f.format(new Date(2024, 0, 1 + i)));
})();
interface Cell {
  date: Date | null;
  key: string;
}
const cells = computed<Cell[]>(() => {
  const y = viewMonth.value.getFullYear();
  const m = viewMonth.value.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // Lunes = 0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const out: Cell[] = [];
  for (let i = 0; i < startDow; i++) out.push({ date: null, key: `b${String(i)}` });
  for (let d = 1; d <= daysInMonth; d++)
    out.push({ date: new Date(y, m, d), key: `d${String(d)}` });
  return out;
});
function isPast(d: Date): boolean {
  return d.getTime() < startOfToday.getTime();
}
function isToday(d: Date): boolean {
  return d.getTime() === startOfToday.getTime();
}
function isSelected(d: Date): boolean {
  return selectedDate.value !== null && d.getTime() === selectedDate.value.getTime();
}
function isoDate(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function prevMonth() {
  if (!canPrevMonth.value) return;
  viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() - 1, 1);
}
function nextMonth() {
  viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + 1, 1);
}
function pickDay(d: Date) {
  if (isPast(d)) return;
  selectedDate.value = d;
  selectedSlot.value = null;
  step.value = 2;
  void loadSlots();
}
const dayLabel = computed(() =>
  selectedDate.value
    ? selectedDate.value.toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    : ''
);

const slots = ref<string[]>([]);
const slotsLoading = ref(false);
const selectedSlot = ref<string | null>(null);
// Guarda anti-respuestas-fuera-de-orden (review B/C/D): navegar fechas rápido podía pintar slots de un
// día anterior bajo el label actual. Sólo aplicamos la última petición. (Conservado del diseño previo.)
let slotsReq = 0;

async function loadSlots() {
  if (!selectedDate.value) return;
  const req = ++slotsReq;
  slotsLoading.value = true;
  slots.value = [];
  const from = new Date(selectedDate.value);
  const to = new Date(selectedDate.value);
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
    <div v-if="loading" class="state"><div class="spinner" /></div>
    <div v-else-if="serverError" class="state notfound" data-testid="pub-error">
      <h2>Algo salió mal</h2>
      <p class="muted">Intenta de nuevo en un momento.</p>
    </div>
    <div v-else-if="loadErr || !ev" class="state notfound" data-testid="pub-notfound">
      <h2>Reunión no encontrada</h2>
      <p class="muted">El enlace que buscas no existe o ya no está disponible.</p>
    </div>

    <div v-else class="book" data-testid="pub-book">
      <!-- Encabezado del tipo -->
      <div class="head">
        <h1>{{ ev.title }}</h1>
        <p class="meta">
          <AppIcon name="clock" :size="15" />
          {{ ev.durationMinutes }} min<span v-if="locLabel[ev.location.type]">
            · {{ locLabel[ev.location.type] }}</span
          >
        </p>
        <p v-if="ev.description" class="desc">{{ ev.description }}</p>
      </div>

      <!-- Stepper -->
      <ol v-if="step < 4" class="steps" aria-hidden="true">
        <li :class="{ on: step >= 1, done: step > 1 }"><span>1</span> Fecha</li>
        <li :class="{ on: step >= 2, done: step > 2 }"><span>2</span> Hora</li>
        <li :class="{ on: step >= 3 }"><span>3</span> Datos</li>
      </ol>

      <!-- Paso 1: calendario -->
      <section v-if="step === 1" class="picker">
        <div class="calhead">
          <button
            class="navbtn"
            :disabled="!canPrevMonth"
            aria-label="Mes anterior"
            @click="prevMonth"
          >
            <AppIcon name="chevronLeft" :size="18" />
          </button>
          <strong class="calmonth">{{ monthLabel }}</strong>
          <button class="navbtn" aria-label="Mes siguiente" @click="nextMonth">
            <AppIcon name="chevronRight" :size="18" />
          </button>
        </div>
        <div class="dow">
          <span v-for="(w, i) in WEEKDAY_LABELS" :key="i">{{ w }}</span>
        </div>
        <!-- Botones nativos (Tab + Enter/Espacio) → accesible por teclado sin semántica grid falsa
             (review B/D-014). aria-label da contexto al grupo. -->
        <div class="calgrid" data-testid="pub-calendar" role="group" :aria-label="monthLabel">
          <template v-for="c in cells" :key="c.key">
            <span v-if="!c.date" class="cal-blank" />
            <button
              v-else
              type="button"
              class="cal-day"
              :class="{ today: isToday(c.date), sel: isSelected(c.date) }"
              :disabled="isPast(c.date)"
              :aria-disabled="isPast(c.date)"
              :data-testid="`pub-day-${isoDate(c.date)}`"
              @click="pickDay(c.date)"
            >
              {{ c.date.getDate() }}
            </button>
          </template>
        </div>
        <p class="tz muted">Tu zona horaria: {{ inviteeTz }}</p>
      </section>

      <!-- Paso 2: horas del día elegido -->
      <section v-else-if="step === 2" class="picker">
        <button class="back" @click="step = 1">
          <AppIcon name="chevronLeft" :size="15" /> {{ monthLabel }}
        </button>
        <h2 class="dayname">{{ dayLabel }}</h2>
        <p class="tz muted">Horarios en tu zona — {{ inviteeTz }}</p>
        <div v-if="slotsLoading" class="muted center">Buscando horarios…</div>
        <div v-else-if="slots.length === 0" class="muted center empty">
          No hay horarios disponibles este día. Prueba otra fecha.
        </div>
        <div v-else class="slots">
          <button
            v-for="s in slots"
            :key="s"
            type="button"
            class="slot"
            :class="{ on: selectedSlot === s }"
            :aria-pressed="selectedSlot === s"
            :data-testid="`pub-slot-${s}`"
            @click="pickSlot(s)"
          >
            {{ fmtTime(s) }}
          </button>
        </div>
        <p v-if="submitError" class="err">{{ submitError }}</p>
      </section>

      <!-- Paso 3: datos del invitado -->
      <form v-else-if="step === 3" class="formstep" @submit.prevent="submit">
        <button type="button" class="back" @click="step = 2">
          <AppIcon name="chevronLeft" :size="15" /> Cambiar horario
        </button>
        <p class="chosen">{{ dayLabel }} · {{ selectedSlot ? fmtTime(selectedSlot) : '' }}</p>
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
        <button
          type="submit"
          class="primary"
          data-testid="pub-book-submit"
          :disabled="!canSubmit || submitting"
        >
          {{ submitting ? 'Confirmando…' : 'Confirmar reunión' }}
        </button>
      </form>

      <!-- Paso 4: confirmado -->
      <section v-else class="done" data-testid="pub-confirmed">
        <div class="check"><AppIcon name="check" :size="30" /></div>
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
.notfound {
  padding: 48px 0;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 700;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 14px;
  margin: 0;
}
.desc {
  margin: 10px 0 0;
  color: var(--text-2);
}
/* Stepper */
.steps {
  display: flex;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 20px 0;
}
.steps li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-3);
}
.steps li::after {
  content: '';
  width: 22px;
  height: 1px;
  background: var(--border);
  margin-left: 4px;
}
.steps li:last-child::after {
  display: none;
}
.steps li span {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-dim);
  border: 1px solid var(--border);
  font-size: 12px;
}
.steps li.on {
  color: var(--accent);
}
.steps li.on span {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
/* Calendario */
.calhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.calmonth {
  font-size: 15px;
  text-transform: capitalize;
}
.navbtn {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text-1);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.navbtn:disabled {
  opacity: 0.35;
  cursor: default;
}
.dow,
.calgrid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
}
.dow {
  margin-bottom: 6px;
}
.dow span {
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
}
.cal-blank {
  aspect-ratio: 1;
}
.cal-day {
  aspect-ratio: 1;
  min-height: 40px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--surface-dim);
  color: var(--text-1);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.1s,
    border-color 0.1s;
}
.cal-day:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.cal-day:disabled {
  opacity: 0.3;
  cursor: default;
  background: transparent;
}
.cal-day.today {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.cal-day.sel {
  background: var(--accent);
  color: #fff;
}
.tz {
  font-size: 12px;
  margin-top: 14px;
}
/* Horas */
.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font: inherit;
  font-weight: 600;
  font-size: 13.5px;
  margin-bottom: 8px;
}
.dayname {
  font-size: 17px;
  text-transform: capitalize;
  margin: 4px 0 2px;
}
.slots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.slot {
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text-1);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.slot:hover,
.slot.on {
  border-color: var(--accent);
  color: var(--accent);
}
.empty {
  padding: 28px 0;
}
/* Formulario */
.formstep {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}
.chosen {
  font-weight: 700;
  text-transform: capitalize;
  margin: 0;
}
.formstep label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-2);
}
.formstep input,
.formstep textarea {
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  font: inherit;
  font-weight: 400;
  background: var(--surface);
  color: var(--text-1);
}
.formstep input:focus,
.formstep textarea:focus {
  outline: none;
  border-color: var(--accent);
}
.primary {
  margin-top: 6px;
  padding: 12px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 10px;
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.err {
  color: var(--danger);
  font-size: 13px;
}
/* Confirmado */
.done {
  text-align: center;
  padding: 28px 0;
}
.check {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 14px;
}
.done h2 {
  margin: 0 0 8px;
}
.managelink {
  display: inline-block;
  margin-top: 16px;
  color: var(--accent);
  font-weight: 600;
}
</style>
