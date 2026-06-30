<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Email, EmailBody, EmailAttachmentMeta } from '@webmail6/shared';
import AppAvatar from './AppAvatar.vue';
import AppIcon from './AppIcon.vue';
import EmailBodyFrame from './EmailBodyFrame.vue';
import { api } from '@/lib/http';

/**
 * Un mensaje dentro de la vista de conversación (hilo). Colapsable: el header siempre se ve; el cuerpo
 * se carga PEREZOSO al expandir (no traemos N bodies de un hilo largo de golpe). El más reciente (o el
 * que abrió el usuario) viene expandido por defecto. Cada mensaje maneja su propio body/adjuntos.
 */
const props = defineProps<{ email: Email; expanded?: boolean }>();
const emit = defineEmits<{ reply: [email: Email] }>();
const { t, locale } = useI18n();

const open = ref(props.expanded);
const body = ref<EmailBody | null>(null);
const attachments = ref<EmailAttachmentMeta[]>([]);
const loading = ref(false);
let loaded = false;

const senderName = (e: Email) => (e.from.name?.trim() ? e.from.name : e.from.address);
function fmtFull(iso: string): string {
  return new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadBody() {
  if (loaded || loading.value) return;
  loading.value = true;
  try {
    const { data } = await api.get<EmailBody>(`/emails/${props.email.id}/body`);
    body.value = data;
    attachments.value = data.attachments ?? [];
    loaded = true;
  } catch {
    /* el header igual queda visible */
  } finally {
    loading.value = false;
  }
}

function toggle() {
  open.value = !open.value;
  if (open.value) void loadBody();
}

async function downloadAttachment(att: EmailAttachmentMeta) {
  try {
    const res = await api.get<Blob>(`/emails/${props.email.id}/attachments/${att.id}`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    /* noop */
  }
}

onMounted(() => {
  if (open.value) void loadBody();
});
watch(
  () => props.email.id,
  () => {
    loaded = false;
    body.value = null;
    attachments.value = [];
    open.value = props.expanded;
    if (open.value) void loadBody();
  }
);
</script>

<template>
  <div class="tmsg" :class="{ open }">
    <div class="tmsg-head" @click="toggle">
      <AppAvatar :name="email.from.name" :email="email.from.address" :size="34" />
      <div class="tmsg-id">
        <div class="tmsg-from">
          <span class="tmsg-name">{{ senderName(email) }}</span>
          <span v-if="open" class="tmsg-addr">&lt;{{ email.from.address }}&gt;</span>
        </div>
        <div v-if="!open" class="tmsg-preview">{{ email.preview }}</div>
      </div>
      <span class="tmsg-date">{{ fmtFull(email.date) }}</span>
      <button
        v-if="open"
        class="icon-btn"
        :title="t('thread.reply')"
        @click.stop="emit('reply', email)"
      >
        <AppIcon name="reply" :size="17" />
      </button>
    </div>

    <div v-if="open" class="tmsg-body">
      <p v-if="loading" class="tmsg-loading">{{ t('common.loading') }}</p>
      <template v-else-if="body">
        <EmailBodyFrame v-if="body.sanitizedHtml" :html="body.sanitizedHtml" />
        <pre v-else class="tmsg-plain">{{ body.text }}</pre>
      </template>

      <div v-if="attachments.length" class="tmsg-atts">
        <div class="tmsg-att-title">
          <AppIcon name="paperclip" :size="14" />
          {{ t('thread.attachments', attachments.length) }}
        </div>
        <button
          v-for="att in attachments"
          :key="att.id"
          class="tmsg-att"
          @click="downloadAttachment(att)"
        >
          <AppIcon name="file" :size="16" />
          <span class="tmsg-att-name">{{ att.filename }}</span>
          <span class="tmsg-att-size">{{ Math.round(att.size / 1024) }} KB</span>
          <AppIcon name="download" :size="15" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tmsg {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  margin-bottom: 8px;
  background: var(--surface-1, #fff);
  overflow: hidden;
}
.tmsg.open {
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);
}
.tmsg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
}
.tmsg-id {
  flex: 1;
  min-width: 0;
}
.tmsg-from {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.tmsg-name {
  font-weight: 600;
  font-size: 13.5px;
}
.tmsg-addr {
  font-size: 12px;
  color: var(--text-2, #6b7280);
}
.tmsg-preview {
  font-size: 12.5px;
  color: var(--text-2, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tmsg-date {
  font-size: 12px;
  color: var(--text-2, #6b7280);
  flex-shrink: 0;
}
.tmsg-body {
  padding: 4px 14px 14px;
}
.tmsg-plain {
  white-space: pre-wrap;
  font-family: inherit;
  margin: 0;
}
.tmsg-atts {
  margin-top: 10px;
  border-top: 1px solid var(--border, #e5e7eb);
  padding-top: 10px;
}
.tmsg-att-title {
  font-size: 12px;
  color: var(--text-2, #6b7280);
  margin-bottom: 6px;
}
.tmsg-att {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
}
.tmsg-att-name {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tmsg-att-size {
  color: var(--text-2, #6b7280);
  font-size: 11px;
}
</style>
