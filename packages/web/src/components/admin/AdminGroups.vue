<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/lib/http';
import AppIcon from '@/components/AppIcon.vue';
import { vFocusTrap } from '@/lib/focusTrap';
import type { Group } from '@webmail6/shared';

/** Panel admin de Grupos (F7): CRUD + gestión de miembros. /api/admin/groups. */
const { t } = useI18n();

interface AccountLite {
  userId: string;
  displayName: string;
  email: string;
}

const groups = ref<Group[]>([]);
const accounts = ref<AccountLite[]>([]);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const g = await api.get<{ groups: Group[] }>('/admin/groups');
    groups.value = g.data.groups;
    // La lista de cuentas (para nombres de miembros y el selector) es BEST-EFFORT: requiere
    // `accounts.manage`, que un delegado con sólo `groups.manage` NO tiene (RBAC F8). Si falla (403),
    // los grupos igual se muestran; los miembros caen a sus iniciales/ID. No rompe la sección.
    try {
      const a = await api.get<{ accounts: AccountLite[] }>('/admin/accounts');
      const seen = new Set<string>();
      accounts.value = a.data.accounts.filter((acc) =>
        seen.has(acc.userId) ? false : (seen.add(acc.userId), true)
      );
    } catch {
      accounts.value = [];
    }
  } catch {
    error.value = t('admin.groups.errLoad');
  } finally {
    loading.value = false;
  }
}

const nameById = computed(() => {
  const m = new Map<string, string>();
  for (const a of accounts.value) m.set(a.userId, a.displayName || a.email);
  return m;
});

// ── Modal ──
const showModal = ref(false);
const editingId = ref<string | null>(null);
const originalMembers = ref<string[]>([]);
const form = ref<{
  name: string;
  description: string;
  color: string;
  email: string;
  members: string[];
}>({ name: '', description: '', color: '#1b66ff', email: '', members: [] });
const formError = ref('');
const saving = ref(false);

function openCreate() {
  editingId.value = null;
  originalMembers.value = [];
  form.value = { name: '', description: '', color: '#1b66ff', email: '', members: [] };
  formError.value = '';
  showModal.value = true;
}
function openEdit(g: Group) {
  editingId.value = g.id;
  originalMembers.value = [...g.memberUserIds];
  form.value = {
    name: g.name,
    description: g.description ?? '',
    color: g.color ?? '#1b66ff',
    email: g.email ?? '',
    members: [...g.memberUserIds],
  };
  formError.value = '';
  showModal.value = true;
}
function toggleMember(userId: string) {
  const i = form.value.members.indexOf(userId);
  if (i >= 0) form.value.members.splice(i, 1);
  else form.value.members.push(userId);
}

async function save() {
  formError.value = '';
  if (!form.value.name.trim()) {
    formError.value = t('admin.groups.errName');
    return;
  }
  saving.value = true;
  const meta = {
    // Se envía SIEMPRE (incl. '') para poder LIMPIAR la descripción al editar (review B-LOW).
    name: form.value.name.trim(),
    description: form.value.description.trim(),
    color: form.value.color,
    email: form.value.email.trim(),
  };
  try {
    if (editingId.value) {
      // metadata + diff de miembros (add/remove → $addToSet/$pull en el backend)
      await api.patch(`/admin/groups/${editingId.value}`, meta);
      const add = form.value.members.filter((m) => !originalMembers.value.includes(m));
      const remove = originalMembers.value.filter((m) => !form.value.members.includes(m));
      if (add.length || remove.length) {
        await api.patch(`/admin/groups/${editingId.value}/members`, { add, remove });
      }
    } else {
      await api.post('/admin/groups', { ...meta, memberUserIds: form.value.members });
    }
    showModal.value = false;
    await load();
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    formError.value = status === 409 ? t('admin.groups.errDup') : t('admin.groups.errSave');
  } finally {
    saving.value = false;
  }
}

async function remove(g: Group) {
  if (!confirm(t('admin.groups.confirmDelete', { name: g.name }))) return;
  try {
    await api.delete(`/admin/groups/${g.id}`);
    await load();
  } catch {
    error.value = t('admin.groups.errSave');
  }
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join('') || '?'
  );
}

onMounted(load);
</script>

<template>
  <div class="groups">
    <div class="groups__head">
      <button class="btn" data-testid="admin-new-group" @click="openCreate">
        <AppIcon name="plus" :size="16" /> {{ t('admin.groups.new') }}
      </button>
    </div>

    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="error" class="err">{{ error }}</p>
    <div v-else-if="groups.length === 0" class="empty">
      <AppIcon name="users" :size="32" />
      <p>{{ t('admin.groups.empty') }}</p>
    </div>
    <div v-else class="grid">
      <article v-for="g in groups" :key="g.id" class="gcard">
        <div
          class="gcard__ico"
          :style="{
            background: (g.color || 'var(--accent)') + '22',
            color: g.color || 'var(--accent)',
          }"
        >
          <AppIcon name="users" :size="20" />
        </div>
        <div class="gcard__body">
          <strong class="gcard__name">{{ g.name }}</strong>
          <span v-if="g.email" class="gcard__email">{{ g.email }}</span>
          <span v-if="g.description" class="gcard__desc">{{ g.description }}</span>
          <div class="gcard__members">
            <span
              v-for="uid in g.memberUserIds.slice(0, 5)"
              :key="uid"
              class="avatar-sm"
              :title="nameById.get(uid)"
              >{{ initials(nameById.get(uid) ?? '?') }}</span
            >
            <span class="gcard__count">{{
              t('admin.groups.memberCount', { n: g.memberCount })
            }}</span>
          </div>
        </div>
        <div class="gcard__actions">
          <button class="icon-act" :title="t('admin.groups.edit')" @click="openEdit(g)">
            <AppIcon name="pencil" :size="15" />
          </button>
          <button class="icon-act danger" :title="t('admin.groups.delete')" @click="remove(g)">
            <AppIcon name="trash" :size="15" />
          </button>
        </div>
      </article>
    </div>

    <!-- Modal crear/editar -->
    <div
      v-if="showModal"
      class="modal"
      @keydown.esc="showModal = false"
      @click.self="showModal = false"
    >
      <div v-focus-trap tabindex="-1" class="modal__box" role="dialog" aria-modal="true">
        <h3 class="modal__h">{{ editingId ? t('admin.groups.edit') : t('admin.groups.new') }}</h3>
        <div class="fgrid">
          <label class="f f--wide"
            ><span>{{ t('admin.groups.name') }}</span
            ><input v-model="form.name" maxlength="120"
          /></label>
          <label class="f"
            ><span>{{ t('admin.groups.color') }}</span
            ><input v-model="form.color" type="color" class="f__color"
          /></label>
          <label class="f"
            ><span>{{ t('admin.groups.email') }}</span
            ><input v-model="form.email" type="email" placeholder="(opcional)"
          /></label>
          <label class="f f--wide"
            ><span>{{ t('admin.groups.description') }}</span
            ><input v-model="form.description" maxlength="500"
          /></label>
        </div>

        <div class="members">
          <div class="members__h">
            {{ t('admin.groups.members') }} ·
            {{ t('admin.groups.memberCount', { n: form.members.length }) }}
          </div>
          <div class="members__list">
            <label v-for="a in accounts" :key="a.userId" class="member-row">
              <input
                type="checkbox"
                :checked="form.members.includes(a.userId)"
                @change="toggleMember(a.userId)"
              />
              <span class="member-name">{{ a.displayName || a.email }}</span>
              <span class="member-email">{{ a.email }}</span>
            </label>
            <p v-if="accounts.length === 0" class="muted">{{ t('admin.accounts.empty') }}</p>
          </div>
        </div>

        <p v-if="formError" class="err">{{ formError }}</p>
        <div class="modal__actions">
          <button class="btn btn--ghost" :disabled="saving" @click="showModal = false">
            {{ t('admin.groups.cancel') }}
          </button>
          <span class="spacer" />
          <button class="btn" :disabled="saving" @click="save">
            {{ saving ? t('admin.saving') : t('admin.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.muted {
  color: var(--text-3);
}
.err {
  color: var(--danger);
  font-size: 13.5px;
}
.groups__head {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 14px;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 16px;
  color: var(--text-3);
  text-align: center;
}
.empty :deep(svg) {
  opacity: 0.5;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.gcard {
  display: flex;
  gap: 14px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
}
.gcard__ico {
  width: 44px;
  height: 44px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.gcard__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gcard__name {
  font-size: 15px;
  font-weight: 700;
}
.gcard__email {
  font-size: 12.5px;
  color: var(--text-2);
}
.gcard__desc {
  font-size: 12.5px;
  color: var(--text-3);
}
.gcard__members {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.avatar-sm {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: -6px;
  border: 2px solid var(--surface);
}
.avatar-sm:first-child {
  margin-left: 0;
}
.gcard__count {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 8px;
}
.gcard__actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.icon-act {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-act:hover {
  background: var(--hover);
  color: var(--text-1);
}
.icon-act.danger:hover {
  color: var(--danger);
  border-color: var(--danger);
}
/* botones */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 9px;
  padding: 9px 16px;
  cursor: pointer;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.55;
}
.btn--ghost {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text-1);
}
/* modal */
.modal {
  position: fixed;
  inset: 0;
  background: rgba(15, 20, 30, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 80;
  padding: 16px;
}
.modal__box {
  width: 520px;
  max-width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--surface);
  border-radius: 16px;
  border-top: 4px solid var(--accent);
  padding: 22px;
  box-shadow: var(--shadow-lg);
}
.modal__h {
  font-size: 17px;
  font-weight: 700;
  margin: 0 0 14px;
}
.fgrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  min-width: 0;
}
.f--wide {
  grid-column: 1 / -1;
}
.f input {
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font: inherit;
  font-weight: 400;
  background: var(--surface);
  color: var(--text-1);
}
.f__color {
  height: 38px;
  padding: 3px;
}
.members {
  margin-top: 16px;
}
.members__h {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 8px;
}
.members__list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 13.5px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.member-row:last-child {
  border-bottom: none;
}
.member-row:hover {
  background: var(--hover);
}
.member-row input {
  accent-color: var(--accent);
}
.member-name {
  font-weight: 600;
  color: var(--text-1);
}
.member-email {
  color: var(--text-3);
  font-size: 12.5px;
  margin-left: auto;
}
.modal__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}
.spacer {
  flex: 1;
}
@media (max-width: 560px) {
  .fgrid {
    grid-template-columns: 1fr;
  }
}
</style>
