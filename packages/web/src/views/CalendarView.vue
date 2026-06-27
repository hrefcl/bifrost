<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
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
import type { Account, CalendarEvent } from '@webmail6/shared';

const { t, locale } = useI18n();
const store = useCalendarStore();
const calendarRef = ref<InstanceType<typeof FullCalendar> | null>(null);
const accounts = ref<Account[]>([]);
const periodTitle = ref('');
const currentView = ref<'timeGridDay' | 'timeGridWeek' | 'dayGridMonth'>('timeGridWeek');

// Modal de creación rápida (Crear o arrastrar para seleccionar un rango).
const showCreate = ref(false);
const createForm = ref({ summary: '', startDate: '', endDate: '', allDay: false });
const createError = ref('');

// Modal de detalle (click en un evento).
const detail = ref<CalendarEvent | null>(null);

function fcApi() {
  return calendarRef.value?.getApi();
}

/** Eventos del store → formato FullCalendar (color estable por calendario). */
const fcEvents = computed<EventInput[]>(() =>
  store.events.map((e) => ({
    id: e.id,
    title: e.summary,
    start: e.startDate,
    end: e.endDate,
    allDay: e.allDay,
    backgroundColor: colorFor(e.calendarName || e.summary),
    borderColor: colorFor(e.calendarName || e.summary),
  }))
);

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
  createForm.value = {
    summary: '',
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
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  createForm.value = {
    summary: '',
    startDate: toLocalInput(start),
    endDate: toLocalInput(end),
    allDay: false,
  };
  createError.value = '';
  showCreate.value = true;
}

async function submitCreate(): Promise<void> {
  createError.value = '';
  const start = new Date(createForm.value.startDate);
  const end = new Date(createForm.value.endDate);
  if (!(end.getTime() > start.getTime())) {
    createError.value = t('calendar.errRange');
    return;
  }
  try {
    await store.createEvent({
      accountId: accounts.value[0]?.id ?? '',
      calendarId: 'default',
      calendarName: 'Personal',
      uid: `local-${String(Date.now())}`,
      summary: createForm.value.summary,
      startDate: start.toISOString(),
      startTimezone: 'UTC',
      endDate: end.toISOString(),
      endTimezone: 'UTC',
      allDay: createForm.value.allDay,
      status: 'confirmed',
    });
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
          <button class="create-btn" @click="openCreate">
            <AppIcon name="plus" :size="18" />{{ t('calendar.new') }}
          </button>
        </div>
      </div>

      <div class="cal-grid">
        <FullCalendar ref="calendarRef" :options="calendarOptions" />
      </div>
    </div>

    <!-- Modal de creación rápida -->
    <div v-if="showCreate" class="overlay" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ t('calendar.new') }}</h3>
          <button class="icon-btn" :title="t('common.close')" @click="showCreate = false">
            <AppIcon name="x" :size="18" />
          </button>
        </div>
        <input
          v-model="createForm.summary"
          type="text"
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
        <div class="detail-row"><AppIcon name="tag" :size="15" />{{ detail.calendarName }}</div>
        <div class="modal-foot">
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
.cal-grid {
  flex: 1;
  min-height: 0;
  padding: 8px 12px 12px;
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
</style>
