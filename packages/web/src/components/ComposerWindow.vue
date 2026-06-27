<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import AppIcon from '@/components/AppIcon.vue';
import { api } from '@/lib/http';
import { useDraftStore, type ReplyContext } from '@/stores/drafts';
import { useAuthStore } from '@/stores/auth';
import { useComposerStore } from '@/stores/composer';
import type { Account, Draft, DraftAttachment, Email, EmailBody } from '@webmail6/shared';

/**
 * Ventana de redacción flotante estilo Gmail (overlay sobre la vista actual, minimizable).
 * Reemplaza la ruta /compose. Lee el contexto (nuevo / borrador / reply / forward) del store.
 */
const draftStore = useDraftStore();
const auth = useAuthStore();
const composer = useComposerStore();
const { t, locale } = useI18n();

const ctx = composer.context;
const draftId = ref<string | null>(ctx.draftId ?? null);
const accounts = ref<Account[]>([]);
const error = ref('');
const sending = ref(false);
const savedStatus = ref('');
const replyContext = ref<ReplyContext | null>(null);

const attachments = ref<DraftAttachment[]>([]);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const MAX_ATTACHMENTS = 25;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const form = ref({ accountId: '', to: '', cc: '', bcc: '', subject: '', bodyHtml: '' });
const showCcManually = ref(false);
const ccVisible = computed(
  () => showCcManually.value || form.value.cc.length > 0 || form.value.bcc.length > 0
);

// Título de la ventana según el contexto (Mensaje nuevo / Responder / Reenviar).
const windowTitle = computed(() => {
  if (ctx.replyTo) return t('thread.reply');
  if (ctx.replyAll) return t('thread.replyAll');
  if (ctx.forward) return t('thread.forward');
  return t('composer.newMessage');
});

// ---------- Editor TipTap inline (toolbar va en el footer, estilo Gmail) ----------
const editor = useEditor({
  content: form.value.bodyHtml,
  extensions: [
    StarterKit.configure({ link: false }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      protocols: ['http', 'https', 'mailto'],
      isAllowedUri: (url) => {
        try {
          const proto = new URL(url, 'https://placeholder.local').protocol;
          return proto === 'http:' || proto === 'https:' || proto === 'mailto:';
        } catch {
          return false;
        }
      },
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    }),
    Placeholder.configure({ placeholder: () => t('composer.body') }),
  ],
  onUpdate: ({ editor }) => {
    form.value.bodyHtml = editor.getHTML();
  },
});

watch(
  () => form.value.bodyHtml,
  (val) => {
    if (editor.value && val !== editor.value.getHTML()) {
      editor.value.commands.setContent(val, { emitUpdate: false });
    }
  }
);

function setLink(): void {
  const prev = editor.value?.getAttributes('link').href as string | undefined;
  const url = window.prompt(t('editor.linkPrompt'), prev ?? 'https://');
  if (url === null) return;
  if (url === '') {
    editor.value?.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  editor.value?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
}

// ---------- carga / wiring ----------
function composerState() {
  return { ...form.value, attachmentIds: attachments.value.map((a) => a.blobId) };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildQuote(orig: Email, body: EmailBody): string {
  const who = orig.from.name ?? orig.from.address;
  const when = new Date(orig.date).toLocaleString();
  const inner =
    body.sanitizedHtml && body.sanitizedHtml.length > 0
      ? body.sanitizedHtml
      : body.text
        ? `<pre>${escapeHtml(body.text)}</pre>`
        : '';
  return `<br><br><blockquote style="margin:0 0 0 8px;border-left:2px solid #ccc;padding-left:8px;color:#666">On ${escapeHtml(when)}, ${escapeHtml(who)} wrote:<br>${inner}</blockquote>`;
}

async function prefillFromOriginal(
  originalId: string,
  mode: 'reply' | 'replyAll' | 'forward'
): Promise<void> {
  const [{ data: orig }, { data: origBody }] = await Promise.all([
    api.get<Email>(`/emails/${originalId}`),
    api.get<EmailBody>(`/emails/${originalId}/body`),
  ]);
  form.value.accountId = orig.accountId;
  const subject = orig.subject;
  if (mode === 'reply' || mode === 'replyAll') {
    const self = accounts.value.find((a) => a.id === orig.accountId)?.email.toLowerCase();
    const fromAddr = orig.from.address.toLowerCase();
    if (self && fromAddr === self) {
      const origTo = orig.to.map((a) => a.address).filter((a) => a.toLowerCase() !== self);
      form.value.to = (origTo.length > 0 ? origTo : [orig.from.address]).join(', ');
    } else {
      form.value.to = orig.replyTo?.address ?? orig.from.address;
    }
    if (mode === 'replyAll') {
      const inTo = new Set(
        form.value.to
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
      const seen = new Set<string>();
      const cc: string[] = [];
      for (const a of [...orig.to, ...(orig.cc ?? [])]) {
        const low = a.address.toLowerCase();
        if (low === self || low === fromAddr || inTo.has(low) || seen.has(low)) continue;
        seen.add(low);
        cc.push(a.address);
      }
      form.value.cc = cc.join(', ');
    }
    form.value.subject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
    replyContext.value = {
      emailId: orig.id,
      messageId: orig.messageId,
      references: [...(orig.references ?? []), orig.messageId].filter(Boolean),
    };
  } else {
    form.value.subject = /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
  }
  form.value.bodyHtml = buildQuote(orig, origBody);
}

onMounted(async () => {
  try {
    const { data } = await api.get<Account[]>('/accounts');
    accounts.value = data;
    if (data.length > 0 && !form.value.accountId) form.value.accountId = data[0].id;

    if (draftId.value) {
      const { data: draft } = await api.get<Draft>(`/drafts/${draftId.value}`);
      form.value.accountId = draft.accountId;
      form.value.to = draft.to.map((a) => a.address).join(', ');
      form.value.cc = draft.cc?.map((a) => a.address).join(', ') ?? '';
      form.value.bcc = draft.bcc?.map((a) => a.address).join(', ') ?? '';
      form.value.subject = draft.subject;
      form.value.bodyHtml = draft.bodyHtml ?? '';
      attachments.value = draft.attachments;
    } else {
      if (ctx.replyTo) await prefillFromOriginal(ctx.replyTo, 'reply');
      else if (ctx.replyAll) await prefillFromOriginal(ctx.replyAll, 'replyAll');
      else if (ctx.forward) await prefillFromOriginal(ctx.forward, 'forward');

      const prefs = auth.user?.preferences;
      if (prefs?.autoIncludeSignature && prefs.defaultSignature) {
        form.value.bodyHtml = `<p></p>${prefs.defaultSignature}${form.value.bodyHtml}`;
      }
    }
  } catch {
    error.value = t('composer.errLoad');
  } finally {
    pristine.value = snapshot();
  }
});

// ---------- autosave (estilo Gmail) ----------
const pristine = ref('');
function snapshot(): string {
  return JSON.stringify({ ...form.value, atts: attachments.value.map((a) => a.blobId) });
}
const dirty = computed(() => snapshot() !== pristine.value);
function hasContent(): boolean {
  return Boolean(
    form.value.to.trim() ||
    form.value.cc.trim() ||
    form.value.subject.trim() ||
    attachments.value.length ||
    editor.value?.getText().trim()
  );
}

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => snapshot(),
  () => {
    if (uploading.value || sending.value || !dirty.value || !hasContent()) return;
    savedStatus.value = t('composer.saving');
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void saveDraft(true), 2200);
  }
);

async function saveDraft(silent = false): Promise<void> {
  if (uploading.value) {
    if (!silent) error.value = t('composer.errUploadWait');
    return;
  }
  try {
    if (draftId.value) {
      await draftStore.updateDraft(draftId.value, composerState());
    } else {
      const created = await draftStore.createDraft(
        composerState(),
        replyContext.value ?? undefined
      );
      draftId.value = created.id;
    }
    pristine.value = snapshot();
    const time = new Date().toLocaleTimeString(locale.value, {
      hour: '2-digit',
      minute: '2-digit',
    });
    savedStatus.value = t('composer.savedAt', { time });
  } catch {
    if (!silent) error.value = t('composer.errSave');
    savedStatus.value = '';
  }
}

async function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length === 0) return;
  error.value = '';
  uploading.value = true;
  savedStatus.value = t('composer.uploading');
  const failed: string[] = [];
  try {
    for (const file of files) {
      if (attachments.value.length >= MAX_ATTACHMENTS) {
        error.value = t('composer.errMax', { n: MAX_ATTACHMENTS });
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        failed.push(file.name);
        continue;
      }
      try {
        const fd = new FormData();
        fd.append('file', file);
        const { data } = await api.post<{
          id: string;
          filename: string;
          contentType: string;
          size: number;
        }>('/attachments', fd);
        attachments.value.push({
          blobId: data.id,
          filename: data.filename,
          contentType: data.contentType,
          size: data.size,
        });
      } catch {
        failed.push(file.name);
      }
    }
    if (failed.length > 0) error.value = t('composer.errAttach', { names: failed.join(', ') });
  } finally {
    uploading.value = false;
    savedStatus.value = '';
    if (fileInput.value) fileInput.value.value = '';
  }
}

function removeAttachment(blobId: string) {
  attachments.value = attachments.value.filter((a) => a.blobId !== blobId);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function send() {
  if (uploading.value) {
    error.value = t('composer.errUploadWait');
    return;
  }
  if (!draftId.value) await saveDraft();
  if (!draftId.value) return;
  sending.value = true;
  error.value = '';
  try {
    await draftStore.updateDraft(draftId.value, composerState());
    await draftStore.sendDraft(draftId.value);
    composer.close();
  } catch {
    error.value = t('composer.errSend');
  } finally {
    sending.value = false;
  }
}

// beforeunload anti-pérdida (la navegación SPA no aplica: el composer es overlay).
function beforeUnloadHandler(e: BeforeUnloadEvent): void {
  if (dirty.value && hasContent()) e.preventDefault();
}
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnloadHandler);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnloadHandler);
  clearTimeout(autosaveTimer);
  editor.value?.destroy();
});
</script>

<template>
  <!-- Minimizado: barra compacta abajo-derecha -->
  <div v-if="composer.minimized" class="cw-min" @click="composer.toggleMinimize()">
    <span class="cw-min-title">{{ form.subject || windowTitle }}</span>
    <button class="cw-head-btn" :title="t('common.close')" @click.stop="composer.close()">
      <AppIcon name="x" :size="18" />
    </button>
  </div>

  <!-- Ventana flotante -->
  <div v-else class="cw">
    <div class="cw-head">
      <span class="cw-title">{{ windowTitle }}</span>
      <button
        class="cw-head-btn"
        :title="t('composer.minimize')"
        @click="composer.toggleMinimize()"
      >
        <AppIcon name="chevronDown" :size="18" />
      </button>
      <button class="cw-head-btn" :title="t('common.close')" @click="composer.close()">
        <AppIcon name="x" :size="18" />
      </button>
    </div>

    <div class="cw-fields">
      <div v-if="accounts.length > 1" class="cw-row">
        <span class="cw-key">{{ t('composer.from') }}</span>
        <select v-model="form.accountId" class="cw-input">
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.email }}</option>
        </select>
      </div>
      <!-- select oculto para 1 cuenta: mantiene el From accesible sin recargar la UI -->
      <select
        v-else
        v-model="form.accountId"
        class="cw-hidden-select"
        aria-hidden="true"
        tabindex="-1"
      >
        <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.email }}</option>
      </select>

      <div class="cw-row">
        <span class="cw-key">{{ t('composer.to') }}</span>
        <input v-model="form.to" type="text" :placeholder="t('composer.to')" class="cw-input" />
        <button v-if="!ccVisible" type="button" class="cw-cc" @click="showCcManually = true">
          {{ t('composer.ccToggle') }}
        </button>
      </div>
      <template v-if="ccVisible">
        <div class="cw-row">
          <span class="cw-key">{{ t('composer.cc') }}</span>
          <input v-model="form.cc" type="text" :placeholder="t('composer.cc')" class="cw-input" />
        </div>
        <div class="cw-row">
          <span class="cw-key">{{ t('composer.bcc') }}</span>
          <input v-model="form.bcc" type="text" :placeholder="t('composer.bcc')" class="cw-input" />
        </div>
      </template>
      <div class="cw-row">
        <input
          v-model="form.subject"
          type="text"
          :placeholder="t('composer.subject')"
          class="cw-input cw-subject"
        />
      </div>
    </div>

    <div class="cw-body">
      <EditorContent :editor="editor" class="cw-editor" />
      <div v-if="attachments.length" class="cw-atts">
        <div v-for="att in attachments" :key="att.blobId" class="cw-chip">
          <AppIcon name="file" :size="15" class="cw-chip-i" />
          <span class="cw-chip-n">{{ att.filename }}</span>
          <span class="cw-chip-s">{{ formatSize(att.size) }}</span>
          <button
            type="button"
            class="cw-chip-x"
            :aria-label="t('composer.remove', { name: att.filename })"
            @click="removeAttachment(att.blobId)"
          >
            <AppIcon name="x" :size="13" />
          </button>
        </div>
      </div>
      <p v-if="error" class="cw-error">{{ error }}</p>
    </div>

    <div class="cw-foot">
      <button class="cw-send" :disabled="sending || uploading" @click="send">
        <AppIcon name="send" :size="18" />{{ sending ? t('composer.sending') : t('composer.send') }}
      </button>
      <div v-if="editor" class="cw-tools">
        <button
          class="cw-tool"
          :class="{ on: editor.isActive('bold') }"
          :title="t('editor.bold')"
          @click="editor.chain().focus().toggleBold().run()"
        >
          <b>B</b>
        </button>
        <button
          class="cw-tool ital"
          :class="{ on: editor.isActive('italic') }"
          :title="t('editor.italic')"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          I
        </button>
        <button
          class="cw-tool"
          :class="{ on: editor.isActive('bulletList') }"
          :title="t('editor.bulletList')"
          @click="editor.chain().focus().toggleBulletList().run()"
        >
          <AppIcon name="list" :size="17" />
        </button>
        <button
          class="cw-tool"
          :class="{ on: editor.isActive('link') }"
          :title="t('editor.link')"
          @click="setLink"
        >
          <AppIcon name="link" :size="17" />
        </button>
        <label
          class="cw-tool"
          :class="{ disabled: uploading || sending }"
          :title="t('composer.attach')"
        >
          <AppIcon name="paperclip" :size="17" />
          <input
            ref="fileInput"
            type="file"
            multiple
            class="cw-file"
            :disabled="uploading || sending"
            @change="onFileSelect"
          />
        </label>
      </div>
      <span class="cw-status">{{ savedStatus }}</span>
      <button class="cw-tool" :title="t('composer.discard')" @click="composer.close()">
        <AppIcon name="trash" :size="17" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.cw {
  position: fixed;
  bottom: 0;
  right: 24px;
  width: 560px;
  max-width: calc(100vw - 48px);
  height: 600px;
  max-height: calc(100vh - 80px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  z-index: 60;
}
.cw-min {
  position: fixed;
  bottom: 0;
  right: 24px;
  width: 300px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  background: var(--composer-head);
  color: #fff;
  border-radius: 12px 12px 0 0;
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  z-index: 60;
}
.cw-min-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cw-head {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  background: var(--composer-head);
  color: #fff;
  border-radius: 12px 12px 0 0;
}
.cw-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
}
.cw-head-btn {
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  opacity: 0.9;
  padding: 4px;
}
.cw-head-btn:hover {
  opacity: 1;
}
.cw-fields {
  padding: 0 16px;
  flex-shrink: 0;
}
.cw-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  border-bottom: 1px solid var(--border);
}
.cw-key {
  font-size: 13px;
  color: var(--text-3);
  width: 40px;
  flex-shrink: 0;
}
.cw-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 14px;
  color: var(--text-1);
  height: 100%;
}
.cw-subject {
  font-weight: 600;
}
.cw-hidden-select {
  display: none;
}
.cw-cc {
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.cw-cc:hover {
  color: var(--accent);
}
.cw-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  min-height: 0;
}
.cw-editor :deep(.ProseMirror) {
  outline: none;
  min-height: 180px;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--text-1);
}
.cw-editor :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  color: var(--text-3);
  float: left;
  height: 0;
  pointer-events: none;
}
.cw-atts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.cw-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-dim);
  font-size: 13px;
}
.cw-chip-i {
  color: var(--accent);
}
.cw-chip-n {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cw-chip-s {
  color: var(--text-3);
}
.cw-chip-x {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-3);
  display: flex;
  padding: 0;
}
.cw-chip-x:hover {
  color: var(--danger);
}
.cw-error {
  font-size: 13px;
  color: var(--danger);
  margin: 10px 0 0;
}
.cw-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.cw-send {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 22px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.cw-send:hover:not(:disabled) {
  background: var(--accent-700);
}
.cw-send:disabled {
  opacity: 0.55;
  cursor: default;
}
.cw-tools {
  display: flex;
  gap: 2px;
  margin-left: 6px;
}
.cw-tool {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  font-size: 15px;
}
.cw-tool.ital {
  font-style: italic;
}
.cw-tool:hover {
  background: var(--hover);
}
.cw-tool.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.cw-tool.disabled {
  opacity: 0.5;
  pointer-events: none;
}
.cw-file {
  display: none;
}
.cw-status {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}
</style>
