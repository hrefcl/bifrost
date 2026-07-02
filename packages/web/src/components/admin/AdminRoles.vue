<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/lib/http';
import AppIcon from '@/components/AppIcon.vue';
import { vFocusTrap } from '@/lib/focusTrap';

/**
 * Panel admin de Roles y permisos (F8 RBAC): CRUD de roles custom + asignación de permisos del
 * catálogo estático. /api/admin/roles y /api/admin/permissions. Emite `changed` para que la vista
 * padre refresque su lista de roles (usada en la ficha de usuario para asignar).
 */
const { t } = useI18n();
const emit = defineEmits<{ changed: [] }>();

interface Permission {
  key: string;
  category: string;
  label: string;
}
interface Role {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

const roles = ref<Role[]>([]);
const permissions = ref<Permission[]>([]);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [r, p] = await Promise.all([
      api.get<{ roles: Role[] }>('/admin/roles'),
      api.get<{ permissions: Permission[] }>('/admin/permissions'),
    ]);
    roles.value = r.data.roles;
    permissions.value = p.data.permissions;
  } catch {
    error.value = t('admin.roles.errLoad');
  } finally {
    loading.value = false;
  }
}

// Permisos agrupados por categoría (para el modal).
const permsByCategory = computed(() => {
  const m = new Map<string, Permission[]>();
  for (const p of permissions.value) {
    const list = m.get(p.category) ?? [];
    list.push(p);
    m.set(p.category, list);
  }
  return [...m.entries()];
});
function labelOf(key: string): string {
  return permissions.value.find((p) => p.key === key)?.label ?? key;
}

// ── Modal crear/editar ──
const showModal = ref(false);
const editingId = ref<string | null>(null);
const form = ref<{ name: string; description: string; permissions: string[] }>({
  name: '',
  description: '',
  permissions: [],
});
const formError = ref('');
const saving = ref(false);

function openCreate() {
  editingId.value = null;
  form.value = { name: '', description: '', permissions: [] };
  formError.value = '';
  showModal.value = true;
}
function openEdit(r: Role) {
  editingId.value = r.id;
  form.value = { name: r.name, description: r.description ?? '', permissions: [...r.permissions] };
  formError.value = '';
  showModal.value = true;
}
function togglePerm(key: string) {
  const i = form.value.permissions.indexOf(key);
  if (i >= 0) form.value.permissions.splice(i, 1);
  else form.value.permissions.push(key);
}

async function save() {
  formError.value = '';
  if (!form.value.name.trim()) {
    formError.value = t('admin.roles.errName');
    return;
  }
  saving.value = true;
  const body = {
    name: form.value.name.trim(),
    description: form.value.description.trim(),
    permissions: form.value.permissions,
  };
  try {
    if (editingId.value) await api.patch(`/admin/roles/${editingId.value}`, body);
    else await api.post('/admin/roles', body);
    showModal.value = false;
    await load();
    emit('changed');
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 409) formError.value = t('admin.roles.errDup');
    else if (status === 403) formError.value = t('admin.roles.errGrant');
    else formError.value = t('admin.roles.errSave');
  } finally {
    saving.value = false;
  }
}

async function remove(r: Role) {
  if (!confirm(t('admin.roles.confirmDelete', { name: r.name }))) return;
  try {
    await api.delete(`/admin/roles/${r.id}`);
    await load();
    emit('changed');
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    error.value = status === 403 ? t('admin.roles.errSystem') : t('admin.roles.errSave');
  }
}

onMounted(load);
</script>

<template>
  <div class="roles">
    <div class="roles__head">
      <button class="btn" data-testid="admin-new-role" @click="openCreate">
        <AppIcon name="plus" :size="16" /> {{ t('admin.roles.new') }}
      </button>
    </div>

    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="error" class="err">{{ error }}</p>
    <div v-else-if="roles.length === 0" class="empty">
      <AppIcon name="shield" :size="32" />
      <p>{{ t('admin.roles.empty') }}</p>
    </div>
    <div v-else class="grid">
      <article v-for="r in roles" :key="r.id" class="rcard">
        <div class="rcard__ico"><AppIcon name="shield" :size="20" /></div>
        <div class="rcard__body">
          <div class="rcard__title">
            <strong class="rcard__name">{{ r.name }}</strong>
            <span v-if="r.isSystem" class="sys-badge">{{ t('admin.roles.system') }}</span>
          </div>
          <span v-if="r.description" class="rcard__desc">{{ r.description }}</span>
          <div class="rcard__perms">
            <span v-for="k in r.permissions" :key="k" class="perm-chip">{{ labelOf(k) }}</span>
            <span v-if="r.permissions.length === 0" class="perm-none">{{
              t('admin.roles.noPerms')
            }}</span>
          </div>
        </div>
        <div class="rcard__actions">
          <button class="icon-act" :title="t('admin.roles.edit')" @click="openEdit(r)">
            <AppIcon name="pencil" :size="15" />
          </button>
          <button
            v-if="!r.isSystem"
            class="icon-act danger"
            :title="t('admin.roles.delete')"
            @click="remove(r)"
          >
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
        <h3 class="modal__h">{{ editingId ? t('admin.roles.edit') : t('admin.roles.new') }}</h3>
        <div class="fgrid">
          <label class="f f--wide"
            ><span>{{ t('admin.roles.name') }}</span
            ><input v-model="form.name" maxlength="80"
          /></label>
          <label class="f f--wide"
            ><span>{{ t('admin.roles.description') }}</span
            ><input v-model="form.description" maxlength="300"
          /></label>
        </div>

        <div class="perms">
          <div class="perms__h">{{ t('admin.roles.permissions') }}</div>
          <div v-for="[cat, list] in permsByCategory" :key="cat" class="perms__cat">
            <div class="perms__catname">{{ cat }}</div>
            <label v-for="p in list" :key="p.key" class="perm-row">
              <input
                type="checkbox"
                :checked="form.permissions.includes(p.key)"
                @change="togglePerm(p.key)"
              />
              <span>{{ p.label }}</span>
            </label>
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
.roles__head {
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
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.rcard {
  display: flex;
  gap: 14px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
}
.rcard__ico {
  width: 44px;
  height: 44px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.rcard__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rcard__title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rcard__name {
  font-size: 15px;
  font-weight: 700;
}
.sys-badge {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
  background: var(--surface-dim);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 6px;
}
.rcard__desc {
  font-size: 12.5px;
  color: var(--text-3);
}
.rcard__perms {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}
.perm-chip {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--accent-soft);
  border-radius: 6px;
  padding: 2px 7px;
}
.perm-none {
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
}
.rcard__actions {
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
  grid-template-columns: 1fr;
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
.f input {
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font: inherit;
  font-weight: 400;
  background: var(--surface);
  color: var(--text-1);
}
.perms {
  margin-top: 16px;
}
.perms__h {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 8px;
}
.perms__cat {
  margin-bottom: 10px;
}
.perms__catname {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
  margin: 6px 0 4px;
}
.perm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  font-size: 13.5px;
  cursor: pointer;
  color: var(--text-1);
}
.perm-row:hover {
  background: var(--hover);
  border-radius: 6px;
}
.perm-row input {
  accent-color: var(--accent);
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
</style>
