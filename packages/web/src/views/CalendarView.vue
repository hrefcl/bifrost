<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import FullCalendar from '@fullcalendar/vue3';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import esLocale from '@fullcalendar/core/locales/es';
import type {
  CalendarOptions,
  EventInput,
  EventClickArg,
  EventDropArg,
  DateSelectArg,
  DatesSetArg,
} from '@fullcalendar/core';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import { useCalendarStore } from '@/stores/calendar';
import { api } from '@/lib/http';
import { colorFor } from '@/lib/people';
import { normalizeAllDayRange } from '@/lib/calendar-dates';
import type { Account, CalendarEvent } from '@webmail6/shared';

const { t, locale } = useI18n();
const store = useCalendarStore();
const calendarRef = ref<InstanceType<typeof FullCalendar> | null>(null);
const accounts = ref<Account[]>([]);
const periodTitle = ref('');
const currentView = ref<'timeGridDay' | 'timeGridWeek' | 'dayGridMonth'>('timeGridWeek');

// Modal de creación/edición (Crear, arrastrar para seleccionar un rango, o editar un evento).
const showCreate = ref(false);
const editingId = ref<string | null>(null); // null = crear; id = editar ese evento.
const createForm = ref({
  summary: '',
  description: '',
  location: '',
  startDate: '',
  endDate: '',
  allDay: false,
});
const createError = ref('');

// Modal de detalle (click en un evento).
const detail = ref<CalendarEvent | null>(null);

// Reset defensivo: al cerrar el modal (cancel/X/click-fuera/guardar) se vuelve a modo "crear",
// para que ningún reapertura futura herede el editingId de una edición previa (review B/D).
watch(showCreate, (open) => {
  if (!open) editingId.value = null;
});

function fcApi() {
  return calendarRef.value?.getApi();
}

// ── Sidebar estilo Google Calendar: "Mis calendarios" con toggle de visibilidad ──
const hiddenCals = ref<Set<string>>(new Set());
function calNameOf(e: CalendarEvent): string {
  return e.calendarName || 'Personal';
}
/** Lista de calendarios (derivada de los eventos cargados) con su color y visibilidad. */
const calendarList = computed(() => {
  const names = new Set<string>();
  for (const e of store.events) names.add(calNameOf(e));
  if (names.size === 0) names.add('Personal');
  return [...names].sort().map((name) => ({
    name,
    color: colorFor(name),
    visible: !hiddenCals.value.has(name),
  }));
});
function toggleCal(name: string): void {
  const next = new Set(hiddenCals.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  hiddenCals.value = next;
}

/** Eventos del store → formato FullCalendar (color estable por calendario), filtrando los ocultos. */
const fcEvents = computed<EventInput[]>(() =>
  store.events
    .filter((e) => !hiddenCals.value.has(calNameOf(e)))
    .map((e) => ({
      id: e.id,
      title: e.summary,
      start: e.startDate,
      end: e.endDate,
      allDay: e.allDay,
      backgroundColor: colorFor(calNameOf(e)),
      borderColor: colorFor(calNameOf(e)),
    }))
);

// ── Mini-calendario (navegador de mes, Monday-first) ──
const miniAnchor = ref(new Date());
const selectedDate = ref(new Date());
const miniMonthLabel = computed(() =>
  miniAnchor.value.toLocaleDateString(locale.value, { month: 'long', year: 'numeric' })
);
const miniWeekdays = computed(() => {
  // L M X J V S D (o localizado): tomamos 7 días desde un lunes conocido.
  const base = new Date(2024, 0, 1); // lunes
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d.toLocaleDateString(locale.value, { weekday: 'narrow' });
  });
});
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
const miniGrid = computed(() => {
  const y = miniAnchor.value.getFullYear();
  const m = miniAnchor.value.getMonth();
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // lunes primero
  const start = new Date(y, m, 1 - offset);
  const todayTs = startOfDay(new Date());
  const selTs = startOfDay(selectedDate.value);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return {
      key: d.toISOString().slice(0, 10),
      day: d.getDate(),
      date: d,
      inMonth: d.getMonth() === m,
      isToday: startOfDay(d) === todayTs,
      isSelected: startOfDay(d) === selTs,
    };
  });
});
function miniPrev(): void {
  miniAnchor.value = new Date(miniAnchor.value.getFullYear(), miniAnchor.value.getMonth() - 1, 1);
}
function miniNext(): void {
  miniAnchor.value = new Date(miniAnchor.value.getFullYear(), miniAnchor.value.getMonth() + 1, 1);
}
/** Click en un día del mini-calendario → navega la grilla principal a ese día (vista día). */
function pickMiniDay(d: Date): void {
  selectedDate.value = d;
  fcApi()?.gotoDate(d);
  if (currentView.value === 'dayGridMonth') {
    miniAnchor.value = new Date(d.getFullYear(), d.getMonth(), 1);
  }
}

// datetime-local (hora local) ↔ Date helpers.
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function onDatesSet(arg: DatesSetArg): void {
  periodTitle.value = arg.view.title;
  void store.fetchEvents(arg.start.toISOString(), arg.end.toISOString());
}

/** Arrastrar sobre la grilla para crear → abre el modal con el rango preseleccionado. */
function onSelect(arg: DateSelectArg): void {
  editingId.value = null;
  createForm.value = {
    summary: '',
    description: '',
    location: '',
    startDate: toLocalInput(arg.start),
    endDate: toLocalInput(arg.end),
    allDay: arg.allDay,
  };
  createError.value = '';
  showCreate.value = true;
  fcApi()?.unselect();
}

/** Botón "Crear": evento de 1h desde la próxima hora en punto. */
function openCreate(): void {
  editingId.value = null;
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  createForm.value = {
    summary: '',
    description: '',
    location: '',
    startDate: toLocalInput(start),
    endDate: toLocalInput(end),
    allDay: false,
  };
  createError.value = '';
  showCreate.value = true;
}

/** Editar un evento existente (desde el modal de detalle): precarga el form y entra en modo edición. */
function openEdit(ev: CalendarEvent): void {
  editingId.value = ev.id;
  createForm.value = {
    summary: ev.summary,
    description: ev.description ?? '',
    location: ev.location ?? '',
    startDate: toLocalInput(new Date(ev.startDate)),
    endDate: toLocalInput(new Date(ev.endDate)),
    allDay: ev.allDay,
  };
  createError.value = '';
  detail.value = null;
  showCreate.value = true;
}

async function submitCreate(): Promise<void> {
  createError.value = '';
  let start = new Date(createForm.value.startDate);
  let end = new Date(createForm.value.endDate);
  // "Todo el día": normalizar a fin exclusivo (FullCalendar/iCal) sin duplicar día (review B).
  if (createForm.value.allDay) {
    ({ start, end } = normalizeAllDayRange(start, end));
  }
  if (!(end.getTime() > start.getTime())) {
    createError.value = t('calendar.errRange');
    return;
  }
  try {
    if (editingId.value) {
      // Editar: PATCH parcial (mismo endpoint owner-bound que usa el drag/resize). description y
      // location se envían trim (''=limpiar).
      await store.updateEvent(editingId.value, {
        summary: createForm.value.summary,
        description: createForm.value.description.trim(),
        location: createForm.value.location.trim(),
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        allDay: createForm.value.allDay,
      });
    } else {
      await store.createEvent({
        accountId: accounts.value[0]?.id ?? '',
        calendarId: 'default',
        calendarName: 'Personal',
        uid: `local-${crypto.randomUUID()}`,
        summary: createForm.value.summary,
        description: createForm.value.description.trim(),
        location: createForm.value.location.trim(),
        startDate: start.toISOString(),
        startTimezone: 'UTC',
        endDate: end.toISOString(),
        endTimezone: 'UTC',
        allDay: createForm.value.allDay,
        status: 'confirmed',
      });
    }
    showCreate.value = false;
  } catch {
    createError.value = t('calendar.errSave');
  }
}

function onEventClick(arg: EventClickArg): void {
  detail.value = store.events.find((e) => e.id === arg.event.id) ?? null;
}

/** Drag o resize de un evento → PATCH de fechas; si falla, revierte la UI. */
async function onEventChange(arg: EventDropArg): Promise<void> {
  const ev = arg.event;
  if (!ev.start) return;
  try {
    await store.updateEvent(ev.id, {
      startDate: ev.start.toISOString(),
      endDate: (ev.end ?? ev.start).toISOString(),
    });
  } catch {
    arg.revert();
  }
}

async function deleteDetail(): Promise<void> {
  if (!detail.value) return;
  await store.deleteEvent(detail.value.id);
  detail.value = null;
}

function fmtDetail(iso: string): string {
  return new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' });
}

function setView(v: typeof currentView.value): void {
  currentView.value = v;
  fcApi()?.changeView(v);
}

const calendarOptions = computed<CalendarOptions>(() => ({
  plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
  initialView: 'timeGridWeek',
  headerToolbar: false,
  locale: locale.value === 'es' ? esLocale : 'en',
  firstDay: 1,
  height: '100%',
  nowIndicator: true,
  editable: true,
  selectable: true,
  selectMirror: true,
  dayMaxEvents: true,
  scrollTime: '08:00:00',
  slotLabelFormat: { hour: 'numeric', minute: '2-digit', omitZeroMinute: true },
  events: fcEvents.value,
  datesSet: onDatesSet,
  select: onSelect,
  eventClick: onEventClick,
  eventDrop: (arg) => {
    void onEventChange(arg);
  },
  eventResize: (arg) => {
    void onEventChange(arg as unknown as EventDropArg);
  },
}));

onMounted(async () => {
  try {
    const { data } = await api.get<Account[]>('/accounts');
    accounts.value = data;
  } catch {
    // sin cuentas: crear lo valida igual (accountId requerido por el backend)
  }
});
</script>

<template>
  <AppLayout>
    <div class="cal">
      <!-- Header estilo Google Calendar / maqueta -->
      <div class="cal-head">
        <h1 class="cal-period">{{ periodTitle }}</h1>
        <div class="nav">
          <button class="icon-btn" :title="t('common.back')" @click="fcApi()?.prev()">
            <AppIcon name="chevronLeft" :size="18" />
          </button>
          <button class="icon-btn" @click="fcApi()?.next()">
            <AppIcon name="chevronRight" :size="18" />
          </button>
        </div>
        <button class="today-btn" @click="fcApi()?.today()">{{ t('calendar.today') }}</button>

        <div class="head-right">
          <div class="seg">
            <button
              v-for="v in ['timeGridDay', 'timeGridWeek', 'dayGridMonth'] as const"
              :key="v"
              class="seg-btn"
              :class="{ on: currentView === v }"
              @click="setView(v)"
            >
              {{ t('calendar.view.' + v) }}
            </button>
          </div>
        </div>
      </div>

      <div class="cal-body">
        <!-- Sidebar estilo Google Calendar -->
        <aside class="cal-sidebar">
          <button class="cal-create" @click="openCreate">
            <AppIcon name="plus" :size="18" />{{ t('calendar.new') }}
          </button>

          <!-- Mini-calendario (navegador de mes) -->
          <div class="mini-cal">
            <div class="mini-head">
              <span class="mini-month">{{ miniMonthLabel }}</span>
              <div class="mini-nav">
                <button class="icon-btn" :title="t('common.back')" @click="miniPrev">
                  <AppIcon name="chevronLeft" :size="16" />
                </button>
                <button class="icon-btn" @click="miniNext">
                  <AppIcon name="chevronRight" :size="16" />
                </button>
              </div>
            </div>
            <div class="mini-grid">
              <span v-for="(w, i) in miniWeekdays" :key="'wd' + i" class="mini-wd">{{ w }}</span>
              <button
                v-for="c in miniGrid"
                :key="c.key"
                class="mini-day"
                :class="{ muted: !c.inMonth, today: c.isToday, sel: c.isSelected }"
                @click="pickMiniDay(c.date)"
              >
                {{ c.day }}
              </button>
            </div>
          </div>

          <!-- Mis calendarios -->
          <div class="cal-section">
            <h3 class="cal-section-title">{{ t('calendar.myCalendars') }}</h3>
            <label v-for="c in calendarList" :key="c.name" class="cal-item">
              <input
                type="checkbox"
                :checked="c.visible"
                class="cal-check"
                :style="{ accentColor: c.color }"
                @change="toggleCal(c.name)"
              />
              <span class="cal-dot" :style="{ background: c.color }"></span>
              <span class="cal-name">{{ c.name }}</span>
            </label>
          </div>

          <!-- Páginas de reservas → Agenda -->
          <div class="cal-section">
            <h3 class="cal-section-title">{{ t('calendar.bookingPages') }}</h3>
            <RouterLink :to="{ name: 'scheduling' }" class="cal-link">
              <AppIcon name="calendarClock" :size="16" />{{ t('calendar.manageAgenda') }}
            </RouterLink>
          </div>
        </aside>

        <div class="cal-grid">
          <FullCalendar ref="calendarRef" :options="calendarOptions" />
        </div>
      </div>
    </div>

    <!-- Modal de creación rápida -->
    <div v-if="showCreate" class="overlay" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ editingId ? t('calendar.edit') : t('calendar.new') }}</h3>
          <button class="icon-btn" :title="t('common.close')" @click="showCreate = false">
            <AppIcon name="x" :size="18" />
          </button>
        </div>
        <input
          v-model="createForm.summary"
          type="text"
          maxlength="1024"
          :placeholder="t('calendar.eventTitle')"
          class="field"
        />
        <div class="grid2">
          <label class="lbl">
            {{ t('calendar.start') }}
            <input v-model="createForm.startDate" type="datetime-local" class="field" />
          </label>
          <label class="lbl">
            {{ t('calendar.end') }}
            <input v-model="createForm.endDate" type="datetime-local" class="field" />
          </label>
        </div>
        <label class="check"
          ><input v-model="createForm.allDay" type="checkbox" /> {{ t('calendar.allDay') }}</label
        >
        <input
          v-model="createForm.location"
          type="text"
          maxlength="1024"
          :placeholder="t('calendar.location')"
          class="field"
        />
        <textarea
          v-model="createForm.description"
          maxlength="8192"
          :placeholder="t('calendar.description')"
          class="field"
          rows="3"
        ></textarea>
        <p v-if="createError" class="err">{{ createError }}</p>
        <div class="modal-foot">
          <button class="create-btn" @click="submitCreate">{{ t('calendar.save') }}</button>
          <button class="ghost-btn" @click="showCreate = false">{{ t('calendar.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- Modal de detalle -->
    <div v-if="detail" class="overlay" @click.self="detail = null">
      <div
        class="modal"
        :style="{ borderTop: `4px solid ${colorFor(detail.calendarName || detail.summary)}` }"
      >
        <div class="modal-head">
          <h3>{{ detail.summary }}</h3>
          <button class="icon-btn" :title="t('common.close')" @click="detail = null">
            <AppIcon name="x" :size="18" />
          </button>
        </div>
        <div class="detail-row">
          <AppIcon name="clock" :size="15" />{{ fmtDetail(detail.startDate) }} –
          {{ fmtDetail(detail.endDate) }}
        </div>
        <div v-if="detail.location" class="detail-row">
          <AppIcon name="mapPin" :size="15" />{{ detail.location }}
        </div>
        <div class="detail-row"><AppIcon name="tag" :size="15" />{{ detail.calendarName }}</div>
        <p v-if="detail.description" class="detail-desc">{{ detail.description }}</p>
        <div class="modal-foot">
          <button class="create-btn" @click="openEdit(detail)">{{ t('calendar.edit') }}</button>
          <button class="ghost-btn danger" @click="deleteDetail">{{ t('calendar.delete') }}</button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.cal {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface);
}
.cal-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  height: 60px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.cal-period {
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0;
  min-width: 180px;
}
.nav {
  display: flex;
  gap: 2px;
}
.head-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}
.icon-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-btn:hover {
  background: var(--hover);
}
.today-btn,
.ghost-btn {
  padding: 8px 16px;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
}
.today-btn:hover,
.ghost-btn:hover {
  background: var(--hover);
}
.ghost-btn.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
}
.seg {
  display: flex;
  background: var(--bg);
  border-radius: 8px;
  padding: 3px;
  border: 1px solid var(--border);
}
.seg-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  background: transparent;
  color: var(--text-2);
}
.seg-btn.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-sm);
}
.create-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.create-btn:hover {
  background: var(--accent-700);
}
/* ---- Layout: sidebar + grilla ---- */
.cal-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.cal-grid {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 8px 12px 12px;
}
/* ---- Sidebar estilo Google Calendar ---- */
.cal-sidebar {
  width: 256px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 14px 14px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.cal-create {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  padding: 10px 18px 10px 14px;
  border-radius: 24px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-1);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.08));
}
.cal-create:hover {
  background: var(--surface-dim);
}
/* mini-calendario */
.mini-cal {
  user-select: none;
}
.mini-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.mini-month {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  text-transform: capitalize;
}
.mini-nav {
  display: flex;
  gap: 2px;
}
.mini-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
}
.mini-wd {
  text-align: center;
  font-size: 10px;
  color: var(--text-3);
  padding: 2px 0;
  text-transform: uppercase;
}
.mini-day {
  aspect-ratio: 1;
  border: none;
  background: transparent;
  border-radius: 50%;
  font-size: 11.5px;
  color: var(--text-1);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mini-day:hover {
  background: var(--surface-dim);
}
.mini-day.muted {
  color: var(--text-3);
}
.mini-day.today {
  color: var(--accent);
  font-weight: 700;
}
.mini-day.sel {
  background: var(--accent);
  color: #fff;
  font-weight: 700;
}
/* secciones (mis calendarios / reservas) */
.cal-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  margin: 0 0 8px;
}
.cal-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--text-1);
  cursor: pointer;
}
.cal-check {
  width: 15px;
  height: 15px;
  cursor: pointer;
}
.cal-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}
.cal-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cal-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
.cal-link:hover {
  text-decoration: underline;
}
@media (max-width: 820px) {
  .cal-sidebar {
    display: none;
  }
}

/* ---- Tema FullCalendar → tokens Bifrost ---- */
.cal-grid :deep(.fc) {
  --fc-border-color: var(--border);
  --fc-page-bg-color: var(--surface);
  --fc-neutral-bg-color: var(--surface-dim);
  --fc-today-bg-color: color-mix(in srgb, var(--accent) 7%, transparent);
  --fc-now-indicator-color: var(--danger);
  --fc-event-text-color: #fff;
  font-family: inherit;
  font-size: 13px;
  color: var(--text-1);
}
.cal-grid :deep(.fc .fc-col-header-cell-cushion),
.cal-grid :deep(.fc .fc-daygrid-day-number),
.cal-grid :deep(.fc .fc-timegrid-slot-label-cushion),
.cal-grid :deep(.fc .fc-list-day-text) {
  color: var(--text-2);
  text-decoration: none;
}
.cal-grid :deep(.fc .fc-timegrid-axis-cushion) {
  color: var(--text-3);
}
.cal-grid :deep(.fc-event) {
  border-radius: 6px;
  border: none;
  padding: 1px 4px;
  font-weight: 600;
  cursor: pointer;
}
.cal-grid :deep(.fc .fc-daygrid-day.fc-day-today),
.cal-grid :deep(.fc .fc-timegrid-col.fc-day-today) {
  background: var(--fc-today-bg-color);
}

/* ---- Modales ---- */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 70;
}
.modal {
  width: 380px;
  max-width: calc(100vw - 32px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  padding: 20px;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.modal-head h3 {
  font-size: 17px;
  font-weight: 600;
  margin: 0;
}
.field {
  width: 100%;
  /* border-box: sin esto, width:100% + padding + borde se SUMAN y el input desborda su
     contenedor (notorio en datetime-local, que además trae ancho intrínseco propio). */
  box-sizing: border-box;
  min-width: 0;
  padding: 10px 12px;
  font: inherit;
  font-size: 14px;
  border-radius: 9px;
  border: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text-1);
  outline: none;
  margin-bottom: 10px;
}
.field:focus {
  border-color: var(--accent);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.lbl {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* min-width:0: un item de grid tiene min-width:auto por defecto y NO se encoge por debajo
     del contenido → el datetime-local interno ensancharía la columna y desbordaría el modal. */
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-1);
  margin: 4px 0 12px;
}
.err {
  font-size: 13px;
  color: var(--danger);
  margin: 0 0 10px;
}
.modal-foot {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}
.detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  color: var(--text-2);
  margin-bottom: 8px;
}
.detail-desc {
  font-size: 13.5px;
  color: var(--text-1);
  white-space: pre-wrap;
  margin: 4px 0 12px;
}
textarea.field {
  resize: vertical;
  min-height: 64px;
}
</style>
