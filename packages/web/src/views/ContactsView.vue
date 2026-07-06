<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import AppAvatar from '@/components/AppAvatar.vue';
import { useContactStore, type ContactInput } from '@/stores/contacts';
import type { Contact } from '@webmail6/shared';

const store = useContactStore();
const { t } = useI18n();

// Etiquetas sugeridas para emails/teléfonos (agenda estilo Google/iPhone).
const LABELS = computed(() => [
  t('contacts.labelWork'),
  t('contacts.labelHome'),
  t('contacts.labelOther'),
]);

// ── Editor (crear o editar) ─────────────────────────────────────────────
const showEditor = ref(false);
const editingId = ref<string | null>(null); // null = crear
const saving = ref(false);
const editorError = ref('');
interface EmailRow {
  label: string;
  address: string;
}
interface PhoneRow {
  label: string;
  number: string;
}
const form = ref({
  fullName: '',
  emails: [] as EmailRow[],
  phones: [] as PhoneRow[],
  organization: '',
  jobTitle: '',
  notes: '',
});

function blankForm() {
  return {
    fullName: '',
    emails: [{ label: t('contacts.labelWork'), address: '' }],
    phones: [] as PhoneRow[],
    organization: '',
    jobTitle: '',
    notes: '',
  };
}

function openNew() {
  editingId.value = null;
  editorError.value = '';
  form.value = blankForm();
  showEditor.value = true;
}

function openEdit(c: Contact) {
  editingId.value = c.id;
  editorError.value = '';
  // Si el contacto no tiene emails[] (legado), sembramos con el email primario.
  const emails =
    c.emails && c.emails.length > 0
      ? c.emails.map((e) => ({ ...e }))
      : [{ label: t('contacts.labelWork'), address: c.email }];
  form.value = {
    fullName: c.fullName,
    emails,
    phones: (c.phones ?? []).map((p) => ({ ...p })),
    organization: c.organization ?? '',
    jobTitle: c.jobTitle ?? '',
    notes: c.notes ?? '',
  };
  showEditor.value = true;
}

function addEmail() {
  form.value.emails.push({ label: t('contacts.labelOther'), address: '' });
}
function removeEmail(i: number) {
  form.value.emails.splice(i, 1);
}
function addPhone() {
  form.value.phones.push({ label: t('contacts.labelWork'), number: '' });
}
function removePhone(i: number) {
  form.value.phones.splice(i, 1);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function save() {
  editorError.value = '';
  const emails = form.value.emails
    .map((e) => ({
      label: e.label.trim() || t('contacts.labelOther'),
      address: e.address.trim().toLowerCase(),
    }))
    .filter((e) => e.address);
  const badEmail = emails.find((e) => !EMAIL_RE.test(e.address));
  if (!form.value.fullName.trim()) {
    editorError.value = t('contacts.errName');
    return;
  }
  if (emails.length === 0) {
    editorError.value = t('contacts.errEmail');
    return;
  }
  if (badEmail) {
    editorError.value = t('contacts.errEmailFormat', { email: badEmail.address });
    return;
  }
  const phones = form.value.phones
    .map((p) => ({ label: p.label.trim() || t('contacts.labelOther'), number: p.number.trim() }))
    .filter((p) => p.number);

  const payload: ContactInput = {
    fullName: form.value.fullName.trim(),
    email: emails[0].address, // primario = primer email
    emails,
    phones,
    organization: form.value.organization.trim() || undefined,
    jobTitle: form.value.jobTitle.trim() || undefined,
    notes: form.value.notes.trim() || undefined,
  };
  saving.value = true;
  try {
    if (editingId.value) await store.updateContact(editingId.value, payload);
    else await store.createContact(payload);
    showEditor.value = false;
  } catch {
    editorError.value = t('contacts.errSave');
  } finally {
    saving.value = false;
  }
}

async function remove(c: Contact) {
  if (!confirm(t('contacts.confirmDelete', { name: c.fullName }))) return;
  await store.deleteContact(c.id);
  if (editingId.value === c.id) showEditor.value = false;
}

// ── Importar (.vcf / .csv) ──────────────────────────────────────────────
const importing = ref(false);
const importMsg = ref('');
function pickImport() {
  fileInput.value?.click();
}
const fileInput = ref<HTMLInputElement | null>(null);
async function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = ''; // permite re-elegir el mismo archivo
  if (!file) return;
  importing.value = true;
  importMsg.value = '';
  try {
    const content = await file.text();
    const r = await store.importContacts(content);
    importMsg.value = t('contacts.importResult', {
      imported: r.imported,
      total: r.total,
      skipped: r.skipped,
    });
  } catch {
    importMsg.value = t('contacts.importError');
  } finally {
    importing.value = false;
  }
}

onMounted(() => {
  void store.fetchContacts();
});
</script>

<template>
  <AppLayout>
    <div class="page">
      <div class="page-inner">
        <div class="head">
          <h1 class="page-title">{{ t('contacts.title') }}</h1>
          <div class="head-actions">
            <button class="ghost-btn" :disabled="importing" @click="pickImport">
              <AppIcon name="database" :size="16" />
              {{ importing ? t('contacts.importing') : t('contacts.import') }}
            </button>
            <input
              ref="fileInput"
              type="file"
              accept=".vcf,.csv,text/vcard,text/csv,text/plain"
              hidden
              @change="onImportFile"
            />
            <button class="primary-btn" @click="openNew">
              <AppIcon name="plus" :size="18" />{{ t('contacts.new') }}
            </button>
          </div>
        </div>

        <p v-if="importMsg" class="import-msg">{{ importMsg }}</p>

        <div v-if="store.contacts.length === 0" class="empty">
          <AppIcon name="users" :size="44" :stroke-width="1.3" />
          <div>{{ t('contacts.empty') }}</div>
          <button class="ghost-btn" @click="pickImport">{{ t('contacts.importCta') }}</button>
        </div>
        <div v-else class="list">
          <button
            v-for="contact in store.contacts"
            :key="contact.id"
            class="contact"
            @click="openEdit(contact)"
          >
            <AppAvatar :name="contact.fullName" :email="contact.email" :size="42" />
            <div class="contact-text">
              <div class="contact-name">{{ contact.fullName }}</div>
              <div class="contact-sub">
                {{ contact.email
                }}<template v-if="contact.organization"> · {{ contact.organization }}</template>
              </div>
            </div>
            <span class="contact-actions">
              <span
                class="icon-btn danger"
                :title="t('contacts.delete')"
                @click.stop="remove(contact)"
              >
                <AppIcon name="trash" :size="18" />
              </span>
              <AppIcon name="chevronRight" :size="18" class="chev" />
            </span>
          </button>
        </div>
      </div>

      <!-- Editor (crear/editar) -->
      <div v-if="showEditor" class="modal-backdrop" @click.self="showEditor = false">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>{{ editingId ? t('contacts.editTitle') : t('contacts.newTitle') }}</h2>
            <button class="icon-btn" :title="t('contacts.cancel')" @click="showEditor = false">
              <AppIcon name="x" :size="18" />
            </button>
          </div>

          <div class="modal-body">
            <label class="fld"
              ><span>{{ t('contacts.fullName') }}</span
              ><input
                v-model="form.fullName"
                class="field"
                maxlength="200"
                :placeholder="t('contacts.fullName')"
            /></label>

            <!-- Emails (varios, etiquetados) -->
            <div class="fld">
              <span>{{ t('contacts.emails') }}</span>
              <div v-for="(em, i) in form.emails" :key="'e' + i" class="multi-row">
                <select v-model="em.label" class="field label-sel">
                  <option v-for="l in LABELS" :key="l" :value="l">{{ l }}</option>
                </select>
                <input
                  v-model="em.address"
                  type="email"
                  class="field"
                  :placeholder="t('contacts.email')"
                />
                <button class="icon-btn" :title="t('contacts.removeRow')" @click="removeEmail(i)">
                  <AppIcon name="x" :size="16" />
                </button>
              </div>
              <button class="add-row" @click="addEmail">
                <AppIcon name="plus" :size="14" />{{ t('contacts.addEmail') }}
              </button>
            </div>

            <!-- Teléfonos -->
            <div class="fld">
              <span>{{ t('contacts.phones') }}</span>
              <div v-for="(ph, i) in form.phones" :key="'p' + i" class="multi-row">
                <select v-model="ph.label" class="field label-sel">
                  <option v-for="l in LABELS" :key="l" :value="l">{{ l }}</option>
                </select>
                <input v-model="ph.number" class="field" :placeholder="t('contacts.phone')" />
                <button class="icon-btn" :title="t('contacts.removeRow')" @click="removePhone(i)">
                  <AppIcon name="x" :size="16" />
                </button>
              </div>
              <button class="add-row" @click="addPhone">
                <AppIcon name="plus" :size="14" />{{ t('contacts.addPhone') }}
              </button>
            </div>

            <div class="grid2">
              <label class="fld"
                ><span>{{ t('contacts.organization') }}</span
                ><input
                  v-model="form.organization"
                  class="field"
                  maxlength="200"
                  :placeholder="t('contacts.organization')"
              /></label>
              <label class="fld"
                ><span>{{ t('contacts.jobTitle') }}</span
                ><input v-model="form.jobTitle" class="field" maxlength="200"
              /></label>
            </div>

            <label class="fld"
              ><span>{{ t('contacts.notes') }}</span
              ><textarea v-model="form.notes" class="field" rows="3" maxlength="4000" />
            </label>

            <p v-if="editorError" class="err-text">{{ editorError }}</p>
          </div>

          <div class="modal-foot">
            <button
              v-if="editingId"
              class="ghost-btn danger"
              @click="remove(store.contacts.find((c) => c.id === editingId)!)"
            >
              {{ t('contacts.delete') }}
            </button>
            <span class="spacer" />
            <button class="ghost-btn" @click="showEditor = false">
              {{ t('contacts.cancel') }}
            </button>
            <button class="primary-btn" :disabled="saving" @click="save">
              {{ saving ? t('contacts.saving') : t('contacts.save') }}
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
  gap: 12px;
}
.head-actions {
  display: flex;
  gap: 10px;
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
.primary-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
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
.ghost-btn.danger {
  color: var(--danger);
  border-color: transparent;
}
.import-msg {
  margin: -8px 0 16px;
  font-size: 13px;
  color: var(--text-2);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  padding: 10px 14px;
  border-radius: 8px;
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
.list {
  display: flex;
  flex-direction: column;
}
.contact {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 8px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.contact:hover {
  background: var(--hover);
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
.contact-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.chev {
  color: var(--text-3);
}
.icon-btn {
  width: 34px;
  height: 34px;
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

/* Editor modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 60;
}
.modal {
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-radius: 14px;
  border: 1px solid var(--border);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.modal-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.modal-body {
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fld > span {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.multi-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.label-sel {
  width: 120px;
  flex-shrink: 0;
}
.add-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 4px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  background: transparent;
  border: none;
  cursor: pointer;
  align-self: flex-start;
}
.modal-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}
.spacer {
  flex: 1;
}
.err-text {
  color: var(--danger);
  font-size: 13px;
  margin: 0;
}
</style>
