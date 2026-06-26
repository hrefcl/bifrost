<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const form = ref({
  email: '',
  password: '',
  displayName: '',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpSecure: true,
});

const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(form.value);
    void router.push({ name: 'inbox' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Login failed';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-4">
    <form
      class="w-full max-w-md space-y-4 rounded-xl border border-gray-200 bg-white p-8 shadow dark:border-gray-700 dark:bg-gray-900"
      @submit.prevent="submit"
    >
      <h1 class="text-2xl font-bold">Webmail 6.0</h1>
      <p class="text-gray-600 dark:text-gray-400">Sign in with your email account</p>

      <input v-model="form.email" type="email" placeholder="Email" required class="input" />
      <input
        v-model="form.password"
        type="password"
        placeholder="Password"
        required
        class="input"
      />
      <input v-model="form.displayName" type="text" placeholder="Display name" class="input" />

      <div class="grid grid-cols-2 gap-2">
        <input v-model="form.imapHost" type="text" placeholder="IMAP host" required class="input" />
        <input
          v-model.number="form.imapPort"
          type="number"
          placeholder="IMAP port"
          required
          class="input"
        />
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="form.imapSecure" type="checkbox" />
        IMAP TLS
      </label>

      <div class="grid grid-cols-2 gap-2">
        <input v-model="form.smtpHost" type="text" placeholder="SMTP host" required class="input" />
        <input
          v-model.number="form.smtpPort"
          type="number"
          placeholder="SMTP port"
          required
          class="input"
        />
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="form.smtpSecure" type="checkbox" />
        SMTP TLS
      </label>

      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
      <button
        type="submit"
        :disabled="loading"
        class="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {{ loading ? 'Signing in...' : 'Sign in' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.input {
  @apply w-full rounded-lg border border-gray-300 bg-white px-4 py-2 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800;
}
</style>
