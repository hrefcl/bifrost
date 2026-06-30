<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/lib/http';
import type { CalendarSettings } from '@webmail6/shared';

/** Panel admin de Preferencias de calendario (F5): defaults a nivel instancia. /api/admin/config/calendar. */
const { t } = useI18n();
const settings = ref<CalendarSettings | null>(null);
const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

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

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get<CalendarSettings>('/admin/config/calendar');
    settings.value = data;
  } catch {
    error.value = t('admin.calendar.errLoad');
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!settings.value) return;
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    const { data } = await api.patch<CalendarSettings>('/admin/config/calendar', settings.value);
    settings.value = data;
    saved.value = true;
  } catch {
    error.value = t('admin.calendar.errSave');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="card">
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <template v-else-if="settings">
      <div class="grid" @input="saved = false">
        <label class="fld">
          <span>{{ t('admin.calendar.timezone') }}</span>
          <select v-model="settings.timezone">
            <option v-for="tz in COMMON_TZ" :key="tz" :value="tz">{{ tz }}</option>
            <option v-if="!COMMON_TZ.includes(settings.timezone)" :value="settings.timezone">
              {{ settings.timezone }}
            </option>
          </select>
        </label>
        <label class="fld">
          <span>{{ t('admin.calendar.weekStart') }}</span>
          <select v-model.number="settings.weekStart">
            <option :value="1">{{ t('admin.calendar.monday') }}</option>
            <option :value="0">{{ t('admin.calendar.sunday') }}</option>
          </select>
        </label>
        <label class="fld">
          <span>{{ t('admin.calendar.dayStart') }}</span>
          <input v-model="settings.dayStart" type="time" />
        </label>
        <label class="fld">
          <span>{{ t('admin.calendar.dayEnd') }}</span>
          <input v-model="settings.dayEnd" type="time" />
        </label>
        <label class="fld">
          <span>{{ t('admin.calendar.defaultDuration') }}</span>
          <input v-model.number="settings.defaultDurationMin" type="number" min="5" max="480" />
        </label>
        <label class="fld">
          <span>{{ t('admin.calendar.defaultView') }}</span>
          <select v-model="settings.defaultView">
            <option value="day">{{ t('admin.calendar.viewDay') }}</option>
            <option value="week">{{ t('admin.calendar.viewWeek') }}</option>
            <option value="month">{{ t('admin.calendar.viewMonth') }}</option>
          </select>
        </label>
      </div>

      <div class="switches">
        <label class="switch-row">
          <input v-model="settings.showWeekends" type="checkbox" @change="saved = false" />
          <span
            ><strong>{{ t('admin.calendar.showWeekends') }}</strong>
            {{ t('admin.calendar.showWeekendsHint') }}</span
          >
        </label>
        <label class="switch-row">
          <input v-model="settings.autoInvite" type="checkbox" @change="saved = false" />
          <span
            ><strong>{{ t('admin.calendar.autoInvite') }}</strong>
            {{ t('admin.calendar.autoInviteHint') }}</span
          >
        </label>
        <label class="switch-row">
          <input v-model="settings.syncAgenda" type="checkbox" @change="saved = false" />
          <span
            ><strong>{{ t('admin.calendar.syncAgenda') }}</strong>
            {{ t('admin.calendar.syncAgendaHint') }}</span
          >
        </label>
      </div>

      <div class="actions">
        <button class="btn" :disabled="saving" @click="save">
          {{ saving ? t('admin.saving') : t('admin.save') }}
        </button>
        <span v-if="saved" class="ok">{{ t('admin.saved') }}</span>
        <span v-if="error" class="err">{{ error }}</span>
      </div>
    </template>
    <p v-else class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 24px;
  box-shadow: var(--shadow-sm);
}
.muted {
  color: var(--text-3);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.fld input,
.fld select {
  padding: 9px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font: inherit;
  font-weight: 400;
  background: var(--surface);
  color: var(--text-1);
}
.fld input:focus,
.fld select:focus {
  outline: none;
  border-color: var(--accent);
}
.switches {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 20px 0;
}
.switch-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13.5px;
  color: var(--text-2);
}
.switch-row strong {
  color: var(--text-1);
}
.switch-row input {
  margin-top: 2px;
  accent-color: var(--accent);
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.btn {
  padding: 9px 20px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.55;
}
.ok {
  color: var(--green, #16a34a);
  font-weight: 600;
  font-size: 13.5px;
}
.err {
  color: var(--danger);
  font-size: 13.5px;
}
</style>
