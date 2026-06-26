<script setup lang="ts">
import { ref } from 'vue';
import axios from 'axios';

interface ValidationResponse {
  mongo: { ok: boolean; error?: string };
  redis: { ok: boolean; error?: string };
}

const step = ref(1);
const loading = ref(false);
const error = ref('');
const success = ref(false);

const db = ref({
  mongodbUri: 'mongodb://localhost:27017/webmail6',
  redisUrl: 'redis://localhost:6379/0',
});
const admin = ref({ email: '', password: '', displayName: '' });
const email = ref({
  name: '',
  email: '',
  password: '',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpSecure: true,
});
const app = ref({ frontendUrl: 'http://localhost:5173', corsOrigin: 'http://localhost:5173' });

async function testConnections() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await axios.post<ValidationResponse>('/api/setup/validate-db', db.value);
    if (!data.mongo.ok) throw new Error(data.mongo.error ?? 'MongoDB connection failed');
    if (!data.redis.ok) throw new Error(data.redis.error ?? 'Redis connection failed');
    step.value = 2;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Connection test failed';
  } finally {
    loading.value = false;
  }
}

async function submit() {
  loading.value = true;
  error.value = '';
  try {
    await axios.post('/api/setup', {
      db: db.value,
      admin: admin.value,
      email: {
        name: email.value.name,
        email: email.value.email,
        password: email.value.password,
        imapHost: email.value.imapHost,
        imapPort: email.value.imapPort,
        imapSecure: email.value.imapSecure,
        smtpHost: email.value.smtpHost,
        smtpPort: email.value.smtpPort,
        smtpSecure: email.value.smtpSecure,
      },
      app: app.value,
    });
    success.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Setup failed';
  } finally {
    loading.value = false;
  }
}

function reloadPage() {
  window.location.reload();
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 px-4 py-12 dark:bg-gray-950">
    <div
      class="mx-auto max-w-2xl rounded-2xl border bg-white p-8 shadow dark:border-gray-800 dark:bg-gray-900"
    >
      <h1 class="mb-2 text-3xl font-bold">Welcome to Webmail 6.0</h1>
      <p class="mb-6 text-gray-600 dark:text-gray-400">Let's configure your installation.</p>

      <div v-if="success" class="space-y-4">
        <div
          class="rounded-lg bg-green-50 p-4 text-green-800 dark:bg-green-900/30 dark:text-green-300"
        >
          Setup completed successfully.
        </div>
        <p class="text-gray-700 dark:text-gray-300">
          Please restart the server to apply the new configuration, then refresh this page to log
          in.
        </p>
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          @click="reloadPage"
        >
          Refresh
        </button>
      </div>

      <div v-else>
        <div class="mb-6 flex items-center gap-2">
          <div
            v-for="s in 3"
            :key="s"
            :class="[
              'h-2 flex-1 rounded-full',
              step >= s ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700',
            ]"
          />
        </div>

        <p
          v-if="error"
          class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300"
        >
          {{ error }}
        </p>

        <div v-if="step === 1" class="space-y-4">
          <h2 class="text-xl font-semibold">1. Database & Cache</h2>
          <label class="block text-sm">
            MongoDB URI
            <input v-model="db.mongodbUri" type="text" class="input" />
          </label>
          <label class="block text-sm">
            Redis URL
            <input v-model="db.redisUrl" type="text" class="input" />
          </label>
          <button
            class="w-full rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="loading"
            @click="testConnections"
          >
            {{ loading ? 'Testing...' : 'Test connections' }}
          </button>
        </div>

        <div v-if="step === 2" class="space-y-4">
          <h2 class="text-xl font-semibold">2. Admin account</h2>
          <input v-model="admin.displayName" type="text" placeholder="Display name" class="input" />
          <input v-model="admin.email" type="email" placeholder="Admin email" class="input" />
          <input v-model="admin.password" type="password" placeholder="Password" class="input" />
          <button
            class="w-full rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
            @click="step = 3"
          >
            Continue
          </button>
        </div>

        <div v-if="step === 3" class="space-y-4">
          <h2 class="text-xl font-semibold">3. Mail account</h2>
          <input v-model="email.name" type="text" placeholder="Your name" class="input" />
          <input v-model="email.email" type="email" placeholder="Email address" class="input" />
          <input
            v-model="email.password"
            type="password"
            placeholder="Email password"
            class="input"
          />
          <div class="grid grid-cols-2 gap-2">
            <input v-model="email.imapHost" type="text" placeholder="IMAP host" class="input" />
            <input
              v-model.number="email.imapPort"
              type="number"
              placeholder="IMAP port"
              class="input"
            />
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="email.imapSecure" type="checkbox" />
            IMAP TLS
          </label>
          <div class="grid grid-cols-2 gap-2">
            <input v-model="email.smtpHost" type="text" placeholder="SMTP host" class="input" />
            <input
              v-model.number="email.smtpPort"
              type="number"
              placeholder="SMTP port"
              class="input"
            />
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="email.smtpSecure" type="checkbox" />
            SMTP TLS
          </label>
          <button
            class="w-full rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="loading"
            @click="submit"
          >
            {{ loading ? 'Finishing...' : 'Finish setup' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.input {
  @apply mt-1 w-full rounded-lg border border-gray-300 bg-white px-4 py-2 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800;
}
</style>
