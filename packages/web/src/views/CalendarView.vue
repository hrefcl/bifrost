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
import { useGoogleCalendarStore } from '@/stores/googleCalendar';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/lib/http';
import { colorFor } from '@/lib/people';
import { normalizeAllDayRange } from '@/lib/calendar-dates';
import type { Account, CalendarEvent } from '@webmail6/shared';

const { t, locale } = useI18n();
const store = useCalendarStore();
const gcal = useGoogleCalendarStore();
const route = useRoute();
const router = useRouter();
// Banner de resultado del flujo OAuth (vuelta del callback con ?google=connected|error).
const gcalBanner = ref<'connected' | 'error' | null>(null);
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
  withMeet: false,
  attendees: [] as { name?: string; email: string }[],
});
const createError = ref('');
// El toggle de Meet se bloquea sólo si el evento YA tiene sala (no se puede quitar desde acá).
const meetLocked = ref(false);
// Invitados (estilo Google): agregar por email, con autocompletado desde contactos.
const attendeeInput = ref('');
const attendeeSuggestions = ref<{ name: string; email: string }[]>([]);
const attHighlight = ref(-1); // índice resaltado para navegación con teclado
let suggestTimer: ReturnType<typeof setTimeout> | undefined;
let suggestAbort: AbortController | undefined;
function onAttendeeInput() {
  const q = attendeeInput.value.trim();
  clearTimeout(suggestTimer);
  attHighlight.value = -1;
  if (q.length < 1) {
    suggestAbort?.abort();
    attendeeSuggestions.value = [];
    return;
  }
  suggestTimer = setTimeout(() => {
    suggestAbort?.abort(); // cancela la petición en vuelo (review D): sin llamadas acumuladas al tipear
    const ac = new AbortController();
    suggestAbort = ac;
    void api
      .get<{ name: string; email: string }[]>('/contacts/search', {
        params: { q },
        signal: ac.signal,
      })
      .then(({ data }) => {
        const added = new Set(createForm.value.attendees.map((a) => a.email.toLowerCase()));
        attendeeSuggestions.value = data
          .filter((c) => !added.has(c.email.toLowerCase()))
          .slice(0, 6);
      })
      .catch(() => {
        /* abortada o error: no tocar las sugerencias */
      });
  }, 200);
}
function pushAttendee(email: string, name?: string) {
  const e = email.trim().toLowerCase();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
  if (!createForm.value.attendees.some((a) => a.email.toLowerCase() === e)) {
    createForm.value.attendees.push(name ? { name, email: e } : { email: e });
  }
  attendeeInput.value = '';
  attendeeSuggestions.value = [];
  attHighlight.value = -1;
}
function addAttendee() {
  // Enter con una sugerencia resaltada → la agrega; si no, agrega el texto libre (review D: nav teclado).
  const i = attHighlight.value;
  if (i >= 0 && i < attendeeSuggestions.value.length) pickSuggestion(attendeeSuggestions.value[i]);
  else pushAttendee(attendeeInput.value);
}
function pickSuggestion(c: { name: string; email: string }) {
  pushAttendee(c.email, c.name);
}
function moveHighlight(delta: number) {
  const n = attendeeSuggestions.value.length;
  if (!n) return;
  attHighlight.value = (attHighlight.value + delta + n) % n;
}
function removeAttendee(email: string) {
  createForm.value.attendees = createForm.value.attendees.filter((a) => a.email !== email);
}

// Modal de detalle (click en un evento).
const detail = ref<CalendarEvent | null>(null);

// Estado de sincronización con Google del evento abierto (para NO diagnosticar a ciegas cuando algo falla).
// 'synced'/'pending'/'error' → fila informativa; undefined/'skipped'/'deleting' → no se muestra.
const syncBadge = computed<{ cls: string; icon: 'check' | 'refresh' | 'x'; text: string } | null>(
  () => {
    const s = detail.value?.googleSyncStatus;
    if (s === 'synced') return { cls: 'ok', icon: 'check', text: t('calendar.google.syncSynced') };
    if (s === 'pending')
      return { cls: 'pending', icon: 'refresh', text: t('calendar.google.syncPending') };
    if (s === 'error') return { cls: 'err', icon: 'x', text: t('calendar.google.syncErrLine') };
    return null;
  }
);

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
    .map((e) => {
      // All-day IMPORTADO de Google: se guarda a medianoche UTC (T00:00Z). Si se lo pasáramos a
      // FullCalendar como ISO con hora, en zonas UTC-negativas (p.ej. Chile UTC-4) lo parsearía como
      // las 20:00 del día ANTERIOR → el evento se vería un día antes. Pasando sólo la fecha (YYYY-MM-DD)
      // FullCalendar lo trata como all-day flotante, sin conversión de zona → día correcto en todas partes.
      // Los all-day MANUALES se dejan tal cual (usan medianoche LOCAL; date-slicing los rompería en UTC+).
      const importedAllDay = e.allDay && e.source === 'google';
      return {
        id: e.id,
        title: e.summary,
        start: importedAllDay ? e.startDate.slice(0, 10) : e.startDate,
        end: importedAllDay ? e.endDate.slice(0, 10) : e.endDate,
        allDay: e.allDay,
        backgroundColor: colorFor(calNameOf(e)),
        borderColor: colorFor(calNameOf(e)),
        // Estado de sync con Google → clase para marcar visualmente los que fallaron (ev-syncerr).
        extendedProps: { syncStatus: e.googleSyncStatus },
      };
    })
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
    withMeet: false,
    attendees: [],
  };
  meetLocked.value = false;
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
    withMeet: false,
    attendees: [],
  };
  meetLocked.value = false;
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
    withMeet: Boolean(ev.meetUrl),
    attendees: (ev.attendees ?? []).map((a) => ({ name: a.name, email: a.email })),
  };
  meetLocked.value = Boolean(ev.meetUrl);
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
        attendees: createForm.value.attendees,
        withMeet: createForm.value.withMeet,
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
        withMeet: createForm.value.withMeet,
        attendees: createForm.value.attendees,
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

/**
 * Rango legible del evento abierto. Los all-day se muestran como FECHA (sin hora): el fin es EXCLUSIVO,
 * así que el último día real es `end - 1`; si coincide con el inicio → una sola fecha. Para los importados
 * de Google (guardados a medianoche UTC) se ancla al mediodía de la fecha literal para no correr el día en
 * zonas UTC-negativas (mismo motivo que en la grilla); los manuales usan medianoche LOCAL → parse directo.
 */
function fmtWhen(e: CalendarEvent): string {
  if (!e.allDay) return `${fmtDetail(e.startDate)} – ${fmtDetail(e.endDate)}`;
  const toDay = (iso: string): Date =>
    e.source === 'google' ? new Date(`${iso.slice(0, 10)}T12:00:00`) : new Date(iso);
  const fmtDay = (d: Date): string => d.toLocaleDateString(locale.value, { dateStyle: 'medium' });
  const start = toDay(e.startDate);
  const lastIncl = new Date(toDay(e.endDate).getTime() - 24 * 3600 * 1000); // fin exclusivo → último día
  return start.toDateString() === lastIncl.toDateString()
    ? fmtDay(start)
    : `${fmtDay(start)} – ${fmtDay(lastIncl)}`;
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
  // Marca visual sutil en los eventos que fallaron al sincronizar con Google.
  eventClassNames: (arg) => (arg.event.extendedProps.syncStatus === 'error' ? ['ev-syncerr'] : []),
  // A11y: los eventos con error no dependen SÓLO del estilo — llevan title + aria-label (review B/D).
  eventDidMount: (arg) => {
    if (arg.event.extendedProps.syncStatus === 'error') {
      const label = `${arg.event.title} — ${t('calendar.google.syncErrLine')}`;
      arg.el.setAttribute('title', label);
      arg.el.setAttribute('aria-label', label);
    }
  },
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

/** Desconecta Google y refresca el estado. */
async function disconnectGoogle(): Promise<void> {
  await gcal.disconnect();
  // El backend purga el calendario importado (source:'google') al desconectar → refrescamos el rango
  // visible para que esos eventos desaparezcan YA de la grilla (si no, quedaban hasta navegar/recargar).
  const api = fcApi();
  if (api)
    await store.fetchEvents(api.view.activeStart.toISOString(), api.view.activeEnd.toISOString());
}

/** El error a nivel conexión (refresh revocado/expirado) se resuelve reconectando con Google.
 *  Los errores de sync por-evento los reintenta solo el reconciler del backend (cada 2 min). */
async function retryGoogleSync(): Promise<void> {
  await gcal.connect();
}

onMounted(async () => {
  try {
    const { data } = await api.get<Account[]>('/accounts');
    accounts.value = data;
  } catch {
    // sin cuentas: crear lo valida igual (accountId requerido por el backend)
  }
  // Estado de Google Calendar para el panel lateral.
  void gcal.fetchStatus();
  // Vuelta del callback OAuth: mostrar resultado y limpiar el query de la URL.
  const g = route.query.google;
  if (g === 'connected' || g === 'error') {
    gcalBanner.value = g;
    void router.replace({ query: { ...route.query, google: undefined, reason: undefined } });
    if (g === 'connected') void gcal.fetchStatus();
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

          <!-- Google Calendar (sólo si el operador configuró la integración) -->
          <div v-if="gcal.status.configured" class="cal-section">
            <h3 class="cal-section-title">{{ t('calendar.google.title') }}</h3>

            <p
              v-if="gcalBanner"
              class="gcal-banner"
              :class="gcalBanner === 'connected' ? 'ok' : 'err'"
              role="status"
              aria-live="polite"
            >
              {{
                gcalBanner === 'connected'
                  ? t('calendar.google.okConnected')
                  : t('calendar.google.errConnect')
              }}
            </p>

            <template v-if="gcal.status.connected">
              <p class="gcal-line">
                <AppIcon name="check" :size="15" class="gcal-ok" />
                <span>{{
                  gcal.status.email
                    ? t('calendar.google.connectedAs', { email: gcal.status.email })
                    : t('calendar.google.connected')
                }}</span>
              </p>
              <button class="gcal-btn ghost" @click="disconnectGoogle">
                <AppIcon name="x" :size="15" />{{ t('calendar.google.disconnect') }}
              </button>
            </template>

            <template v-else>
              <p class="gcal-intro">{{ t('calendar.google.intro') }}</p>
              <button class="gcal-btn" :disabled="gcal.connecting" @click="gcal.connect()">
                <AppIcon name="link" :size="15" />
                {{
                  gcal.connecting ? t('calendar.google.connecting') : t('calendar.google.connect')
                }}
              </button>
            </template>

            <div v-if="gcal.status.status === 'error'" class="gcal-error" role="alert">
              <span>{{ t('calendar.google.syncError') }}</span>
              <button class="gcal-btn ghost sm" @click="retryGoogleSync">
                <AppIcon name="refresh" :size="14" />{{ t('calendar.google.retry') }}
              </button>
            </div>
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

        <!-- Bifrost Meet -->
        <label class="check">
          <input v-model="createForm.withMeet" type="checkbox" :disabled="meetLocked" />
          {{ t('calendar.withMeet') }}
        </label>

        <!-- Invitados -->
        <div class="attendees">
          <div class="att-add">
            <div class="att-field">
              <input
                v-model="attendeeInput"
                type="email"
                :placeholder="t('calendar.attendeePlaceholder')"
                class="field"
                autocomplete="off"
                @input="onAttendeeInput"
                @keydown.enter.prevent="addAttendee"
                @keydown.down.prevent="moveHighlight(1)"
                @keydown.up.prevent="moveHighlight(-1)"
                @keydown.esc="attendeeSuggestions = []"
              />
              <!-- Autocompletado desde contactos -->
              <ul v-if="attendeeSuggestions.length" class="att-suggest">
                <li
                  v-for="(c, i) in attendeeSuggestions"
                  :key="c.email"
                  :class="{ hi: i === attHighlight }"
                  @mousedown.prevent="pickSuggestion(c)"
                  @mousemove="attHighlight = i"
                >
                  <span class="s-name">{{ c.name || c.email }}</span>
                  <span v-if="c.name" class="s-email">{{ c.email }}</span>
                </li>
              </ul>
            </div>
            <button type="button" class="ghost-btn" @click="addAttendee">
              {{ t('calendar.addAttendee') }}
            </button>
          </div>
          <div v-if="createForm.attendees.length" class="att-chips">
            <span v-for="a in createForm.attendees" :key="a.email" class="att-chip">
              {{ a.email }}
              <button type="button" class="att-x" @click="removeAttendee(a.email)">×</button>
            </span>
          </div>
        </div>

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
        <div class="detail-row"><AppIcon name="clock" :size="15" />{{ fmtWhen(detail) }}</div>
        <div v-if="detail.location" class="detail-row">
          <AppIcon name="mapPin" :size="15" />{{ detail.location }}
        </div>
        <div class="detail-row"><AppIcon name="tag" :size="15" />{{ detail.calendarName }}</div>
        <p v-if="detail.description" class="detail-desc">{{ detail.description }}</p>
        <!-- Estado de sincronización con Google (sólo si el evento tenía que sincronizar). -->
        <div v-if="syncBadge" class="detail-sync" :class="syncBadge.cls">
          <AppIcon :name="syncBadge.icon" :size="15" />
          <span>{{ syncBadge.text }}</span>
        </div>
        <p
          v-if="detail.googleSyncStatus === 'error' && detail.googleSyncError"
          class="detail-syncerr"
        >
          {{ detail.googleSyncError }}
        </p>
        <!-- Los eventos importados de Google son read-only en Bifrost (se editan en Google). -->
        <p v-if="detail.source === 'google'" class="detail-google" role="note">
          <AppIcon name="globe" :size="14" />{{ t('calendar.google.readonlyNote') }}
        </p>
        <div class="modal-foot">
          <button v-if="detail.source !== 'google'" class="create-btn" @click="openEdit(detail)">
            {{ t('calendar.edit') }}
          </button>
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

/* ---- Google Calendar (panel lateral) ---- */
.gcal-intro,
.gcal-line {
  font-size: 12.5px;
  color: var(--text-2);
  margin: 0 0 8px;
  line-height: 1.4;
}
.gcal-line {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-1);
}
.gcal-ok {
  color: var(--success, #16a34a);
}
.gcal-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.gcal-btn:hover {
  background: var(--accent-700);
}
.gcal-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.gcal-btn.ghost {
  background: var(--surface);
  color: var(--text-1);
}
.gcal-btn.ghost:hover {
  background: var(--hover);
}
.gcal-btn.sm {
  padding: 4px 9px;
  font-size: 12px;
}
.gcal-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 10px;
  padding: 8px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, var(--surface));
}
.gcal-banner {
  font-size: 12.5px;
  margin: 0 0 8px;
  padding: 7px 9px;
  border-radius: 8px;
}
.gcal-banner.ok {
  color: var(--success, #16a34a);
  background: color-mix(in srgb, var(--success, #16a34a) 10%, var(--surface));
}
.gcal-banner.err {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
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
.attendees {
  margin: 0 0 12px;
}
.att-add {
  display: flex;
  gap: 8px;
}
.att-field {
  position: relative;
  flex: 1;
}
.att-field .field {
  width: 100%;
  margin: 0;
  box-sizing: border-box;
}
.att-suggest {
  position: absolute;
  z-index: 20;
  left: 0;
  right: 0;
  top: calc(100% + 2px);
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--surface-1, #fff);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  max-height: 200px;
  overflow: auto;
}
.att-suggest li {
  display: flex;
  flex-direction: column;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.att-suggest li:hover,
.att-suggest li.hi {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.s-name {
  font-size: 13px;
  font-weight: 600;
}
.s-email {
  font-size: 12px;
  color: var(--text-3);
}
.att-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.att-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--text-1);
  border-radius: 999px;
  padding: 3px 6px 3px 10px;
  font-size: 12.5px;
}
.att-x {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-3);
  font-size: 15px;
  line-height: 1;
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
/* Estado de sync con Google en el modal de detalle. */
.detail-sync {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 500;
  margin: 6px 0 2px;
}
.detail-google {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--text-2);
  margin: 6px 0 2px;
}
.detail-sync.ok {
  color: var(--success, #16a34a);
}
.detail-sync.pending {
  color: var(--text-2);
}
.detail-sync.err {
  color: var(--danger);
}
.detail-syncerr {
  font-size: 12px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, var(--surface));
  border-radius: 6px;
  padding: 6px 8px;
  margin: 0 0 12px;
  overflow-wrap: anywhere;
}
/* Evento con sync fallido en la grilla: borde punteado sutil (indicador no intrusivo). */
.cal-grid :deep(.ev-syncerr) {
  outline: 1.5px dashed var(--danger);
  outline-offset: -2px;
}
textarea.field {
  resize: vertical;
  min-height: 64px;
}
</style>
