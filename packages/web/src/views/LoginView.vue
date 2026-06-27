<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { brand } from '@/config/brand';
import { SUPPORTED_LOCALES, LOCALE_NAMES, setLocale, type Locale } from '@/i18n';
import AppLogo from '@/components/AppLogo.vue';
import AppIcon from '@/components/AppIcon.vue';

const router = useRouter();
const auth = useAuthStore();
const { t, locale } = useI18n();

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

const showPwd = ref(false);
const showServer = ref(false);
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(form.value);
    void router.push({ name: 'inbox' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('login.failed');
  } finally {
    loading.value = false;
  }
}

function switchLocale(l: Locale) {
  setLocale(l);
}
</script>

<template>
  <div class="login-bg">
    <div class="login-lang">
      <button
        v-for="l in SUPPORTED_LOCALES"
        :key="l"
        type="button"
        class="lang-btn"
        :class="{ active: locale === l }"
        @click="switchLocale(l)"
      >
        {{ LOCALE_NAMES[l] }}
      </button>
    </div>

    <div class="login-wrap">
      <div class="login-logo"><AppLogo :size="40" /></div>

      <form class="login-card" @submit.prevent="submit">
        <h1 class="login-title">{{ t('login.title') }}</h1>
        <p class="login-sub">{{ t('login.subtitle') }}</p>

        <label class="field-label">{{ t('login.email') }}</label>
        <input
          v-model="form.email"
          type="email"
          required
          class="field"
          placeholder="tu@correo.com"
        />

        <label class="field-label">{{ t('login.password') }}</label>
        <div class="pwd-wrap">
          <input
            v-model="form.password"
            :type="showPwd ? 'text' : 'password'"
            required
            class="field"
            placeholder="••••••••••••"
          />
          <button
            type="button"
            class="pwd-toggle"
            :aria-label="showPwd ? t('login.hidePassword') : t('login.showPassword')"
            @click="showPwd = !showPwd"
          >
            <AppIcon :name="showPwd ? 'sun' : 'lock'" :size="17" />
          </button>
        </div>

        <label class="field-label">{{ t('login.displayNameOptional') }}</label>
        <input v-model="form.displayName" type="text" class="field" />

        <button type="button" class="server-toggle" @click="showServer = !showServer">
          <AppIcon name="settings" :size="15" />
          {{ t('login.serverSettings') }}
          <AppIcon :name="showServer ? 'chevronDown' : 'chevronRight'" :size="15" />
        </button>
        <div v-if="showServer" class="server-grid">
          <p class="server-hint">{{ t('login.serverSettingsHint') }}</p>
          <div class="row">
            <input
              v-model="form.imapHost"
              type="text"
              class="field"
              :placeholder="t('login.imapHost')"
            />
            <input
              v-model.number="form.imapPort"
              type="number"
              class="field port"
              :placeholder="t('login.imapPort')"
            />
          </div>
          <div class="row">
            <input
              v-model="form.smtpHost"
              type="text"
              class="field"
              :placeholder="t('login.smtpHost')"
            />
            <input
              v-model.number="form.smtpPort"
              type="number"
              class="field port"
              :placeholder="t('login.smtpPort')"
            />
          </div>
        </div>

        <p v-if="error" class="login-error">{{ error }}</p>

        <button type="submit" class="submit-btn" :disabled="loading">
          {{ loading ? t('login.submitting') : t('login.submit') }}
        </button>

        <div class="encrypted">
          <AppIcon name="lock" :size="13" />
          {{ t('login.encrypted') }}
        </div>
      </form>

      <p class="login-foot">{{ brand.name }} {{ brand.version }} · {{ brand.tagline }}</p>
    </div>
  </div>
</template>

<style scoped>
.login-bg {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  background-image:
    radial-gradient(
      circle at 15% 15%,
      color-mix(in srgb, var(--accent) 9%, transparent),
      transparent 45%
    ),
    radial-gradient(circle at 85% 85%, color-mix(in srgb, #9333ea 7%, transparent), transparent 45%);
}
.login-lang {
  position: absolute;
  top: 20px;
  right: 22px;
  display: flex;
  gap: 4px;
}
.lang-btn {
  border: none;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.lang-btn.active {
  color: var(--accent);
  background: var(--accent-soft);
}
.login-wrap {
  width: 400px;
  max-width: 100%;
}
.login-logo {
  display: flex;
  justify-content: center;
  margin-bottom: 28px;
}
.login-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 32px 34px 30px;
  box-shadow: var(--shadow-lg);
}
.login-title {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
}
.login-sub {
  font-size: 14px;
  color: var(--text-2);
  margin: 0 0 22px;
}
.field-label {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  margin: 14px 0 7px;
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
.pwd-wrap {
  position: relative;
}
.pwd-toggle {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-3);
  display: flex;
}
.server-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  margin: 18px 0 0;
}
.server-grid {
  margin-top: 12px;
}
.server-hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 0 0 10px;
}
.row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.row .field {
  flex: 1;
}
.field.port {
  max-width: 110px;
}
.login-error {
  font-size: 12.5px;
  color: var(--danger);
  margin: 14px 0 0;
}
.submit-btn {
  width: 100%;
  margin-top: 20px;
  padding: 12px 26px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  transition: background 0.13s;
}
.submit-btn:hover:not(:disabled) {
  background: var(--accent-700);
}
.submit-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.encrypted {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3);
  margin-top: 16px;
}
.login-foot {
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
  margin-top: 20px;
}
</style>
