<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import AppLayout from '@/layouts/AppLayout.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';
import { api } from '@/lib/http';
import { useDraftStore, type ReplyContext } from '@/stores/drafts';
import { useAuthStore } from '@/stores/auth';
import type { Account, Draft, DraftAttachment, Email, EmailBody } from '@webmail6/shared';

const router = useRouter();
const route = useRoute();
const draftStore = useDraftStore();
const auth = useAuthStore();

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
        error.value = `Maximum ${String(MAX_ATTACHMENTS)} attachments`;
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
      error.value = `Failed to attach: ${failed.join(', ')}`;
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
    error.value = 'Failed to load composer';
  }
});

async function saveDraft() {
  // No guardar mientras hay un upload en curso: el blob aún no está en `attachments` y se
  // perdería del payload (B HIGH). El :disabled cubre el click; este guard cubre llamadas
  // programáticas (p.ej. send() llama saveDraft()).
  if (uploading.value) {
    error.value = 'Wait for attachments to finish uploading';
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
    error.value = 'Failed to save draft';
  } finally {
    saving.value = false;
  }
}

async function send() {
  // Mismo guard que saveDraft: enviar con un upload pendiente mandaría el correo sin ese
  // adjunto. Cortamos antes de tocar el draft.
  if (uploading.value) {
    error.value = 'Wait for attachments to finish uploading';
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
    error.value = 'Failed to send email';
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex h-full flex-col p-4">
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-bold">Compose</h1>
        <div class="flex gap-2">
          <button
            class="rounded-lg border px-4 py-2 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
            :disabled="saving || uploading"
            @click="saveDraft"
          >
            {{ saving ? 'Saving...' : 'Save draft' }}
          </button>
          <button
            class="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="sending || uploading"
            @click="send"
          >
            {{ sending ? 'Sending...' : 'Send' }}
          </button>
        </div>
      </div>

      <p v-if="error" class="mb-2 text-sm text-red-600">{{ error }}</p>

      <div class="space-y-3">
        <select v-model="form.accountId" class="input">
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.email }}
          </option>
        </select>
        <input v-model="form.to" type="text" placeholder="To" class="input" />
        <input v-model="form.cc" type="text" placeholder="Cc" class="input" />
        <input v-model="form.bcc" type="text" placeholder="Bcc" class="input" />
        <input v-model="form.subject" type="text" placeholder="Subject" class="input" />
        <RichTextEditor v-model="form.bodyHtml" />

        <div class="rounded-lg border border-gray-300 px-4 py-3 dark:border-gray-700">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">Attachments</span>
            <label
              class="cursor-pointer rounded-lg border px-3 py-1 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
              :class="{ 'pointer-events-none opacity-50': uploading }"
            >
              {{ uploading ? 'Uploading...' : 'Attach files' }}
              <input
                ref="fileInput"
                type="file"
                multiple
                class="hidden"
                :disabled="uploading"
                @change="onFileSelect"
              />
            </label>
          </div>
          <ul v-if="attachments.length" class="mt-2 space-y-1">
            <li
              v-for="att in attachments"
              :key="att.blobId"
              class="flex items-center justify-between rounded bg-gray-50 px-3 py-1 text-sm dark:bg-gray-800"
            >
              <span class="truncate">{{ att.filename }}</span>
              <span class="ml-2 flex shrink-0 items-center gap-2 text-gray-500">
                <span>{{ formatSize(att.size) }}</span>
                <button
                  type="button"
                  class="text-red-600 hover:text-red-700"
                  :aria-label="`Remove ${att.filename}`"
                  @click="removeAttachment(att.blobId)"
                >
                  ✕
                </button>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.input {
  @apply w-full rounded-lg border border-gray-300 bg-white px-4 py-2 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800;
}
</style>
