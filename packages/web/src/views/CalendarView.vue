<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import { useCalendarStore } from '@/stores/calendar';
import { api } from '@/lib/http';
import { colorFor } from '@/lib/people';
import type { Account } from '@webmail6/shared';

const store = useCalendarStore();
const { t, locale } = useI18n();
const accounts = ref<Account[]>([]);
const showForm = ref(false);
const form = ref({
  accountId: '',
  calendarId: 'default',
  calendarName: 'Personal',
  uid: '',
  summary: '',
  startDate: '',
  startTimezone: 'UTC',
  endDate: '',
  endTimezone: 'UTC',
  allDay: false,
  status: 'confirmed' as const,
});

// Rango del mes actual a MEDIANOCHE local (no la hora actual): si no, el día 1 antes de "ahora"
// y el último día después de "ahora" quedaban fuera del filtro $gte/$lte del backend y se perdían
// eventos reales del borde del mes (review B+D).
const rangeStart = computed(() => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
});
const rangeEnd = computed(() => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(0); // último día del mes actual
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
});

function fmtRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })} – ${e.toLocaleTimeString(locale.value, { timeStyle: 'short' })}`;
}

onMounted(async () => {
  void store.fetchEvents(rangeStart.value, rangeEnd.value);
  try {
    const { data } = await api.get<Account[]>('/accounts');
    accounts.value = data;
    if (data.length > 0) form.value.accountId = data[0].id;
  } catch {
    // sin cuentas → el select queda vacío; submit lo valida (required)
  }
});

function resetForm() {
  form.value = {
    accountId: accounts.value[0]?.id ?? '',
    calendarId: 'default',
    calendarName: 'Personal',
    uid: '',
    summary: '',
    startDate: '',
    startTimezone: 'UTC',
    endDate: '',
    endTimezone: 'UTC',
    allDay: false,
    status: 'confirmed' as const,
  };
}

const error = ref('');

async function submit() {
  error.value = '';
  // `<input type="datetime-local">` da "2026-06-25T10:00" (hora local, sin segundos ni zona),
  // pero la API valida ISO 8601 completo (`z.string().datetime()`) → sin esta conversión el
  // POST daba 400 y el evento NUNCA se creaba. Interpretamos el valor como hora local y
  // normalizamos a ISO UTC. Si es "todo el día", inicio/fin del día local (review D).
  const start = new Date(form.value.startDate);
  const end = new Date(form.value.endDate);
  if (form.value.allDay) {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  }
  if (!(end.getTime() > start.getTime())) {
    error.value = t('calendar.errRange');
    return;
  }
  try {
    await store.createEvent({
      ...form.value,
      uid: `local-${String(Date.now())}`,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
    resetForm();
    showForm.value = false;
  } catch {
    error.value = t('calendar.errSave');
  }
}
</script>

<template>
  <AppLayout>
    <div class="cal">
      <div class="cal-head">
        <h1 class="cal-title">{{ t('calendar.title') }}</h1>
        <button class="primary-btn" @click="showForm = !showForm">
          <AppIcon name="plus" :size="18" />{{ t('calendar.new') }}
        </button>
      </div>

      <div class="cal-body">
        <form v-if="showForm" class="form-card" @submit.prevent="submit">
          <input
            v-model="form.summary"
            type="text"
            :placeholder="t('calendar.eventTitle')"
            required
            class="field"
          />
          <select v-model="form.accountId" required class="field">
            <option v-for="account in accounts" :key="account.id" :value="account.id">
              {{ account.email }}
            </option>
          </select>
          <div class="grid2">
            <label class="lbl"
              >{{ t('calendar.start') }}
              <input v-model="form.startDate" type="datetime-local" required class="field" />
            </label>
            <label class="lbl"
              >{{ t('calendar.end') }}
              <input v-model="form.endDate" type="datetime-local" required class="field" />
            </label>
          </div>
          <label class="check-row">
            <input v-model="form.allDay" type="checkbox" />
            {{ t('calendar.allDay') }}
          </label>
          <div class="form-actions">
            <button type="submit" class="primary-btn">{{ t('calendar.save') }}</button>
            <button type="button" class="ghost-btn" @click="showForm = false">
              {{ t('calendar.cancel') }}
            </button>
            <span v-if="error" class="cal-error">{{ error }}</span>
          </div>
        </form>

        <div v-if="store.events.length === 0" class="empty">
          <AppIcon name="calendar" :size="44" :stroke-width="1.3" />
          <div>{{ t('calendar.empty') }}</div>
        </div>
        <div v-else class="agenda">
          <div
            v-for="event in store.events"
            :key="event.id"
            class="event"
            :style="{ '--evcolor': colorFor(event.calendarName || event.summary) }"
          >
            <div class="event-text">
              <div class="event-title">{{ event.summary }}</div>
              <div class="event-time">
                <AppIcon name="clock" :size="14" />{{ fmtRange(event.startDate, event.endDate) }}
              </div>
            </div>
            <button
              class="icon-btn danger"
              :title="t('calendar.delete')"
              @click="store.deleteEvent(event.id)"
            >
              <AppIcon name="trash" :size="18" />
            </button>
          </div>
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
  gap: 16px;
  padding: 0 24px;
  height: 56px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.cal-title {
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0;
  flex: 1;
}
.cal-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 760px;
  width: 100%;
  margin: 0 auto;
}
.primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.primary-btn:hover {
  background: var(--accent-700);
}
.ghost-btn {
  padding: 9px 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
}
.ghost-btn:hover {
  background: var(--hover);
}
.form-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 20px;
  background: var(--bg);
}
.field {
  width: 100%;
  padding: 10px 14px;
  font: inherit;
  font-size: 14px;
  border-radius: 9px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-1);
  outline: none;
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
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-1);
}
.form-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cal-error {
  font-size: 13px;
  color: var(--danger);
}
.agenda {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.event {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--evcolor);
  background: color-mix(in srgb, var(--evcolor) 7%, var(--surface));
}
.event-text {
  flex: 1;
  min-width: 0;
}
.event-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-1);
}
.event-time {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-3);
  margin-top: 2px;
}
.icon-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.icon-btn:hover {
  background: var(--hover);
}
.icon-btn.danger:hover {
  color: var(--danger);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-3);
  font-size: 14px;
  font-weight: 500;
  padding: 60px 0;
}
</style>
