<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import axios from 'axios';
import { brand } from '@/config/brand';
import AppLogo from '@/components/AppLogo.vue';

interface ValidationResponse {
  mongo: { ok: boolean; error?: string };
  redis: { ok: boolean; error?: string };
}

const { t } = useI18n();

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
    if (!data.mongo.ok) throw new Error(data.mongo.error ?? t('setup.errMongo'));
    if (!data.redis.ok) throw new Error(data.redis.error ?? t('setup.errRedis'));
    step.value = 2;
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('setup.errTest');
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
    error.value = err instanceof Error ? err.message : t('setup.errSetup');
  } finally {
    loading.value = false;
  }
}

function reloadPage() {
  window.location.reload();
}
</script>

<template>
  <div class="setup-bg">
    <div class="setup-card">
      <div class="setup-logo"><AppLogo :size="34" /></div>
      <h1 class="setup-title">{{ t('setup.welcome', { brand: brand.name }) }}</h1>
      <p class="setup-sub">{{ t('setup.subtitle') }}</p>

      <div v-if="success" class="done">
        <div class="done-badge">{{ t('setup.done') }}</div>
        <p class="done-text">{{ t('setup.restart') }}</p>
        <button class="primary" @click="reloadPage">{{ t('setup.refresh') }}</button>
      </div>

      <div v-else>
        <div class="steps">
          <div v-for="s in 3" :key="s" class="step-bar" :class="{ on: step >= s }" />
        </div>

        <p v-if="error" class="err">{{ error }}</p>

        <div v-if="step === 1" class="form">
          <h2 class="step-h">{{ t('setup.step1') }}</h2>
          <label class="lbl"
            >{{ t('setup.mongoUri') }}<input v-model="db.mongodbUri" type="text" class="field"
          /></label>
          <label class="lbl"
            >{{ t('setup.redisUrl') }}<input v-model="db.redisUrl" type="text" class="field"
          /></label>
          <button class="primary full" :disabled="loading" @click="testConnections">
            {{ loading ? t('setup.testing') : t('setup.testConnections') }}
          </button>
        </div>

        <div v-if="step === 2" class="form">
          <h2 class="step-h">{{ t('setup.step2') }}</h2>
          <input
            v-model="admin.displayName"
            type="text"
            :placeholder="t('setup.displayName')"
            class="field"
          />
          <input
            v-model="admin.email"
            type="email"
            :placeholder="t('setup.adminEmail')"
            class="field"
          />
          <input
            v-model="admin.password"
            type="password"
            :placeholder="t('setup.password')"
            class="field"
          />
          <button class="primary full" @click="step = 3">{{ t('setup.continue') }}</button>
        </div>

        <div v-if="step === 3" class="form">
          <h2 class="step-h">{{ t('setup.step3') }}</h2>
          <input
            v-model="email.name"
            type="text"
            :placeholder="t('setup.yourName')"
            class="field"
          />
          <input
            v-model="email.email"
            type="email"
            :placeholder="t('setup.emailAddress')"
            class="field"
          />
          <input
            v-model="email.password"
            type="password"
            :placeholder="t('setup.emailPassword')"
            class="field"
          />
          <div class="grid2">
            <input
              v-model="email.imapHost"
              type="text"
              :placeholder="t('setup.imapHost')"
              class="field"
            />
            <input
              v-model.number="email.imapPort"
              type="number"
              :placeholder="t('setup.imapPort')"
              class="field"
            />
          </div>
          <label class="check"><input v-model="email.imapSecure" type="checkbox" /> IMAP TLS</label>
          <div class="grid2">
            <input
              v-model="email.smtpHost"
              type="text"
              :placeholder="t('setup.smtpHost')"
              class="field"
            />
            <input
              v-model.number="email.smtpPort"
              type="number"
              :placeholder="t('setup.smtpPort')"
              class="field"
            />
          </div>
          <label class="check"><input v-model="email.smtpSecure" type="checkbox" /> SMTP TLS</label>
          <button class="primary full" :disabled="loading" @click="submit">
            {{ loading ? t('setup.finishing') : t('setup.finish') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup-bg {
  min-height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 16px;
  background: var(--bg);
}
.setup-card {
  width: 100%;
  max-width: 560px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  padding: 32px;
}
.setup-logo {
  margin-bottom: 18px;
}
.setup-title {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
}
.setup-sub {
  font-size: 14px;
  color: var(--text-2);
  margin: 0 0 24px;
}
.steps {
  display: flex;
  gap: 8px;
  margin-bottom: 22px;
}
.step-bar {
  height: 6px;
  flex: 1;
  border-radius: 3px;
  background: var(--border);
}
.step-bar.on {
  background: var(--accent);
}
.err {
  font-size: 13.5px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  padding: 10px 12px;
  border-radius: 9px;
  margin: 0 0 16px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.step-h {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 4px;
}
.lbl {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.field {
  width: 100%;
  padding: 11px 14px;
  font: inherit;
  font-size: 14px;
  border-radius: 9px;
  border: 1px solid var(--border-strong);
  background: var(--bg);
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
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-1);
}
.primary {
  padding: 11px 22px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.primary:hover:not(:disabled) {
  background: var(--accent-700);
}
.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
.primary.full {
  width: 100%;
}
.done {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.done-badge {
  background: color-mix(in srgb, #16a34a 14%, transparent);
  color: #16a34a;
  font-weight: 600;
  font-size: 14px;
  padding: 12px 14px;
  border-radius: 9px;
}
.done-text {
  font-size: 14px;
  color: var(--text-2);
  line-height: 1.5;
  margin: 0;
}
</style>
