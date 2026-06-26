<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '@/layouts/AppLayout.vue';
import { api } from '@/lib/http';
import type { Folder, Email, Account, EmailBody, EmailAttachmentMeta } from '@webmail6/shared';

type AttachmentMeta = EmailAttachmentMeta;

const router = useRouter();
const accounts = ref<Account[]>([]);
const folders = ref<Folder[]>([]);
const emails = ref<Email[]>([]);
const selectedFolderId = ref<string | null>(null);
const loading = ref(false);
const error = ref('');

// Detalle del email seleccionado.
const selected = ref<Email | null>(null);
const body = ref<EmailBody | null>(null);
const attachments = ref<AttachmentMeta[]>([]);
const bodyLoading = ref(false);

function accountId(): string {
  return accounts.value[0]?.id ?? '';
}

async function loadAccountsAndFolders() {
  try {
    const { data } = await api.get<Account[]>('/accounts');
    accounts.value = data;
    if (data.length > 0) await loadFolders(data[0].id);
  } catch {
    error.value = 'Failed to load accounts';
  }
}

async function loadFolders(id: string) {
  try {
    const { data } = await api.get<Folder[]>(`/accounts/${id}/folders`);
    folders.value = data;
    if (data.length > 0 && !selectedFolderId.value) await selectFolder(data[0].id);
  } catch {
    error.value = 'Failed to load folders';
  }
}

async function selectFolder(folderId: string) {
  selectedFolderId.value = folderId;
  selected.value = null;
  loading.value = true;
  try {
    const { data } = await api.get<{ data: Email[] }>(
      `/accounts/${accountId()}/folders/${folderId}/emails`
    );
    emails.value = data.data;
  } catch {
    error.value = 'Failed to load emails';
  } finally {
    loading.value = false;
  }
}

// Token para descartar respuestas viejas: si el usuario clickea A y luego B rápido,
// la respuesta (lenta) de A no debe sobreescribir el detalle de B.
let openToken = 0;
async function openEmail(email: Email) {
  const token = ++openToken;
  selected.value = email;
  body.value = null;
  attachments.value = [];
  bodyLoading.value = true;
  try {
    // Una sola llamada: /body ya incluye la metadata de adjuntos (evita un 2º
    // fetch+parse IMAP completo del mismo mensaje).
    const bodyRes = await api.get<EmailBody>(`/emails/${email.id}/body`);
    if (token !== openToken) return; // un click más nuevo lo reemplazó
    body.value = bodyRes.data;
    attachments.value = bodyRes.data.attachments ?? [];
    if (!email.flags.seen) {
      void api.patch(`/emails/${email.id}/flags`, { seen: true });
      email.flags.seen = true;
    }
  } catch {
    if (token === openToken) error.value = 'Failed to load email';
  } finally {
    if (token === openToken) bodyLoading.value = false;
  }
}

async function downloadAttachment(att: AttachmentMeta) {
  if (!selected.value) return;
  // Descarga AUTENTICADA: fetch con Bearer → blob → link temporal (un <a href> plano
  // no enviaría el token).
  const res = await api.get<Blob>(`/emails/${selected.value.id}/attachments/${att.id}`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = att.filename;
  document.body.appendChild(a);
  a.click();
  // Remover el <a> del DOM (evita leak) y revocar tras un tick (revocar inmediato
  // puede abortar la descarga en algunos browsers).
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

async function deleteEmail() {
  if (!selected.value) return;
  const id = selected.value.id;
  try {
    await api.delete(`/emails/${id}`);
    emails.value = emails.value.filter((e) => e.id !== id);
    selected.value = null;
  } catch {
    error.value = 'Failed to delete email';
  }
}

function reply() {
  if (!selected.value) return;
  void router.push({ name: 'compose-new', query: { replyTo: selected.value.id } });
}

function replyAll() {
  if (!selected.value) return;
  void router.push({ name: 'compose-new', query: { replyAll: selected.value.id } });
}

function forward() {
  if (!selected.value) return;
  void router.push({ name: 'compose-new', query: { forward: selected.value.id } });
}

onMounted(loadAccountsAndFolders);
</script>

<template>
  <AppLayout>
    <div class="flex h-full">
      <aside class="w-56 border-r p-3 dark:border-gray-700">
        <button
          class="mb-4 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          @click="router.push({ name: 'compose-new' })"
        >
          Compose
        </button>
        <h2 class="mb-2 px-2 text-sm font-semibold text-gray-500 uppercase">Folders</h2>
        <ul class="space-y-1">
          <li
            v-for="folder in folders"
            :key="folder.id"
            :class="[
              'cursor-pointer rounded-lg px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800',
              selectedFolderId === folder.id ? 'bg-blue-50 text-blue-700 dark:bg-gray-800' : '',
            ]"
            @click="selectFolder(folder.id)"
          >
            {{ folder.displayName }}
          </li>
        </ul>
      </aside>

      <!-- Lista de emails -->
      <section class="w-80 overflow-auto border-r p-2 dark:border-gray-700">
        <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
        <p v-if="loading" class="text-sm text-gray-500">Loading...</p>
        <div class="space-y-1">
          <div
            v-for="email in emails"
            :key="email.id"
            :class="[
              'cursor-pointer rounded-lg border p-2 dark:border-gray-700',
              selected?.id === email.id
                ? 'bg-blue-50 dark:bg-gray-800'
                : 'hover:bg-gray-50 dark:hover:bg-gray-800',
              email.flags.seen ? 'opacity-70' : 'font-semibold',
            ]"
            @click="openEmail(email)"
          >
            <div class="flex items-center justify-between">
              <span class="truncate text-sm">{{ email.from?.name || email.from?.address }}</span>
              <span class="ml-2 shrink-0 text-xs text-gray-500">{{
                new Date(email.date).toLocaleDateString()
              }}</span>
            </div>
            <div class="truncate text-sm text-gray-700 dark:text-gray-300">{{ email.subject }}</div>
            <div v-if="email.hasAttachments" class="text-xs text-gray-400">📎 attachment</div>
          </div>
        </div>
      </section>

      <!-- Detalle del email -->
      <section class="flex-1 overflow-auto p-4">
        <div v-if="!selected" class="mt-10 text-center text-gray-400">Select an email to read</div>
        <article v-else>
          <header class="mb-4 border-b pb-3 dark:border-gray-700">
            <div class="flex items-start justify-between gap-2">
              <h1 class="text-lg font-semibold">{{ selected.subject || '(no subject)' }}</h1>
              <div class="flex shrink-0 gap-1">
                <button
                  class="rounded px-2 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                  @click="reply"
                >
                  Reply
                </button>
                <button
                  v-if="(selected.to?.length ?? 0) + (selected.cc?.length ?? 0) > 1"
                  class="rounded px-2 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                  @click="replyAll"
                >
                  Reply all
                </button>
                <button
                  class="rounded px-2 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                  @click="forward"
                >
                  Forward
                </button>
                <button
                  class="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-gray-800"
                  @click="deleteEmail"
                >
                  Delete
                </button>
              </div>
            </div>
            <div class="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {{ selected.from?.name || selected.from?.address }} ·
              {{ new Date(selected.date).toLocaleString() }}
            </div>
          </header>

          <p v-if="bodyLoading" class="text-gray-500">Loading body...</p>
          <template v-else-if="body">
            <!-- sanitizedHtml viene saneado por el backend (sanitize-html); el disable es de
                 rango (no next-line) para sobrevivir al reformateo multilínea de prettier. -->
            <!-- eslint-disable vue/no-v-html -->
            <div
              v-if="body.sanitizedHtml"
              class="prose max-w-none dark:prose-invert"
              v-html="body.sanitizedHtml"
            ></div>
            <!-- eslint-enable vue/no-v-html -->
            <pre v-else class="whitespace-pre-wrap font-sans text-sm">{{ body.text }}</pre>
          </template>

          <div v-if="attachments.length > 0" class="mt-4 border-t pt-3 dark:border-gray-700">
            <h3 class="mb-2 text-sm font-semibold text-gray-500">Attachments</h3>
            <ul class="space-y-1">
              <li v-for="att in attachments" :key="att.id">
                <button
                  class="text-sm text-blue-600 hover:underline"
                  @click="downloadAttachment(att)"
                >
                  📎 {{ att.filename }} ({{ Math.round(att.size / 1024) }} KB)
                </button>
              </li>
            </ul>
          </div>
        </article>
      </section>
    </div>
  </AppLayout>
</template>
