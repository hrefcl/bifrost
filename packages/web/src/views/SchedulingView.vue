<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import { useSchedulingStore, type EventTypeInput } from '@/stores/scheduling';
import type { WeeklyRule, AvailabilitySchedule } from '@webmail6/shared';

const { t } = useI18n();
const store = useSchedulingStore();

type Tab = 'types' | 'availability' | 'bookings';
const tab = ref<Tab>('types');
const loading = ref(false);
const error = ref('');

const publicBase = computed(() => `${window.location.host}/u/${store.username ?? '…'}`);

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

function copy(text: string) {
  void navigator.clipboard.writeText(text);
}

// ── Username ──
const usernameDraft = ref('');
const usernameMsg = ref('');
async function saveUsername() {
  usernameMsg.value = '';
  try {
    await store.setUsername(usernameDraft.value.trim() || null);
    usernameMsg.value = t('scheduling.saved');
  } catch (e) {
    usernameMsg.value =
      (e as { response?: { data?: { message?: string } } }).response?.data?.message ??
      t('scheduling.error');
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

// ── Availability ──
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

// ── Bookings ──
async function cancelBooking(id: string) {
  if (!confirm(t('scheduling.confirmCancel'))) return;
  await store.cancelBooking(id);
}
function fmt(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  }).format(new Date(iso));
}
</script>

<template>
  <AppLayout>
    <div class="sched">
      <header class="sched__head">
        <h1>{{ t('scheduling.title') }}</h1>
        <div class="sched__tabs">
          <button :class="{ on: tab === 'types' }" @click="tab = 'types'">
            {{ t('scheduling.tabTypes') }}
          </button>
          <button :class="{ on: tab === 'availability' }" @click="tab = 'availability'">
            {{ t('scheduling.tabAvailability') }}
          </button>
          <button :class="{ on: tab === 'bookings' }" @click="tab = 'bookings'">
            {{ t('scheduling.tabBookings') }}
          </button>
        </div>
      </header>

      <p v-if="error" class="sched__err">{{ error }}</p>

      <!-- Banner enlace público / username -->
      <div class="sched__link">
        <template v-if="store.username">
          <span
            >{{ t('scheduling.yourLink') }}: <strong>{{ publicBase }}</strong></span
          >
          <button @click="copy(publicBase)">{{ t('scheduling.copy') }}</button>
          <a :href="`/u/${store.username}`" target="_blank">{{ t('scheduling.view') }} ↗</a>
        </template>
        <template v-else>
          <span>{{ t('scheduling.setUsername') }}:</span>
          <input v-model="usernameDraft" placeholder="ana" />
          <button @click="saveUsername">{{ t('scheduling.save') }}</button>
          <span class="sched__msg">{{ usernameMsg }}</span>
        </template>
      </div>

      <!-- TIPOS -->
      <section v-if="tab === 'types'">
        <div class="sched__rowend">
          <button class="btn" @click="openCreateType">+ {{ t('scheduling.newType') }}</button>
        </div>
        <p v-if="store.eventTypes.length === 0" class="sched__empty">
          {{ t('scheduling.noTypes') }}
        </p>
        <div class="sched__grid">
          <div
            v-for="ev in store.eventTypes"
            :key="ev.id"
            class="card"
            :style="{ borderLeftColor: ev.color }"
          >
            <div class="card__top">
              <strong>{{ ev.title }}</strong>
              <label class="toggle">
                <input
                  type="checkbox"
                  :checked="ev.active"
                  @change="toggleActive(ev.id, ($event.target as HTMLInputElement).checked)"
                />
                {{ ev.active ? t('scheduling.active') : t('scheduling.inactive') }}
              </label>
            </div>
            <div class="card__meta">
              {{ ev.durationMinutes }} min · {{ t('scheduling.loc_' + ev.location.type) }}
            </div>
            <div class="card__slug">/u/{{ store.username }}/{{ ev.slug }}</div>
            <div class="card__actions">
              <button @click="openEditType(ev.id)">{{ t('scheduling.edit') }}</button>
              <button @click="copy(`${publicBase}/${ev.slug}`)">{{ t('scheduling.copy') }}</button>
            </div>
          </div>
        </div>
      </section>

      <!-- DISPONIBILIDAD -->
      <section v-else-if="tab === 'availability'">
        <div v-if="!sched" class="sched__empty">
          <p>{{ t('scheduling.noSchedule') }}</p>
          <button class="btn" @click="ensureDefaultSchedule">
            {{ t('scheduling.createSchedule') }}
          </button>
        </div>
        <template v-else>
          <p class="sched__tz">
            {{ t('scheduling.timezone') }}: <strong>{{ sched.timezone }}</strong>
          </p>
          <div v-for="wd in WEEKDAYS" :key="wd" class="day">
            <label class="day__name">
              <input
                type="checkbox"
                :checked="rulesFor(wd).length > 0"
                @change="toggleDay(wd, ($event.target as HTMLInputElement).checked)"
              />
              {{ t('scheduling.weekday_' + wd) }}
            </label>
            <span v-if="rulesFor(wd).length" class="day__hours">
              <span v-for="(iv, i) in rulesFor(wd)" :key="i">{{ iv.start }}–{{ iv.end }}</span>
            </span>
            <span v-else class="day__off">{{ t('scheduling.unavailable') }}</span>
          </div>
          <p class="sched__msg">{{ availMsg }}</p>
        </template>
      </section>

      <!-- RESERVAS -->
      <section v-else>
        <p v-if="store.bookings.length === 0" class="sched__empty">
          {{ t('scheduling.noBookings') }}
        </p>
        <ul class="bookings">
          <li
            v-for="b in store.bookings"
            :key="b.id"
            :class="{ cancelled: b.status !== 'confirmed' }"
          >
            <span class="bookings__when">{{ fmt(b.startAt, b.snapshot.timezone) }}</span>
            <span class="bookings__title">{{ b.snapshot.title }}</span>
            <span class="bookings__guest">{{ b.invitee.name }} · {{ b.invitee.email }}</span>
            <span class="bookings__status">{{ t('scheduling.status_' + b.status) }}</span>
            <button v-if="b.status === 'confirmed'" @click="cancelBooking(b.id)">
              {{ t('scheduling.cancel') }}
            </button>
          </li>
        </ul>
      </section>

      <!-- Modal tipo -->
      <div v-if="showTypeModal" class="modal" @click.self="showTypeModal = false">
        <div class="modal__box" :style="{ borderTopColor: form.color }">
          <h3>{{ editingId ? t('scheduling.editType') : t('scheduling.newType') }}</h3>
          <label>{{ t('scheduling.name') }}<input v-model="form.title" /></label>
          <label>{{ t('scheduling.slug') }}<input v-model="form.slug" placeholder="30min" /></label>
          <label
            >{{ t('scheduling.duration')
            }}<input v-model.number="form.durationMinutes" type="number" min="5" max="1440"
          /></label>
          <label>{{ t('scheduling.color') }}<input v-model="form.color" type="color" /></label>
          <label
            >{{ t('scheduling.locationType') }}
            <select v-model="form.location.type">
              <option value="video">{{ t('scheduling.loc_video') }}</option>
              <option value="in_person">{{ t('scheduling.loc_in_person') }}</option>
              <option value="phone">{{ t('scheduling.loc_phone') }}</option>
              <option value="custom">{{ t('scheduling.loc_custom') }}</option>
            </select>
          </label>
          <label>{{ t('scheduling.locationValue') }}<input v-model="form.location.value" /></label>
          <div class="modal__row">
            <label
              >{{ t('scheduling.bufferBefore')
              }}<input v-model.number="form.bufferBeforeMin" type="number" min="0"
            /></label>
            <label
              >{{ t('scheduling.bufferAfter')
              }}<input v-model.number="form.bufferAfterMin" type="number" min="0"
            /></label>
          </div>
          <div class="modal__row">
            <label
              >{{ t('scheduling.minNoticeH')
              }}<input
                :value="Math.round(form.minimumNoticeMin / 60)"
                type="number"
                min="0"
                @input="
                  form.minimumNoticeMin = Number(($event.target as HTMLInputElement).value) * 60
                "
            /></label>
            <label
              >{{ t('scheduling.dateRange')
              }}<input v-model.number="form.dateRangeDays" type="number" min="1" max="365"
            /></label>
            <label
              >{{ t('scheduling.dailyLimit')
              }}<input v-model.number="form.dailyLimit" type="number" min="0"
            /></label>
          </div>
          <label
            >{{ t('scheduling.schedule') }}
            <select v-model="form.availabilityScheduleId">
              <option v-for="s in store.schedules" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <p v-if="typeError" class="sched__err">{{ typeError }}</p>
          <div class="modal__actions">
            <button @click="showTypeModal = false">{{ t('scheduling.cancel') }}</button>
            <button class="btn" @click="saveType">{{ t('scheduling.save') }}</button>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.sched {
  padding: 16px 24px;
  color: var(--text-1);
}
.sched__head {
  display: flex;
  align-items: center;
  gap: 24px;
}
.sched__head h1 {
  font-size: 20px;
  margin: 0;
}
.sched__tabs {
  display: flex;
  gap: 4px;
  background: var(--bg);
  border-radius: 8px;
  padding: 3px;
}
.sched__tabs button {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  font: inherit;
}
.sched__tabs button.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-sm);
}
.sched__link {
  margin: 14px 0;
  padding: 10px 14px;
  background: var(--bg);
  border-radius: 8px;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.sched__link input {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.sched__rowend {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}
.sched__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 4px solid;
  border-radius: 10px;
  padding: 12px;
}
.card__top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card__meta {
  color: var(--text-2);
  font-size: 13px;
  margin: 4px 0;
}
.card__slug {
  color: var(--text-3);
  font-size: 12px;
}
.card__actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.day {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.day__name {
  width: 120px;
}
.day__hours span {
  margin-right: 8px;
}
.day__off {
  color: var(--text-3);
}
.bookings {
  list-style: none;
  padding: 0;
}
.bookings li {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.bookings li.cancelled {
  opacity: 0.5;
}
.btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
  font: inherit;
}
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 70;
}
.modal__box {
  width: 420px;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--surface);
  border-radius: 14px;
  border-top: 4px solid;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.modal__box label {
  display: flex;
  flex-direction: column;
  font-size: 13px;
  gap: 2px;
}
.modal__box input,
.modal__box select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.modal__row {
  display: flex;
  gap: 8px;
}
.modal__row label {
  flex: 1;
}
.modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.sched__empty {
  color: var(--text-2);
  padding: 16px 0;
}
.sched__err {
  color: #dc2626;
}
.sched__msg {
  color: var(--text-3);
  font-size: 12px;
}
</style>
