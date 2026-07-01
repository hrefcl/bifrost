<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import { vFocusTrap } from '@/lib/focusTrap';
import { useSchedulingStore, type EventTypeInput } from '@/stores/scheduling';
import type {
  WeeklyRule,
  AvailabilitySchedule,
  AvailabilityOverride,
  Booking,
} from '@webmail6/shared';
import { useMeetConfig } from '@/composables/useMeetConfig';

const { t } = useI18n();
const store = useSchedulingStore();

// Gate del toggle de Meet: sólo se ofrece "Incluir Bifrost Meet" si la instalación tiene Meet activo.
const meetAvailable = ref(false);
const { load: loadMeetConfig } = useMeetConfig();
void loadMeetConfig()
  .then((c) => {
    meetAvailable.value = c.meetEnabled;
  })
  .catch(() => {
    meetAvailable.value = false;
  });

type Tab = 'types' | 'availability' | 'bookings';
const tab = ref<Tab>('types');
const loading = ref(false);
const error = ref('');

// Incluye el protocolo para que el enlace copiado sea completo y compartible (review D-LOW #7).
const publicBase = computed(() => `${window.location.origin}/u/${store.username ?? '…'}`);
const publicHost = window.location.host;

onMounted(async () => {
  loading.value = true;
  try {
    await Promise.all([store.fetchProfile(), store.fetchSchedules(), store.fetchEventTypes()]);
    await store.fetchBookings();
  } catch {
    error.value = t('scheduling.loadError');
  } finally {
    loading.value = false;
  }
});

const copied = ref(false);
function copy(text: string) {
  void navigator.clipboard.writeText(text);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 1600);
}

// ── Username / enlace público ──
const showUsernameModal = ref(false);
const usernameDraft = ref('');
const usernameMsg = ref('');
const usernameSaving = ref(false);
function openUsernameModal() {
  usernameDraft.value = store.username ?? '';
  usernameMsg.value = '';
  showUsernameModal.value = true;
}
async function saveUsername() {
  usernameMsg.value = '';
  usernameSaving.value = true;
  try {
    await store.setUsername(usernameDraft.value.trim() || null);
    showUsernameModal.value = false;
  } catch (e) {
    usernameMsg.value =
      (e as { response?: { data?: { message?: string } } }).response?.data?.message ??
      t('scheduling.error');
  } finally {
    usernameSaving.value = false;
  }
}

// ── Event type modal ──
const showTypeModal = ref(false);
const editingId = ref<string | null>(null);
const form = ref<EventTypeInput>(blankType());
function blankType(): EventTypeInput {
  return {
    slug: '',
    title: '',
    description: '',
    durationMinutes: 30,
    color: '#3b82f6',
    location: { type: 'video', value: '' },
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minimumNoticeMin: 0,
    dateRangeDays: 60,
    dailyLimit: 0,
    availabilityScheduleId: store.schedules[0]?.id ?? '',
    customQuestions: [],
    active: true,
    meetEnabled: false,
  };
}
const typeError = ref('');
function openCreateType() {
  editingId.value = null;
  form.value = blankType();
  typeError.value = '';
  showTypeModal.value = true;
}
function openEditType(id: string) {
  const ev = store.eventTypes.find((e) => e.id === id);
  if (!ev) return;
  editingId.value = id;
  form.value = { ...ev };
  typeError.value = '';
  showTypeModal.value = true;
}
async function saveType() {
  typeError.value = '';
  try {
    if (editingId.value) await store.updateEventType(editingId.value, form.value);
    else await store.createEventType(form.value);
    showTypeModal.value = false;
  } catch (e) {
    typeError.value =
      (e as { response?: { data?: { message?: string } } }).response?.data?.message ??
      t('scheduling.error');
  }
}
async function toggleActive(id: string, active: boolean) {
  await store.updateEventType(id, { active });
}

// ── Availability (reglas semanales) ──
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // Lun..Dom (0=Dom)
const sched = computed<AvailabilitySchedule | undefined>(
  () => store.schedules.find((s) => s.isDefault) ?? store.schedules.at(0)
);
function rulesFor(weekday: number): { start: string; end: string }[] {
  const r = sched.value?.weeklyRules.find((w: WeeklyRule) => w.weekday === weekday);
  return r ? r.intervals : [];
}
const availMsg = ref('');
async function saveAvailability(weeklyRules: WeeklyRule[]) {
  if (!sched.value) return;
  availMsg.value = '';
  try {
    await store.updateSchedule(sched.value.id, { weeklyRules });
    availMsg.value = t('scheduling.saved');
  } catch {
    availMsg.value = t('scheduling.error');
  }
}
function toggleDay(weekday: number, on: boolean) {
  if (!sched.value) return;
  const rules = sched.value.weeklyRules.filter((w) => w.weekday !== weekday);
  if (on) rules.push({ weekday, intervals: [{ start: '09:00', end: '18:00' }] });
  void saveAvailability(rules);
}

/** Clona las reglas actuales (para editar sin mutar el store directamente). */
function cloneRules(): WeeklyRule[] {
  return (sched.value?.weeklyRules ?? []).map((w) => ({
    weekday: w.weekday,
    intervals: w.intervals.map((iv) => ({ start: iv.start, end: iv.end })),
  }));
}

function setInterval(weekday: number, index: number, field: 'start' | 'end', value: string) {
  const rules = cloneRules();
  const rule = rules.find((w) => w.weekday === weekday);
  const iv = rule?.intervals[index];
  if (!iv) return;
  iv[field] = value;
  // Validación mínima en cliente (el backend revalida): end > start. Si no, no guardamos.
  if (iv.end <= iv.start) {
    availMsg.value = t('scheduling.invalidInterval');
    return;
  }
  void saveAvailability(rules);
}

function addInterval(weekday: number) {
  const rules = cloneRules();
  let rule = rules.find((w) => w.weekday === weekday);
  if (!rule) {
    rule = { weekday, intervals: [] };
    rules.push(rule);
  }
  // Por defecto, una tarde después del último intervalo (o 09–18 si está vacío).
  const last = rule.intervals.at(-1);
  rule.intervals.push(last ? { start: '14:00', end: '18:00' } : { start: '09:00', end: '18:00' });
  void saveAvailability(rules);
}

function removeInterval(weekday: number, index: number) {
  const rules = cloneRules();
  const rule = rules.find((w) => w.weekday === weekday);
  if (!rule) return;
  rule.intervals.splice(index, 1);
  // Si el día queda sin intervalos, se elimina la regla (día no disponible).
  const cleaned = rules.filter((w) => w.intervals.length > 0);
  void saveAvailability(cleaned);
}

async function saveTimezone(tz: string) {
  if (!sched.value || !tz || tz === sched.value.timezone) return;
  availMsg.value = '';
  try {
    await store.updateSchedule(sched.value.id, { timezone: tz });
    availMsg.value = t('scheduling.saved');
  } catch {
    availMsg.value = t('scheduling.error');
  }
}
// Lista acotada de zonas horarias comunes (el backend acepta cualquier IANA válida).
const COMMON_TZ = [
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'America/Mexico_City',
  'America/Bogota',
  'America/Lima',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Madrid',
  'Europe/London',
  'UTC',
];
// Garantiza que la tz actual del horario aparezca en el select aunque no esté en la lista común.
const tzOptions = computed(() => {
  const tz = sched.value?.timezone;
  return tz && !COMMON_TZ.includes(tz) ? [tz, ...COMMON_TZ] : COMMON_TZ;
});
async function ensureDefaultSchedule() {
  if (store.schedules.length === 0) {
    await store.createSchedule({
      name: t('scheduling.workHours'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weeklyRules: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        intervals: [{ start: '09:00', end: '18:00' }],
      })),
      overrides: [],
      isDefault: true,
    });
  }
}

// ── Excepciones (overrides) ──
// El override REEMPLAZA la regla del día: `intervals:[]` = no disponible; con intervalos = horario
// especial. Se ancla a la tz del schedule (no a la del browser) — review C-MUST-2.
const overrides = computed<AvailabilityOverride[]>(() =>
  [...(sched.value?.overrides ?? [])].sort((a, b) => a.date.localeCompare(b.date))
);
const showExcModal = ref(false);
const excOriginalDate = ref<string | null>(null); // null = alta
const excForm = ref<{
  date: string;
  allDay: boolean;
  intervals: { start: string; end: string }[];
  note: string;
}>({ date: '', allDay: true, intervals: [{ start: '09:00', end: '18:00' }], note: '' });
const excError = ref('');
const excListMsg = ref(''); // feedback de errores fuera del modal (borrado desde la lista)
const excSaving = ref(false);
// Snapshot de las excepciones al abrir el editor: detecta cambios concurrentes al guardar (B-HIGH).
function snapshotOverrides(): AvailabilityOverride[] {
  return (sched.value?.overrides ?? []).map((o) => ({
    date: o.date,
    note: o.note,
    intervals: o.intervals.map((iv) => ({ start: iv.start, end: iv.end })),
  }));
}
const excBaseline = ref<AvailabilityOverride[]>([]);

/** Hoy (YYYY-MM-DD) en la zona horaria del schedule, para el guard de fecha pasada. */
function todayInScheduleTz(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: sched.value?.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
function fmtExcDate(date: string): string {
  // Mediodía evita el corrimiento de día por zona horaria al formatear una fecha de calendario.
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
function openCreateExc() {
  excOriginalDate.value = null;
  excBaseline.value = snapshotOverrides();
  excForm.value = {
    date: '',
    allDay: true,
    intervals: [{ start: '09:00', end: '18:00' }],
    note: '',
  };
  excError.value = '';
  showExcModal.value = true;
}
function openEditExc(o: AvailabilityOverride) {
  excOriginalDate.value = o.date;
  excBaseline.value = snapshotOverrides();
  excForm.value = {
    date: o.date,
    allDay: o.intervals.length === 0,
    intervals: o.intervals.length
      ? o.intervals.map((iv) => ({ ...iv }))
      : [{ start: '09:00', end: '18:00' }],
    note: o.note ?? '',
  };
  excError.value = '';
  showExcModal.value = true;
}
function addExcInterval() {
  const last = excForm.value.intervals.at(-1);
  excForm.value.intervals.push(
    last ? { start: '14:00', end: '18:00' } : { start: '09:00', end: '18:00' }
  );
}
function removeExcInterval(i: number) {
  excForm.value.intervals.splice(i, 1);
}
async function saveExc() {
  excError.value = '';
  if (!sched.value) return;
  const f = excForm.value;
  if (!f.date) {
    excError.value = t('scheduling.excDate');
    return;
  }
  // Guard de fecha pasada (cliente; el backend no lo exige) — review D-008. Permite editar una existente.
  if (f.date < todayInScheduleTz() && f.date !== excOriginalDate.value) {
    excError.value = t('scheduling.excPastDate');
    return;
  }
  // Choque de fecha: crear (o mover) sobre una fecha que YA tiene otra excepción → avisar, no pisar
  // en silencio (review B-MED / C#2 / D-015 — usa la clave excDupDate, antes no usada).
  if (overrides.value.some((o) => o.date === f.date && o.date !== excOriginalDate.value)) {
    excError.value = t('scheduling.excDupDate');
    return;
  }
  let intervals: { start: string; end: string }[] = [];
  if (!f.allDay) {
    if (f.intervals.length === 0) {
      excError.value = t('scheduling.excNoIntervals');
      return;
    }
    // Ordenar por inicio y validar end>start + SIN solapes (el backend también lo valida → 400;
    // validamos en cliente para feedback claro, review C#1).
    const sorted = [...f.intervals].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].end <= sorted[i].start) {
        excError.value = t('scheduling.invalidInterval');
        return;
      }
      if (i > 0 && sorted[i].start < sorted[i - 1].end) {
        excError.value = t('scheduling.excOverlap');
        return;
      }
    }
    intervals = sorted.map((iv) => ({ start: iv.start, end: iv.end }));
  }
  const next: AvailabilityOverride = {
    date: f.date,
    intervals,
    ...(f.note.trim() ? { note: f.note.trim() } : {}),
  };
  excSaving.value = true;
  try {
    // read-modify-write fresco con detección de conflicto (baseline); dedup por fecha (quita la
    // original si cambió + cualquiera con la nueva fecha).
    await store.saveOverrides(sched.value.id, excBaseline.value, (cur) => {
      const filtered = cur.filter((o) => o.date !== next.date && o.date !== excOriginalDate.value);
      filtered.push(next);
      return filtered;
    });
    showExcModal.value = false;
  } catch (e) {
    excError.value =
      (e as Error).message === 'overrides-conflict'
        ? t('scheduling.excConflict')
        : t('scheduling.error');
  } finally {
    excSaving.value = false;
  }
}
async function deleteExc(date: string) {
  if (!sched.value) return;
  if (!confirm(t('scheduling.confirmDeleteException'))) return;
  excListMsg.value = '';
  const baseline = snapshotOverrides();
  excSaving.value = true;
  try {
    await store.saveOverrides(sched.value.id, baseline, (cur) =>
      cur.filter((o) => o.date !== date)
    );
  } catch (e) {
    excListMsg.value =
      (e as Error).message === 'overrides-conflict'
        ? t('scheduling.excConflict')
        : t('scheduling.error');
  } finally {
    excSaving.value = false;
  }
}

// ── Bookings ──
const detailBooking = ref<Booking | null>(null);
function openDetail(b: Booking) {
  detailBooking.value = b;
}
async function cancelBooking(id: string) {
  if (!confirm(t('scheduling.confirmCancel'))) return;
  await store.cancelBooking(id);
  if (detailBooking.value?.id === id) detailBooking.value = null;
}
function fmt(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  }).format(new Date(iso));
}
const locLabel: Record<string, string> = {
  video: 'scheduling.loc_video',
  in_person: 'scheduling.loc_in_person',
  phone: 'scheduling.loc_phone',
  custom: 'scheduling.loc_custom',
};
</script>

<template>
  <AppLayout>
    <div class="sched">
      <!-- Cabecera -->
      <header class="sched__head">
        <div class="sched__title">
          <AppIcon name="calendarClock" :size="24" />
          <h1>{{ t('scheduling.title') }}</h1>
        </div>

        <!-- Enlace público -->
        <div v-if="store.username" class="linkbar" data-testid="sched-public-link">
          <AppIcon name="globe" :size="16" class="linkbar__ico" />
          <span class="linkbar__url">{{ publicBase }}</span>
          <div class="linkbar__actions">
            <button class="chip" @click="copy(publicBase)">
              <AppIcon name="copy" :size="14" /> {{ copied ? '✓' : t('scheduling.copy') }}
            </button>
            <a class="chip" :href="`/u/${store.username}`" target="_blank" rel="noopener">
              <AppIcon name="externalLink" :size="14" /> {{ t('scheduling.viewPage') }}
            </a>
            <button class="chip" @click="openUsernameModal">
              <AppIcon name="pencil" :size="14" /> {{ t('scheduling.editLink') }}
            </button>
          </div>
        </div>
        <button v-else class="linkbar linkbar--cta" @click="openUsernameModal">
          <AppIcon name="globe" :size="16" />
          <span>{{ t('scheduling.setUsername') }}</span>
          <span class="chip chip--solid">{{ t('scheduling.save') }}</span>
        </button>
      </header>

      <!-- Tabs -->
      <nav class="sched__tabs" role="tablist">
        <button
          role="tab"
          :aria-selected="tab === 'types'"
          :class="{ on: tab === 'types' }"
          data-testid="sched-tab-types"
          @click="tab = 'types'"
        >
          {{ t('scheduling.tabTypes') }}
        </button>
        <button
          role="tab"
          :aria-selected="tab === 'availability'"
          :class="{ on: tab === 'availability' }"
          data-testid="sched-tab-availability"
          @click="tab = 'availability'"
        >
          {{ t('scheduling.tabAvailability') }}
        </button>
        <button
          role="tab"
          :aria-selected="tab === 'bookings'"
          :class="{ on: tab === 'bookings' }"
          data-testid="sched-tab-bookings"
          @click="tab = 'bookings'"
        >
          {{ t('scheduling.tabBookings') }}
        </button>
      </nav>

      <p v-if="error" class="sched__err">{{ error }}</p>
      <p v-else-if="loading" class="sched__muted">{{ t('common.loading') }}</p>

      <!-- ════════ TIPOS ════════ -->
      <section v-else-if="tab === 'types'">
        <div class="sched__rowend">
          <button class="btn" data-testid="sched-new-type" @click="openCreateType">
            <AppIcon name="plus" :size="16" /> {{ t('scheduling.newType') }}
          </button>
        </div>
        <div v-if="store.eventTypes.length === 0" class="empty">
          <AppIcon name="calendarClock" :size="32" />
          <p>{{ t('scheduling.noTypes') }}</p>
        </div>
        <div v-else class="grid">
          <article
            v-for="ev in store.eventTypes"
            :key="ev.id"
            class="etype"
            :class="{ 'etype--off': !ev.active }"
          >
            <span class="etype__bar" :style="{ background: ev.color }" />
            <div class="etype__main">
              <div class="etype__top">
                <strong class="etype__title">{{ ev.title }}</strong>
                <label
                  class="switch"
                  :title="ev.active ? t('scheduling.active') : t('scheduling.inactive')"
                >
                  <input
                    type="checkbox"
                    :checked="ev.active"
                    @change="toggleActive(ev.id, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="switch__track"><span class="switch__thumb" /></span>
                </label>
              </div>
              <div class="etype__meta">
                {{ ev.durationMinutes }} min ·
                {{ t(locLabel[ev.location.type] ?? 'scheduling.loc_custom') }}
              </div>
              <code class="etype__slug">/u/{{ store.username ?? '…' }}/{{ ev.slug }}</code>
              <div class="etype__actions">
                <button class="link" @click="openEditType(ev.id)">
                  <AppIcon name="pencil" :size="14" /> {{ t('scheduling.edit') }}
                </button>
                <button class="link" @click="copy(`${publicBase}/${ev.slug}`)">
                  <AppIcon name="copy" :size="14" /> {{ t('scheduling.copy') }}
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- ════════ DISPONIBILIDAD ════════ -->
      <section v-else-if="tab === 'availability'">
        <div v-if="!sched" class="empty">
          <p>{{ t('scheduling.noSchedule') }}</p>
          <button class="btn" @click="ensureDefaultSchedule">
            {{ t('scheduling.createSchedule') }}
          </button>
        </div>
        <template v-else>
          <div class="card">
            <label class="tz">
              <span>{{ t('scheduling.timezone') }}</span>
              <select
                :value="sched.timezone"
                @change="saveTimezone(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="tz in tzOptions" :key="tz" :value="tz">{{ tz }}</option>
              </select>
            </label>
            <div v-for="wd in WEEKDAYS" :key="wd" class="day">
              <label class="day__name">
                <input
                  type="checkbox"
                  :checked="rulesFor(wd).length > 0"
                  @change="toggleDay(wd, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ t('scheduling.weekday_' + wd) }}</span>
              </label>
              <div v-if="rulesFor(wd).length" class="day__intervals">
                <div v-for="(iv, i) in rulesFor(wd)" :key="i" class="iv">
                  <input
                    type="time"
                    :value="iv.start"
                    @change="setInterval(wd, i, 'start', ($event.target as HTMLInputElement).value)"
                  />
                  <span class="iv__dash">–</span>
                  <input
                    type="time"
                    :value="iv.end"
                    @change="setInterval(wd, i, 'end', ($event.target as HTMLInputElement).value)"
                  />
                  <button
                    type="button"
                    class="iv__rm"
                    :title="t('scheduling.removeInterval')"
                    @click="removeInterval(wd, i)"
                  >
                    <AppIcon name="x" :size="14" />
                  </button>
                </div>
                <button type="button" class="iv__add" @click="addInterval(wd)">
                  <AppIcon name="plus" :size="13" /> {{ t('scheduling.addInterval') }}
                </button>
              </div>
              <span v-else class="day__off">{{ t('scheduling.unavailable') }}</span>
            </div>
            <p class="sched__msg">{{ availMsg }}</p>
          </div>

          <!-- Excepciones -->
          <div class="card">
            <div class="card__head">
              <div>
                <h2 class="card__h">{{ t('scheduling.exceptions') }}</h2>
                <p class="card__sub">{{ t('scheduling.exceptionsHint') }}</p>
              </div>
              <button
                class="btn btn--ghost"
                data-testid="sched-new-exception"
                @click="openCreateExc"
              >
                <AppIcon name="plus" :size="15" /> {{ t('scheduling.newException') }}
              </button>
            </div>
            <p class="tz-note">
              {{ t('scheduling.excTzNote') }} <code>{{ sched.timezone }}</code>
            </p>
            <p v-if="excListMsg" class="sched__err">{{ excListMsg }}</p>
            <p v-if="overrides.length === 0" class="sched__muted">
              {{ t('scheduling.noExceptions') }}
            </p>
            <ul v-else class="exc-list">
              <li v-for="o in overrides" :key="o.date" class="exc">
                <div class="exc__date">{{ fmtExcDate(o.date) }}</div>
                <div class="exc__body">
                  <span v-if="o.intervals.length === 0" class="exc__tag exc__tag--off">
                    {{ t('scheduling.excAllDay') }}
                  </span>
                  <span v-else class="exc__tag">
                    {{ o.intervals.map((iv) => `${iv.start}–${iv.end}`).join(', ') }}
                  </span>
                  <span v-if="o.note" class="exc__note">{{ o.note }}</span>
                </div>
                <div class="exc__actions">
                  <button class="link" :disabled="excSaving" @click="openEditExc(o)">
                    <AppIcon name="pencil" :size="14" /> {{ t('scheduling.edit') }}
                  </button>
                  <button
                    class="link link--danger"
                    :disabled="excSaving"
                    @click="deleteExc(o.date)"
                  >
                    <AppIcon name="trash" :size="14" /> {{ t('scheduling.delete') }}
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </template>
      </section>

      <!-- ════════ RESERVAS ════════ -->
      <section v-else>
        <p class="sched__muted sched__synced">
          <AppIcon name="calendar" :size="15" /> {{ t('scheduling.syncNote') }}
        </p>
        <div v-if="store.bookings.length === 0" class="empty">
          <AppIcon name="inbox" :size="32" />
          <p>{{ t('scheduling.noBookings') }}</p>
        </div>
        <ul v-else class="bookings">
          <li
            v-for="b in store.bookings"
            :key="b.id"
            class="bk"
            :class="{ 'bk--off': b.status !== 'confirmed' }"
          >
            <div class="bk__when">{{ fmt(b.startAt, b.snapshot.timezone) }}</div>
            <div class="bk__info">
              <strong>{{ b.snapshot.title }}</strong>
              <span class="bk__guest">{{ b.invitee.name }} · {{ b.invitee.email }}</span>
            </div>
            <span class="bk__status" :class="b.status">{{
              t('scheduling.status_' + b.status)
            }}</span>
            <div class="bk__actions">
              <button class="link" @click="openDetail(b)">{{ t('scheduling.detail') }}</button>
              <button
                v-if="b.status === 'confirmed'"
                class="link link--danger"
                @click="cancelBooking(b.id)"
              >
                {{ t('scheduling.cancel') }}
              </button>
            </div>
          </li>
        </ul>
      </section>

      <!-- ════════ Modal: tipo de reunión ════════ -->
      <div
        v-if="showTypeModal"
        class="modal"
        @keydown.esc="showTypeModal = false"
        @click.self="showTypeModal = false"
      >
        <div
          v-focus-trap
          tabindex="-1"
          class="modal__box"
          role="dialog"
          aria-modal="true"
          :style="{ borderTopColor: form.color }"
        >
          <h3 class="modal__h">
            {{ editingId ? t('scheduling.editType') : t('scheduling.newType') }}
          </h3>
          <div class="modal__grid">
            <label class="f f--wide"
              ><span>{{ t('scheduling.name') }}</span
              ><input v-model="form.title"
            /></label>
            <label class="f"
              ><span>{{ t('scheduling.slug') }}</span
              ><input v-model="form.slug" placeholder="30min"
            /></label>
            <label class="f"
              ><span>{{ t('scheduling.duration') }}</span
              ><input v-model.number="form.durationMinutes" type="number" min="5" max="1440"
            /></label>
            <label class="f"
              ><span>{{ t('scheduling.color') }}</span
              ><input v-model="form.color" type="color" class="f__color"
            /></label>
            <label class="f">
              <span>{{ t('scheduling.locationType') }}</span>
              <select v-model="form.location.type">
                <option value="video">{{ t('scheduling.loc_video') }}</option>
                <option value="in_person">{{ t('scheduling.loc_in_person') }}</option>
                <option value="phone">{{ t('scheduling.loc_phone') }}</option>
                <option value="custom">{{ t('scheduling.loc_custom') }}</option>
              </select>
            </label>
            <label class="f f--wide"
              ><span>{{ t('scheduling.locationValue') }}</span
              ><input v-model="form.location.value"
            /></label>
            <!-- Bifrost Meet: crea sala de videollamada nativa para este tipo (sólo si Meet está activo). -->
            <label v-if="meetAvailable" class="f f--wide f--check">
              <input v-model="form.meetEnabled" type="checkbox" />
              <span>{{ t('meet.enableLabel') }}</span>
            </label>
            <p v-if="meetAvailable && form.meetEnabled" class="f--wide meet-hint">
              {{ t('meet.enableHint') }}
            </p>
            <label class="f"
              ><span>{{ t('scheduling.bufferBefore') }}</span
              ><input v-model.number="form.bufferBeforeMin" type="number" min="0"
            /></label>
            <label class="f"
              ><span>{{ t('scheduling.bufferAfter') }}</span
              ><input v-model.number="form.bufferAfterMin" type="number" min="0"
            /></label>
            <label class="f">
              <span>{{ t('scheduling.minNoticeH') }}</span>
              <input
                :value="Math.round(form.minimumNoticeMin / 60)"
                type="number"
                min="0"
                @input="
                  form.minimumNoticeMin = Number(($event.target as HTMLInputElement).value) * 60
                "
              />
            </label>
            <label class="f"
              ><span>{{ t('scheduling.dateRange') }}</span
              ><input v-model.number="form.dateRangeDays" type="number" min="1" max="365"
            /></label>
            <label class="f"
              ><span>{{ t('scheduling.dailyLimit') }}</span
              ><input v-model.number="form.dailyLimit" type="number" min="0"
            /></label>
            <label class="f f--wide">
              <span>{{ t('scheduling.schedule') }}</span>
              <select v-model="form.availabilityScheduleId">
                <option v-for="s in store.schedules" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </label>
          </div>
          <p v-if="typeError" class="sched__err">{{ typeError }}</p>
          <div class="modal__actions">
            <button class="btn btn--ghost" @click="showTypeModal = false">
              {{ t('scheduling.cancel') }}
            </button>
            <span class="spacer" />
            <button class="btn" @click="saveType">{{ t('scheduling.save') }}</button>
          </div>
        </div>
      </div>

      <!-- ════════ Modal: excepción ════════ -->
      <div
        v-if="showExcModal"
        class="modal"
        data-testid="sched-exception-modal"
        @keydown.esc="showExcModal = false"
        @click.self="showExcModal = false"
      >
        <div
          v-focus-trap
          tabindex="-1"
          class="modal__box modal__box--sm"
          role="dialog"
          aria-modal="true"
        >
          <h3 class="modal__h">
            {{ excOriginalDate ? t('scheduling.editException') : t('scheduling.newException') }}
          </h3>
          <label class="f"
            ><span>{{ t('scheduling.excDate') }}</span
            ><input v-model="excForm.date" type="date"
          /></label>
          <div class="seg">
            <button class="seg__opt" :class="{ on: excForm.allDay }" @click="excForm.allDay = true">
              {{ t('scheduling.excAllDay') }}
            </button>
            <button
              class="seg__opt"
              :class="{ on: !excForm.allDay }"
              @click="excForm.allDay = false"
            >
              {{ t('scheduling.excSpecial') }}
            </button>
          </div>
          <p class="seg__hint">
            {{ excForm.allDay ? t('scheduling.excAllDayHint') : t('scheduling.excSpecialHint') }}
          </p>
          <div v-if="!excForm.allDay" class="exc-iv">
            <div v-for="(iv, i) in excForm.intervals" :key="i" class="iv">
              <input v-model="iv.start" type="time" />
              <span class="iv__dash">–</span>
              <input v-model="iv.end" type="time" />
              <button type="button" class="iv__rm" @click="removeExcInterval(i)">
                <AppIcon name="x" :size="14" />
              </button>
            </div>
            <button type="button" class="iv__add" @click="addExcInterval">
              <AppIcon name="plus" :size="13" /> {{ t('scheduling.addInterval') }}
            </button>
          </div>
          <label class="f"
            ><span>{{ t('scheduling.excNote') }}</span
            ><input v-model="excForm.note" maxlength="200"
          /></label>
          <p v-if="excError" class="sched__err">{{ excError }}</p>
          <div class="modal__actions">
            <button class="btn btn--ghost" :disabled="excSaving" @click="showExcModal = false">
              {{ t('scheduling.cancel') }}
            </button>
            <span class="spacer" />
            <button class="btn" :disabled="excSaving" @click="saveExc">
              {{ excSaving ? t('scheduling.saving') : t('scheduling.save') }}
            </button>
          </div>
        </div>
      </div>

      <!-- ════════ Modal: detalle de reserva ════════ -->
      <div
        v-if="detailBooking"
        class="modal"
        @keydown.esc="detailBooking = null"
        @click.self="detailBooking = null"
      >
        <div
          v-focus-trap
          tabindex="-1"
          class="modal__box modal__box--sm"
          role="dialog"
          aria-modal="true"
        >
          <h3 class="modal__h">{{ detailBooking.snapshot.title }}</h3>
          <dl class="dl">
            <dt>{{ t('scheduling.timezone') }}</dt>
            <dd>
              {{ fmt(detailBooking.startAt, detailBooking.snapshot.timezone) }} ({{
                detailBooking.snapshot.timezone
              }})
            </dd>
            <dt>{{ t('scheduling.guest') }}</dt>
            <dd>{{ detailBooking.invitee.name }} · {{ detailBooking.invitee.email }}</dd>
            <template v-if="detailBooking.invitee.phone">
              <dt>{{ t('scheduling.phone') }}</dt>
              <dd>{{ detailBooking.invitee.phone }}</dd>
            </template>
            <dt>{{ t('scheduling.locationType') }}</dt>
            <dd>
              {{ t(locLabel[detailBooking.snapshot.location.type] ?? 'scheduling.loc_custom') }}
            </dd>
            <template v-for="a in detailBooking.answers" :key="a.questionId">
              <dt>{{ a.label }}</dt>
              <dd>{{ a.answer }}</dd>
            </template>
            <dt>{{ t('scheduling.created') }}</dt>
            <dd>{{ fmt(detailBooking.createdAt, detailBooking.snapshot.timezone) }}</dd>
          </dl>
          <div class="modal__actions">
            <button
              v-if="detailBooking.status === 'confirmed'"
              class="btn btn--ghost link--danger"
              @click="cancelBooking(detailBooking.id)"
            >
              {{ t('scheduling.cancel') }}
            </button>
            <span class="spacer" />
            <button class="btn btn--ghost" @click="detailBooking = null">
              {{ t('scheduling.close') }}
            </button>
          </div>
        </div>
      </div>

      <!-- ════════ Modal: enlace público / username ════════ -->
      <div
        v-if="showUsernameModal"
        class="modal"
        @keydown.esc="showUsernameModal = false"
        @click.self="showUsernameModal = false"
      >
        <div
          v-focus-trap
          tabindex="-1"
          class="modal__box modal__box--sm"
          role="dialog"
          aria-modal="true"
        >
          <h3 class="modal__h">{{ t('scheduling.usernameTitle') }}</h3>
          <p class="card__sub">{{ t('scheduling.usernameModalHint') }}</p>
          <label class="f f--url">
            <span class="f__prefix">{{ `${publicHost}/u/` }}</span>
            <input v-model="usernameDraft" placeholder="ana" autocapitalize="none" />
          </label>
          <p class="card__sub card__sub--warn">{{ t('scheduling.usernameNeedSmtp') }}</p>
          <p v-if="usernameMsg" class="sched__err">{{ usernameMsg }}</p>
          <div class="modal__actions">
            <button
              class="btn btn--ghost"
              :disabled="usernameSaving"
              @click="showUsernameModal = false"
            >
              {{ t('scheduling.cancel') }}
            </button>
            <span class="spacer" />
            <button class="btn" :disabled="usernameSaving" @click="saveUsername">
              {{ usernameSaving ? t('scheduling.saving') : t('scheduling.save') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.sched {
  height: 100%;
  overflow-y: auto;
  padding: 22px clamp(16px, 4vw, 36px) 48px;
  color: var(--text-1);
}
.sched__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 18px;
}
.sched__title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sched__title :deep(svg) {
  color: var(--accent);
}
.sched__title h1 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
}
/* Barra de enlace público */
.linkbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  max-width: 100%;
  font: inherit;
}
.linkbar__ico {
  color: var(--accent);
}
.linkbar__url {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.linkbar__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.linkbar--cta {
  cursor: pointer;
  color: var(--text-2);
  font-weight: 600;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
}
.chip:hover {
  background: var(--hover);
  color: var(--text-1);
}
.chip--solid {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
/* Tabs */
.sched__tabs {
  display: inline-flex;
  gap: 2px;
  background: var(--surface-dim);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 3px;
  margin-bottom: 18px;
}
.sched__tabs button {
  padding: 7px 16px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
}
.sched__tabs button.on {
  background: var(--surface);
  color: var(--accent);
  box-shadow: var(--shadow-sm);
}
.sched__tabs button:focus-visible {
  outline: 2px solid var(--accent);
}
.sched__err {
  color: var(--danger);
  font-size: 13.5px;
}
.sched__muted {
  color: var(--text-3);
}
.sched__synced {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin: 0 0 14px;
}
.sched__msg {
  color: var(--text-3);
  font-size: 12px;
  min-height: 16px;
}
/* Empty state */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 16px;
  color: var(--text-3);
  text-align: center;
}
.empty :deep(svg) {
  opacity: 0.5;
}
/* Tipos */
.sched__rowend {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 14px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.etype {
  display: flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.14s;
}
.etype:hover {
  box-shadow: var(--shadow-md);
}
.etype--off {
  opacity: 0.6;
}
.etype__bar {
  width: 5px;
  flex-shrink: 0;
}
.etype__main {
  padding: 14px 16px;
  flex: 1;
  min-width: 0;
}
.etype__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.etype__title {
  font-size: 15px;
  font-weight: 700;
}
.etype__meta {
  color: var(--text-2);
  font-size: 13px;
  margin: 4px 0 8px;
}
.etype__slug {
  display: block;
  font-size: 12px;
  color: var(--text-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.etype__actions {
  display: flex;
  gap: 12px;
  margin-top: 10px;
}
/* Switch */
.switch {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}
.switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.switch__track {
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: var(--border-strong);
  transition: background 0.15s;
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
}
.switch__thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.switch input:checked + .switch__track {
  background: var(--accent);
}
.switch input:checked + .switch__track .switch__thumb {
  transform: translateX(14px);
}
.switch input:focus-visible + .switch__track {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* Card */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px;
  box-shadow: var(--shadow-sm);
  margin-bottom: 16px;
}
.card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.card__h {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
}
.card__sub {
  font-size: 13px;
  color: var(--text-3);
  margin: 2px 0 0;
}
.card__sub--warn {
  color: var(--amber, #d97706);
}
.tz {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.tz select {
  font: inherit;
  padding: 7px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-1);
}
.tz-note {
  font-size: 12px;
  color: var(--text-3);
  margin: 2px 0 12px;
}
.tz-note code {
  color: var(--text-2);
  font: inherit;
}
/* Días */
.day {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.day:last-child {
  border-bottom: none;
}
.day__name {
  width: 116px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 7px;
  font-size: 14px;
  font-weight: 600;
}
.day__intervals {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.iv {
  display: flex;
  align-items: center;
  gap: 6px;
}
.iv input[type='time'] {
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font: inherit;
  background: var(--surface);
  color: var(--text-1);
}
.iv__dash {
  color: var(--text-3);
}
.iv__rm {
  display: inline-flex;
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}
.iv__rm:hover {
  color: var(--danger);
  background: var(--hover);
}
.iv__add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 5px 11px;
}
.day__off {
  color: var(--text-3);
  padding-top: 7px;
  font-size: 13.5px;
}
/* Excepciones */
.exc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.exc {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-dim);
}
.exc__date {
  font-weight: 700;
  font-size: 13.5px;
  text-transform: capitalize;
  width: 150px;
  flex-shrink: 0;
}
.exc__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.exc__tag {
  font-size: 12.5px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.exc__tag--off {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.exc__note {
  font-size: 12.5px;
  color: var(--text-3);
}
.exc__actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
/* Reservas */
.bookings {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bk {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.bk--off {
  opacity: 0.55;
}
.bk__when {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  width: 170px;
  flex-shrink: 0;
}
.bk__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.bk__guest {
  font-size: 12.5px;
  color: var(--text-3);
}
.bk__status {
  font-size: 11.5px;
  font-weight: 700;
  padding: 2px 10px;
  border-radius: 999px;
  flex-shrink: 0;
}
.bk__status.confirmed {
  color: var(--green, #16a34a);
  background: color-mix(in srgb, #16a34a 14%, transparent);
}
.bk__status.cancelled {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}
.bk__status.rescheduled {
  color: var(--amber, #d97706);
  background: color-mix(in srgb, #d97706 16%, transparent);
}
.bk__actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
/* Botones / links */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 9px;
  padding: 9px 16px;
  cursor: pointer;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
}
.btn:hover:not(:disabled) {
  background: var(--accent-700, var(--accent));
}
.btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.btn--ghost {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text-1);
}
.btn--ghost:hover:not(:disabled) {
  background: var(--hover);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.link:disabled {
  opacity: 0.5;
  cursor: default;
}
.link--danger {
  color: var(--danger);
}
/* Modales */
.modal {
  position: fixed;
  inset: 0;
  background: rgba(15, 20, 30, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 80;
  padding: 16px;
}
.modal__box {
  width: 540px;
  max-width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--surface);
  border-radius: 16px;
  border-top: 4px solid var(--accent);
  padding: 22px;
  box-shadow: var(--shadow-lg);
}
.modal__box--sm {
  width: 420px;
}
.modal__h {
  font-size: 17px;
  font-weight: 700;
  margin: 0 0 14px;
}
.modal__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  min-width: 0;
}
.f--wide {
  grid-column: 1 / -1;
}
/* Checkbox de Bifrost Meet en el modal de tipo: fila horizontal (no columna como los demás campos). */
.f--check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.f--check input {
  width: auto;
}
.meet-hint {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
.f input,
.f select {
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font: inherit;
  font-weight: 400;
  background: var(--surface);
  color: var(--text-1);
}
.f input:focus,
.f select:focus {
  outline: none;
  border-color: var(--accent);
}
.f__color {
  height: 38px;
  padding: 3px;
}
.f--url {
  flex-direction: row;
  align-items: stretch;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
}
.f--url .f__prefix {
  display: flex;
  align-items: center;
  padding: 0 8px;
  background: var(--surface-dim);
  color: var(--text-3);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
}
.f--url input {
  border: none;
  border-radius: 0;
  flex: 1;
  min-width: 0;
}
/* Segmented control (excepción) */
.seg {
  display: flex;
  gap: 4px;
  background: var(--surface-dim);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 3px;
  margin: 14px 0 6px;
}
.seg__opt {
  flex: 1;
  padding: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.seg__opt.on {
  background: var(--surface);
  color: var(--accent);
  box-shadow: var(--shadow-sm);
}
.seg__hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 0 0 12px;
}
.exc-iv {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
/* Definition list (detalle reserva) */
.dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  margin: 0 0 8px;
  font-size: 13.5px;
}
.dl dt {
  color: var(--text-3);
  font-weight: 600;
}
.dl dd {
  margin: 0;
  color: var(--text-1);
}
.modal__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}
.spacer {
  flex: 1;
}
@media (max-width: 560px) {
  .modal__grid {
    grid-template-columns: 1fr;
  }
  .bk {
    flex-wrap: wrap;
  }
  .bk__when {
    width: 100%;
  }
  .exc {
    flex-wrap: wrap;
  }
  .exc__date {
    width: 100%;
  }
}
</style>
