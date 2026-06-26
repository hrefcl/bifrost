<script setup lang="ts">
import AppLayout from '@/layouts/AppLayout.vue';
import { useSettingsStore } from '@/stores/settings';

const settings = useSettingsStore();
</script>

<template>
  <AppLayout>
    <div class="p-6">
      <h1 class="mb-4 text-2xl font-bold">Settings</h1>
      <div class="max-w-xl space-y-4 rounded-xl border p-6 dark:border-gray-700">
        <label class="block">
          <span class="text-sm font-medium">Theme</span>
          <select
            v-model="settings.theme"
            class="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </label>
      </div>
    </div>
  </AppLayout>
</template>
