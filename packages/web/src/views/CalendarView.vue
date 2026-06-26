<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import AppLayout from '@/layouts/AppLayout.vue';
import { useCalendarStore } from '@/stores/calendar';
import { api } from '@/lib/http';
import type { Account } from '@webmail6/shared';

const store = useCalendarStore();
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

const rangeStart = computed(() => {
  const d = new Date();
  d.setDate(1);
  return d.toISOString();
});
const rangeEnd = computed(() => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  return d.toISOString();
});

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

async function submit() {
  await store.createEvent({ ...form.value, uid: `local-${String(Date.now())}` });
  form.value = {
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
  };
  showForm.value = false;
}
</script>

<template>
  <AppLayout>
    <div class="p-6">
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-2xl font-bold">Calendar</h1>
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          @click="showForm = !showForm"
        >
          New event
        </button>
      </div>

      <form
        v-if="showForm"
        class="mb-6 space-y-3 rounded-xl border p-4 dark:border-gray-700"
        @submit.prevent="submit"
      >
        <input
          v-model="form.summary"
          type="text"
          placeholder="Event title"
          required
          class="input"
        />
        <select v-model="form.accountId" required class="input">
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.email }}
          </option>
        </select>
        <div class="grid grid-cols-2 gap-2">
          <input v-model="form.startDate" type="datetime-local" required class="input" />
          <input v-model="form.endDate" type="datetime-local" required class="input" />
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="form.allDay" type="checkbox" />
          All day
        </label>
        <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-white">Save</button>
      </form>

      <div class="space-y-2">
        <div
          v-for="event in store.events"
          :key="event.id"
          class="flex items-center justify-between rounded-lg border p-4 dark:border-gray-700"
        >
          <div>
            <div class="font-medium">{{ event.summary }}</div>
            <div class="text-sm text-gray-600 dark:text-gray-400">
              {{ new Date(event.startDate).toLocaleString() }} —
              {{ new Date(event.endDate).toLocaleString() }}
            </div>
          </div>
          <button class="text-sm text-red-600 hover:underline" @click="store.deleteEvent(event.id)">
            Delete
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.input {
  @apply w-full rounded-lg border border-gray-300 bg-white px-4 py-2 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800;
}
</style>
