<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';
import { api } from '@/lib/http';
import { useDraftStore, type ReplyContext } from '@/stores/drafts';
import { useAuthStore } from '@/stores/auth';
import type { Account, Draft, DraftAttachment, Email, EmailBody } from '@webmail6/shared';

const router = useRouter();
const route = useRoute();
const draftStore = useDraftStore();
const auth = useAuthStore();
const { t } = useI18n();

const draftId = ref<string | null>(route.params.draftId ? String(route.params.draftId) : null);
const accounts = ref<Account[]>([]);
const error = ref('');
const sending = ref(false);
const saving = ref(false);

// Adjuntos ya subidos (cada uno tiene blobId). El input file sube a /api/attachments y empuja
// el resultado acá; al guardar/enviar mandamos los blobId como attachmentIds.
const attachments = ref<DraftAttachment[]>([]);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const MAX_ATTACHMENTS = 25;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // coherente con el cap del backend (413)

// Contexto de threading cuando se compone como respuesta (no en forward ni en nuevo).
const replyContext = ref<ReplyContext | null>(null);

const form = ref({
  accountId: '',
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  bodyHtml: '',
});

// Cc/Cco se ocultan hasta que el usuario los pide, PERO si traen contenido (p.ej. reply-all
// precarga el Cc) se muestran solos: si no, el campo quedaría invisible con datos dentro.
const showCcManually = ref(false);
const ccVisible = computed(
  () => showCcManually.value || form.value.cc.length > 0 || form.value.bcc.length > 0
);

/** Estado del composer que mandamos al store, con los blobId de los adjuntos actuales. */
function composerState() {
  return { ...form.value, attachmentIds: attachments.value.map((a) => a.blobId) };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length === 0) return;
  error.value = '';
  uploading.value = true;
  // Un fallo en un archivo NO aborta el resto de la cola: lo registramos y seguimos.
  const failed: string[] = [];
  try {
    for (const file of files) {
      if (attachments.value.length >= MAX_ATTACHMENTS) {
        error.value = t('composer.errMax', { n: MAX_ATTACHMENTS });
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        failed.push(file.name); // el backend lo rechazaría con 413; lo cortamos antes
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
    if (failed.length > 0) {
      error.value = t('composer.errAttach', { names: failed.join(', ') });
    }
  } finally {
    uploading.value = false;
    // Permite re-seleccionar el mismo archivo (el change no dispara si el value no cambia).
    if (fileInput.value) fileInput.value.value = '';
  }
}

function removeAttachment(blobId: string) {
  attachments.value = attachments.value.filter((a) => a.blobId !== blobId);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Cita el email original (el backend re-sanitiza el bodyHtml al guardar el draft). */
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

/** Precarga el composer para responder/responder-a-todos/reenviar el email original. */
async function prefillFromOriginal(
  originalId: string,
  mode: 'reply' | 'replyAll' | 'forward'
): Promise<void> {
  const [{ data: orig }, { data: origBody }] = await Promise.all([
    api.get<Email>(`/emails/${originalId}`),
    api.get<EmailBody>(`/emails/${originalId}/body`),
  ]);
  // Responder/reenviar DESDE la cuenta que recibió el original (no la primera por defecto):
  // en multi-cuenta, enviar desde la cuenta equivocada filtra el From y rompe el threading.
  form.value.accountId = orig.accountId;
  const subject = orig.subject;
  if (mode === 'reply' || mode === 'replyAll') {
    const self = accounts.value.find((a) => a.id === orig.accountId)?.email.toLowerCase();
    const fromAddr = orig.from.address.toLowerCase();
    // Si respondés tu PROPIO correo enviado (from = vos), el "To" va a los destinatarios
    // originales, no a vos mismo. Si no, va al remitente.
    if (self && fromAddr === self) {
      const origTo = orig.to.map((a) => a.address).filter((a) => a.toLowerCase() !== self);
      form.value.to = (origTo.length > 0 ? origTo : [orig.from.address]).join(', ');
    } else {
      // Header Reply-To (RFC 5322): si el original lo trae, las respuestas van ahí (listas de
      // correo, remitentes no-reply con un reply-to real), no al From.
      form.value.to = orig.replyTo?.address ?? orig.from.address;
    }
    if (mode === 'replyAll') {
      // CC = (To + CC originales) menos uno mismo, menos el remitente, menos quien ya está en
      // To, dedup CASE-INSENSITIVE (Bob@x y bob@x son el mismo destinatario).
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
    if (data.length > 0 && !form.value.accountId) {
      form.value.accountId = data[0].id;
    }
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
      // Composer nuevo: si viene de Reply/Forward, precargar desde el email original.
      const replyTo = route.query.replyTo ? String(route.query.replyTo) : null;
      const replyAll = route.query.replyAll ? String(route.query.replyAll) : null;
      const forward = route.query.forward ? String(route.query.forward) : null;
      if (replyTo) await prefillFromOriginal(replyTo, 'reply');
      else if (replyAll) await prefillFromOriginal(replyAll, 'replyAll');
      else if (forward) await prefillFromOriginal(forward, 'forward');

      // Firma: si está activada, se antepone (queda sobre la cita en reply/forward, estilo
      // Gmail). Con un párrafo vacío arriba para escribir. El backend la sirve ya saneada.
      const prefs = auth.user?.preferences;
      if (prefs?.autoIncludeSignature && prefs.defaultSignature) {
        form.value.bodyHtml = `<p></p>${prefs.defaultSignature}${form.value.bodyHtml}`;
      }
    }
  } catch {
    error.value = t('composer.errLoad');
  }
});

async function saveDraft() {
  // No guardar mientras hay un upload en curso: el blob aún no está en `attachments` y se
  // perdería del payload (B HIGH). El :disabled cubre el click; este guard cubre llamadas
  // programáticas (p.ej. send() llama saveDraft()).
  if (uploading.value) {
    error.value = t('composer.errUploadWait');
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    if (draftId.value) {
      await draftStore.updateDraft(draftId.value, composerState());
    } else {
      const created = await draftStore.createDraft(
        composerState(),
        replyContext.value ?? undefined
      );
      draftId.value = created.id;
      void router.replace({ name: 'compose', params: { draftId: created.id } });
    }
  } catch {
    error.value = t('composer.errSave');
  } finally {
    saving.value = false;
  }
}

async function send() {
  // Mismo guard que saveDraft: enviar con un upload pendiente mandaría el correo sin ese
  // adjunto. Cortamos antes de tocar el draft.
  if (uploading.value) {
    error.value = t('composer.errUploadWait');
    return;
  }
  if (!draftId.value) {
    await saveDraft();
  }
  if (!draftId.value) return;
  sending.value = true;
  error.value = '';
  try {
    await draftStore.updateDraft(draftId.value, composerState());
    await draftStore.sendDraft(draftId.value);
    void router.push({ name: 'inbox' });
  } catch {
    error.value = t('composer.errSend');
  } finally {
    sending.value = false;
  }
}

function discard() {
  void router.push({ name: 'inbox' });
}
</script>

<template>
  <AppLayout>
    <div class="composer-wrap">
      <div class="composer">
        <div class="composer-head">
          <span class="composer-title">{{ t('composer.title') }}</span>
          <button class="head-btn" :title="t('composer.discard')" @click="discard">
            <AppIcon name="x" :size="18" />
          </button>
        </div>

        <div class="fields">
          <div class="field-row">
            <span class="field-key">{{ t('composer.from') }}</span>
            <select v-model="form.accountId" class="field-input select">
              <option v-for="account in accounts" :key="account.id" :value="account.id">
                {{ account.email }}
              </option>
            </select>
          </div>
          <div class="field-row">
            <span class="field-key">{{ t('composer.to') }}</span>
            <input
              v-model="form.to"
              type="text"
              :placeholder="t('composer.to')"
              class="field-input"
            />
            <button
              v-if="!ccVisible"
              type="button"
              class="cc-toggle"
              @click="showCcManually = true"
            >
              {{ t('composer.ccToggle') }}
            </button>
          </div>
          <template v-if="ccVisible">
            <div class="field-row">
              <span class="field-key">{{ t('composer.cc') }}</span>
              <input
                v-model="form.cc"
                type="text"
                :placeholder="t('composer.cc')"
                class="field-input"
              />
            </div>
            <div class="field-row">
              <span class="field-key">{{ t('composer.bcc') }}</span>
              <input
                v-model="form.bcc"
                type="text"
                :placeholder="t('composer.bcc')"
                class="field-input"
              />
            </div>
          </template>
          <div class="field-row">
            <input
              v-model="form.subject"
              type="text"
              :placeholder="t('composer.subject')"
              class="field-input subject"
            />
          </div>
        </div>

        <div class="composer-body">
          <RichTextEditor v-model="form.bodyHtml" />
        </div>

        <div v-if="error || attachments.length" class="composer-extras">
          <p v-if="error" class="composer-error">{{ error }}</p>
          <ul v-if="attachments.length" class="att-chips">
            <li v-for="att in attachments" :key="att.blobId" class="att-chip">
              <AppIcon name="file" :size="15" class="att-chip-icon" />
              <span class="att-chip-name">{{ att.filename }}</span>
              <span class="att-chip-size">{{ formatSize(att.size) }}</span>
              <button
                type="button"
                class="att-chip-x"
                :aria-label="t('composer.remove', { name: att.filename })"
                @click="removeAttachment(att.blobId)"
              >
                <AppIcon name="x" :size="13" />
              </button>
            </li>
          </ul>
        </div>

        <div class="composer-foot">
          <button class="send-btn" :disabled="sending || uploading" @click="send">
            <AppIcon name="send" :size="18" />
            {{ sending ? t('composer.sending') : t('composer.send') }}
          </button>
          <button class="save-btn" :disabled="saving || uploading" @click="saveDraft">
            {{ saving ? t('composer.saving') : t('composer.saveDraft') }}
          </button>
          <label class="attach-label" :class="{ disabled: uploading || saving || sending }">
            <AppIcon name="paperclip" :size="18" />
            <span class="attach-text">{{
              uploading ? t('composer.uploading') : t('composer.attach')
            }}</span>
            <input
              ref="fileInput"
              type="file"
              multiple
              class="hidden-file"
              :disabled="uploading || saving || sending"
              @change="onFileSelect"
            />
          </label>
          <button class="foot-icon" :title="t('composer.discard')" @click="discard">
            <AppIcon name="trash" :size="18" />
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.composer-wrap {
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 24px;
  background: var(--bg);
  overflow-y: auto;
}
.composer {
  width: 100%;
  max-width: 760px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 540px;
}
.composer-head {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: var(--composer-head);
  color: #fff;
}
.composer-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
}
.head-btn {
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  opacity: 0.85;
  padding: 4px;
}
.head-btn:hover {
  opacity: 1;
}
.fields {
  padding: 0 16px;
}
.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  border-bottom: 1px solid var(--border);
}
.field-key {
  font-size: 13.5px;
  color: var(--text-3);
  width: 44px;
  flex-shrink: 0;
}
.field-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 14px;
  color: var(--text-1);
  height: 100%;
}
.field-input.subject {
  font-weight: 600;
}
.field-input.select {
  cursor: pointer;
}
.cc-toggle {
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.cc-toggle:hover {
  color: var(--accent);
}
.composer-body {
  flex: 1;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  padding: 8px 16px;
  overflow-y: auto;
}
.composer-body :deep(.ProseMirror) {
  min-height: 200px;
  outline: none;
  font-size: 14.5px;
  line-height: 1.6;
}
.composer-extras {
  padding: 8px 16px;
  border-top: 1px solid var(--border);
}
.composer-error {
  font-size: 13px;
  color: var(--danger);
  margin: 0 0 8px;
}
.att-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.att-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-dim);
  font-size: 13px;
  max-width: 100%;
}
.att-chip-icon {
  color: var(--accent);
  flex-shrink: 0;
}
.att-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
.att-chip-size {
  color: var(--text-3);
  flex-shrink: 0;
}
.att-chip-x {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-3);
  display: flex;
  padding: 0;
  flex-shrink: 0;
}
.att-chip-x:hover {
  color: var(--danger);
}
.composer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.send-btn {
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
  transition: background 0.13s;
}
.send-btn:hover:not(:disabled) {
  background: var(--accent-700);
}
.save-btn {
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
.save-btn:hover:not(:disabled) {
  background: var(--hover);
}
.send-btn:disabled,
.save-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.attach-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  color: var(--text-2);
  cursor: pointer;
  font-size: 13.5px;
  font-weight: 500;
}
.attach-label:hover {
  background: var(--hover);
}
.attach-label.disabled {
  opacity: 0.5;
  pointer-events: none;
}
.hidden-file {
  display: none;
}
.foot-icon {
  margin-left: auto;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.foot-icon:hover {
  background: var(--hover);
  color: var(--danger);
}
</style>
