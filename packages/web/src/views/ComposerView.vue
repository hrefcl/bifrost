<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import AppLayout from '@/layouts/AppLayout.vue';
import { api } from '@/lib/http';
import { useDraftStore, type ReplyContext } from '@/stores/drafts';
import type { Account, Draft, Email, EmailBody } from '@webmail6/shared';

const router = useRouter();
const route = useRoute();
const draftStore = useDraftStore();

const draftId = ref<string | null>(route.params.draftId ? String(route.params.draftId) : null);
const accounts = ref<Account[]>([]);
const error = ref('');
const sending = ref(false);
const saving = ref(false);

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
    form.value.to = orig.from.address;
    if (mode === 'replyAll') {
      // Reply-all: CC = (To + CC del original) menos uno mismo y menos el remitente (ya en To),
      // deduplicado. Evita auto-CCarte y duplicar destinatarios.
      const self = accounts.value.find((a) => a.id === orig.accountId)?.email.toLowerCase();
      const fromAddr = orig.from.address.toLowerCase();
      const extras = [...orig.to, ...(orig.cc ?? [])]
        .map((a) => a.address)
        .filter((addr) => {
          const low = addr.toLowerCase();
          return low !== self && low !== fromAddr;
        });
      form.value.cc = [...new Set(extras)].join(', ');
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
    } else {
      // Composer nuevo: si viene de Reply/Forward, precargar desde el email original.
      const replyTo = route.query.replyTo ? String(route.query.replyTo) : null;
      const replyAll = route.query.replyAll ? String(route.query.replyAll) : null;
      const forward = route.query.forward ? String(route.query.forward) : null;
      if (replyTo) await prefillFromOriginal(replyTo, 'reply');
      else if (replyAll) await prefillFromOriginal(replyAll, 'replyAll');
      else if (forward) await prefillFromOriginal(forward, 'forward');
    }
  } catch {
    error.value = 'Failed to load composer';
  }
});

async function saveDraft() {
  saving.value = true;
  error.value = '';
  try {
    if (draftId.value) {
      await draftStore.updateDraft(draftId.value, form.value);
    } else {
      const created = await draftStore.createDraft(form.value, replyContext.value ?? undefined);
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
  if (!draftId.value) {
    await saveDraft();
  }
  if (!draftId.value) return;
  sending.value = true;
  error.value = '';
  try {
    await draftStore.updateDraft(draftId.value, form.value);
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
            class="rounded-lg border px-4 py-2 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
            :disabled="saving"
            @click="saveDraft"
          >
            {{ saving ? 'Saving...' : 'Save draft' }}
          </button>
          <button
            class="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="sending"
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
        <textarea
          v-model="form.bodyHtml"
          rows="12"
          placeholder="Write your message..."
          class="input resize-none"
        />
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.input {
  @apply w-full rounded-lg border border-gray-300 bg-white px-4 py-2 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800;
}
</style>
