<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import AppAvatar from '@/components/AppAvatar.vue';
import { useContactStore } from '@/stores/contacts';

const store = useContactStore();
const { t } = useI18n();
const showForm = ref(false);
const form = ref({ fullName: '', email: '', organization: '' });

onMounted(() => {
  void store.fetchContacts();
});

async function submit() {
  await store.createContact(form.value);
  form.value = { fullName: '', email: '', organization: '' };
  showForm.value = false;
}
</script>

<template>
  <AppLayout>
    <div class="page">
      <div class="page-inner">
        <div class="head">
          <h1 class="page-title">{{ t('contacts.title') }}</h1>
          <button class="primary-btn" @click="showForm = !showForm">
            <AppIcon name="plus" :size="18" />{{ t('contacts.new') }}
          </button>
        </div>

        <form v-if="showForm" class="form-card" @submit.prevent="submit">
          <input
            v-model="form.fullName"
            type="text"
            :placeholder="t('contacts.fullName')"
            required
            class="field"
          />
          <input
            v-model="form.email"
            type="email"
            :placeholder="t('contacts.email')"
            required
            class="field"
          />
          <input
            v-model="form.organization"
            type="text"
            :placeholder="t('contacts.organization')"
            class="field"
          />
          <div class="form-actions">
            <button type="submit" class="primary-btn">{{ t('contacts.save') }}</button>
            <button type="button" class="ghost-btn" @click="showForm = false">
              {{ t('contacts.cancel') }}
            </button>
          </div>
        </form>

        <div v-if="store.contacts.length === 0" class="empty">
          <AppIcon name="users" :size="44" :stroke-width="1.3" />
          <div>{{ t('contacts.empty') }}</div>
        </div>
        <div v-else class="list">
          <div v-for="contact in store.contacts" :key="contact.id" class="contact">
            <AppAvatar :name="contact.fullName" :email="contact.email" :size="42" />
            <div class="contact-text">
              <div class="contact-name">{{ contact.fullName }}</div>
              <div class="contact-sub">
                {{ contact.email
                }}<template v-if="contact.organization"> · {{ contact.organization }}</template>
              </div>
            </div>
            <button
              class="icon-btn danger"
              :title="t('contacts.delete')"
              @click="store.deleteContact(contact.id)"
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
.page {
  height: 100%;
  overflow-y: auto;
  background: var(--surface);
}
.page-inner {
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 32px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.page-title {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0;
}
.primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 18px;
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
.form-actions {
  display: flex;
  gap: 10px;
}
.list {
  display: flex;
  flex-direction: column;
}
.contact {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 8px;
  border-bottom: 1px solid var(--border);
}
.contact-text {
  flex: 1;
  min-width: 0;
}
.contact-name {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-1);
}
.contact-sub {
  font-size: 13px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
