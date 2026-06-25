<script setup lang="ts">
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';

const auth = useAuthStore();
const settings = useSettingsStore();
</script>

<template>
  <div class="flex h-screen flex-col">
    <header class="flex items-center justify-between border-b px-4 py-2 dark:border-gray-700">
      <div class="font-bold">Webmail 6.0</div>
      <div class="flex items-center gap-3">
        <nav class="hidden gap-2 md:flex">
          <router-link
            :to="{ name: 'inbox' }"
            class="rounded-lg px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            >Inbox</router-link
          >
          <router-link
            :to="{ name: 'contacts' }"
            class="rounded-lg px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            >Contacts</router-link
          >
          <router-link
            :to="{ name: 'calendar' }"
            class="rounded-lg px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            >Calendar</router-link
          >
          <router-link
            :to="{ name: 'settings' }"
            class="rounded-lg px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            >Settings</router-link
          >
        </nav>
        <span class="text-sm text-gray-600 dark:text-gray-400">{{ auth.user?.primaryEmail }}</span>
        <button
          class="rounded-lg border px-3 py-1 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
          @click="settings.setTheme(settings.theme === 'dark' ? 'light' : 'dark')"
        >
          {{ settings.theme === 'dark' ? 'Light' : 'Dark' }}
        </button>
        <button
          class="rounded-lg border px-3 py-1 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
          @click="auth.logout()"
        >
          Logout
        </button>
      </div>
    </header>
    <main class="flex-1 overflow-hidden">
      <slot />
    </main>
  </div>
</template>
