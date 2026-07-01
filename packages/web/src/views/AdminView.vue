<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { AxiosError } from 'axios';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon, { type IconName } from '@/components/AppIcon.vue';
import { vFocusTrap } from '@/lib/focusTrap';
import ComplianceAdmin from '@/components/admin/ComplianceAdmin.vue';
import AdminSchedulingPanel from '@/components/admin/AdminSchedulingPanel.vue';
import AdminCalendarPrefs from '@/components/admin/AdminCalendarPrefs.vue';
import { api } from '@/lib/http';
import { brand, applyBrand } from '@/config/brand';
import { BUILD_INFO } from '@/lib/buildInfo';

/**
 * Panel de administración (Roundcube administrable) con cuatro secciones:
 *  - Cuentas: alta/edición/baja de cuentas y cuota de almacenamiento.
 *  - Marca: branding white-label en runtime (nombre, eslogan, color, logo de empresa).
 *  - Almacenamiento: destino de los adjuntos (local / S3) — wizard preexistente.
 *  - Compliance: gestión de documentos legales, versiones, enforcement y auditoría de aceptaciones.
 * Todo exige rol admin (verificado también en el backend).
 */
type Tab = 'accounts' | 'branding' | 'storage' | 'compliance' | 'scheduling' | 'preferences';
const tab = ref<Tab>('accounts');

const { t, locale } = useI18n();

// ── Shell de navegación (sidebar tipo Google Workspace Admin) ──
// Las secciones son las MISMAS de antes (mismos `tab`); sólo cambia la presentación: de tabs
// superiores a items de un sidebar. Cada item declara su icono y las claves i18n de su cabecera.
interface AdminSection {
  key: Tab;
  icon: IconName;
  label: string; // i18n key (nav)
  title: string; // i18n key (cabecera)
  desc: string; // i18n key (cabecera)
}
const SECTIONS: AdminSection[] = [
  {
    key: 'accounts',
    icon: 'users',
    label: 'admin.tabs.accounts',
    title: 'admin.accounts.title',
    desc: 'admin.accounts.desc',
  },
  {
    key: 'branding',
    icon: 'palette',
    label: 'admin.tabs.branding',
    title: 'admin.branding.title',
    desc: 'admin.branding.desc',
  },
  {
    key: 'storage',
    icon: 'database',
    label: 'admin.tabs.storage',
    title: 'admin.question',
    desc: 'admin.questionDesc',
  },
  {
    key: 'compliance',
    icon: 'shield',
    label: 'admin.tabs.compliance',
    title: 'admin.compliance.title',
    desc: 'admin.compliance.desc',
  },
  {
    key: 'scheduling',
    icon: 'calendar',
    label: 'admin.tabs.scheduling',
    title: 'admin.scheduling.title',
    desc: 'admin.scheduling.desc',
  },
  {
    key: 'preferences',
    icon: 'sliders',
    label: 'admin.tabs.preferences',
    title: 'admin.preferences.title',
    desc: 'admin.preferences.desc',
  },
];
const activeSection = computed(() => SECTIONS.find((s) => s.key === tab.value) ?? SECTIONS[0]);

// Drawer del sidebar en viewports angostos (<900px). En desktop el sidebar es sticky permanente.
const navOpen = ref(false);
// `isNarrow`: en móvil el sidebar es drawer (focus-trap + inert al cerrar). En desktop NUNCA es inert
// ni atrapa foco (es navegación permanente). matchMedia evita asumir el viewport (review B/D a11y).
const isNarrow = ref(false);
let mq: MediaQueryList | null = null;
function onMq(e: MediaQueryListEvent | MediaQueryList) {
  isNarrow.value = e.matches;
  if (!e.matches) navOpen.value = false; // al pasar a desktop, el drawer no aplica
}
function selectSection(key: Tab) {
  tab.value = key;
  navOpen.value = false; // al elegir sección se cierra el drawer (móvil)
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && navOpen.value) navOpen.value = false;
}

/** Fecha legible y localizada (en vez del ISO crudo). */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Bytes → unidad legible (para cuotas y uso). */
function fmtBytes(n: number): string {
  if (n <= 0) return '0 MB';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb).toString()} MB`;
}

// ============================ CUENTAS ============================
interface AdminAccount {
  id: string;
  userId: string;
  email: string;
  name: string;
  displayName: string;
  role: 'user' | 'admin';
  isPrimary: boolean;
  status: 'active' | 'syncing' | 'error' | 'disabled';
  quotaBytes: number;
  usedBytes: number;
  lastSyncedAt: string | null;
}

const accounts = ref<AdminAccount[]>([]);
const accLoading = ref(true);
const accError = ref('');

async function loadAccounts() {
  accLoading.value = true;
  accError.value = '';
  try {
    const { data } = await api.get<{ accounts: AdminAccount[] }>('/admin/accounts');
    accounts.value = data.accounts;
  } catch {
    accError.value = t('admin.accounts.errLoad');
  } finally {
    accLoading.value = false;
  }
}

// --- Alta de cuenta ---
const showCreate = ref(false);
const creating = ref(false);
const createError = ref('');
const blankCreate = () => ({
  email: '',
  password: '',
  displayName: '',
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  quotaMb: 0,
});
const form = ref(blankCreate());

const createIncomplete = computed(
  () =>
    !form.value.email.trim() ||
    !form.value.password ||
    !form.value.imapHost.trim() ||
    !form.value.smtpHost.trim()
);

async function createAccount() {
  creating.value = true;
  createError.value = '';
  try {
    await api.post('/admin/accounts', {
      email: form.value.email.trim(),
      password: form.value.password,
      ...(form.value.displayName.trim() ? { displayName: form.value.displayName.trim() } : {}),
      imapHost: form.value.imapHost.trim(),
      imapPort: form.value.imapPort,
      imapSecure: form.value.imapSecure,
      smtpHost: form.value.smtpHost.trim(),
      smtpPort: form.value.smtpPort,
      smtpSecure: form.value.smtpSecure,
      quotaBytes: Math.max(0, Math.round(form.value.quotaMb)) * 1024 * 1024,
    });
    showCreate.value = false;
    form.value = blankCreate();
    await loadAccounts();
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 409) {
      createError.value = t('admin.accounts.errExists');
    } else if (err instanceof AxiosError && err.response?.status === 403) {
      createError.value = t('admin.accounts.errImap');
    } else {
      createError.value = t('admin.accounts.errCreate');
    }
  } finally {
    creating.value = false;
  }
}

// --- Edición de cuota / nombre ---
const editingId = ref<string | null>(null);
const editQuotaMb = ref(0);
const editName = ref('');
const rowBusy = ref<string | null>(null);

function startEdit(a: AdminAccount) {
  editingId.value = a.id;
  editQuotaMb.value = Math.round(a.quotaBytes / (1024 * 1024));
  editName.value = a.displayName;
}
function cancelEdit() {
  editingId.value = null;
}
async function saveEdit(a: AdminAccount) {
  rowBusy.value = a.id;
  try {
    await api.patch(`/admin/accounts/${a.id}`, {
      quotaBytes: Math.max(0, Math.round(editQuotaMb.value)) * 1024 * 1024,
      ...(editName.value.trim() ? { displayName: editName.value.trim() } : {}),
    });
    editingId.value = null;
    await loadAccounts();
  } catch {
    accError.value = t('admin.accounts.errSave');
  } finally {
    rowBusy.value = null;
  }
}

async function toggleStatus(a: AdminAccount) {
  rowBusy.value = a.id;
  accError.value = '';
  try {
    await api.patch(`/admin/accounts/${a.id}`, {
      status: a.status === 'disabled' ? 'active' : 'disabled',
    });
    await loadAccounts();
  } catch (err) {
    accError.value =
      err instanceof AxiosError && err.response?.status === 400
        ? t('admin.accounts.errSelf')
        : t('admin.accounts.errSave');
  } finally {
    rowBusy.value = null;
  }
}

async function removeAccount(a: AdminAccount) {
  if (!confirm(t('admin.accounts.confirmDelete', { email: a.email }))) return;
  rowBusy.value = a.id;
  accError.value = '';
  try {
    await api.delete(`/admin/accounts/${a.id}`);
    await loadAccounts();
  } catch (err) {
    accError.value =
      err instanceof AxiosError && err.response?.status === 400
        ? t('admin.accounts.errSelf')
        : t('admin.accounts.errDelete');
  } finally {
    rowBusy.value = null;
  }
}

// ============================ MARCA (branding) ============================
const brandForm = ref({ companyName: '', tagline: '', accentColor: '#1b66ff', logoDataUrl: '' });
const brandLoading = ref(true);
const brandSaving = ref(false);
const brandSaved = ref(false);
const brandError = ref('');

async function loadBranding() {
  brandLoading.value = true;
  try {
    const { data } = await api.get<{
      companyName: string | null;
      tagline: string | null;
      accentColor: string | null;
      logoDataUrl: string | null;
    }>('/admin/config/branding');
    brandForm.value.companyName = data.companyName ?? '';
    brandForm.value.tagline = data.tagline ?? '';
    brandForm.value.accentColor = data.accentColor ?? brand.accent;
    brandForm.value.logoDataUrl = data.logoDataUrl ?? '';
  } catch {
    brandError.value = t('admin.branding.errLoad');
  } finally {
    brandLoading.value = false;
  }
}

const LOGO_MAX = 256 * 1024;
function onLogoPick(e: Event) {
  brandError.value = '';
  brandSaved.value = false;
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    brandError.value = t('admin.branding.errType');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    // readAsDataURL siempre da string; el guard satisface el tipo (string | ArrayBuffer | null).
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl) return;
    // ~33% de overhead base64; chequeo rápido contra el cap del backend (256KB).
    if (dataUrl.length * 0.75 > LOGO_MAX) {
      brandError.value = t('admin.branding.errSize');
      return;
    }
    brandForm.value.logoDataUrl = dataUrl;
  };
  reader.readAsDataURL(file);
}
function clearLogo() {
  brandForm.value.logoDataUrl = '';
  brandSaved.value = false;
}

async function saveBranding() {
  brandSaving.value = true;
  brandSaved.value = false;
  brandError.value = '';
  try {
    const payload = {
      companyName: brandForm.value.companyName.trim(),
      tagline: brandForm.value.tagline.trim(),
      accentColor: brandForm.value.accentColor,
      logoDataUrl: brandForm.value.logoDataUrl, // '' limpia el logo
    };
    await api.put('/admin/config/branding', payload);
    // Aplicar en vivo (sin recargar): la marca es reactiva y la consume toda la UI.
    brand.name = payload.companyName || 'Bifrost';
    brand.tagline = payload.tagline || brand.tagline;
    brand.accent = payload.accentColor;
    brand.logoUrl = payload.logoDataUrl || null;
    applyBrand();
    brandSaved.value = true;
  } catch (err) {
    brandError.value =
      err instanceof AxiosError && err.response?.status === 400
        ? t('admin.branding.errInvalid')
        : t('admin.branding.errSave');
  } finally {
    brandSaving.value = false;
  }
}

// ============================ ALMACENAMIENTO (wizard preexistente) ============================
type ProviderType = 'local' | 's3';
interface PublicS3 {
  endpoint?: string | null;
  bucket: string;
  region: string;
  // Con useInstanceRole=true la respuesta NO trae accessKeyId (el rol de EC2 provee las creds).
  accessKeyId?: string;
  useInstanceRole?: boolean;
  secretConfigured: boolean;
}
interface StorageConfig {
  providerType: ProviderType;
  s3?: PublicS3;
  updatedBy?: string;
  updatedAt?: string;
}

const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');
const selected = ref<ProviderType>('local');
const current = ref<StorageConfig | null>(null);
const s3 = ref({
  endpoint: '',
  bucket: '',
  region: '',
  accessKeyId: '',
  secretAccessKey: '',
  // true = la instancia usa el rol de EC2 (sin claves estáticas) → lo fija el aprovisionamiento, NO la UI.
  useInstanceRole: false,
});
const secretAlreadyConfigured = ref(false);

async function loadStorage() {
  try {
    const { data } = await api.get<StorageConfig>('/admin/config/storage');
    current.value = data;
    selected.value = data.providerType;
    if (data.s3) {
      // GUARDS (?? ''): con useInstanceRole=true la config NO trae accessKeyId → sin esto, un `.trim()`
      // posterior crasheaba toda la sección Almacenamiento (afectaba a TODO box turnkey, que usa S3+rol EC2).
      s3.value.endpoint = data.s3.endpoint ?? '';
      s3.value.bucket = data.s3.bucket;
      s3.value.region = data.s3.region;
      // accessKeyId puede faltar (useInstanceRole) → guard imprescindible: era la causa del crash `.trim()`.
      s3.value.accessKeyId = data.s3.accessKeyId ?? '';
      s3.value.useInstanceRole = data.s3.useInstanceRole ?? false;
      secretAlreadyConfigured.value = data.s3.secretConfigured;
    }
  } catch {
    error.value = t('admin.errLoad');
  } finally {
    loading.value = false;
  }
}

// Versión del SERVIDOR (imagen api desplegada). El front muestra su propio build (baked en el bundle)
// + el del backend → si uno no avanzó tras un deploy, salta a la vista (mismatch = una capa quedó
// cacheada/sin actualizar). Se lee de /admin/version (admin-only; NO de /health público, que no debe
// filtrar build/sha → anti fingerprinting). Falla suave: si no responde, queda '—'.
const apiBuild = ref<string | null>(null);
async function loadApiBuild() {
  try {
    const { data } = await api.get<{ build?: string; sha?: string }>('/admin/version');
    apiBuild.value = `build ${data.build ?? '—'} · ${data.sha ?? ''}`;
  } catch {
    apiBuild.value = null;
  }
}

// Chequeo de actualización (estilo WordPress). Sólo lectura: muestra si hay un build más nuevo
// publicado en GitHub. Aplicar la actualización (botón) es la Fase 2 (sidecar updater).
interface UpdateStatus {
  current: { version: string; build: string; sha: string };
  latest: { build: number; sha: string; date: string } | null;
  updateAvailable: boolean;
  behind: number | null;
  checkError: boolean;
  compareUrl: string | null;
  repoUrl: string;
}
const update = ref<UpdateStatus | null>(null);
const checkingUpdate = ref(false);
async function loadUpdate(force = false) {
  checkingUpdate.value = true;
  try {
    const { data } = await api.get<UpdateStatus>('/admin/update/check', {
      params: force ? { force: 1 } : {},
    });
    update.value = data;
  } catch {
    update.value = null;
  } finally {
    checkingUpdate.value = false;
  }
}

// Fase 2: aplicar la actualización. El API deja un marker; el host-updater hace pull+up+rollback. Acá
// disparamos el apply y POLLEAMOS el estado hasta que termine (succeeded/rolledback/failed), mostrando
// el progreso. El servidor elige el build target (no el cliente).
const updating = ref(false);
const updateMsg = ref('');
async function applyUpdate() {
  if (updating.value) return;
  if (!confirm('¿Actualizar a la última versión? El sistema puede reiniciarse unos segundos.'))
    return;
  updating.value = true;
  updateMsg.value = 'Encolando actualización…';
  // El POST de encolado SÍ debe confirmar (si falla, el update ni arrancó).
  try {
    await api.post('/admin/update/apply');
  } catch {
    updateMsg.value = '✗ No se pudo iniciar la actualización.';
    updating.value = false;
    return;
  }
  // Poll del estado. CLAVE: durante el update se RECREAN los contenedores web+api → /admin/update/status
  // va a fallar varios segundos. Un error de red NO es fallo del update (el estado real vive en disco y
  // sobrevive el reinicio del API). Por eso cada GET va en su propio try/catch y los errores se toleran:
  // antes, el catch global mataba el poll justo cuando el update terminaba OK → "dijo actualizado y no pasó".
  // Ventana amplia: hasta ~6 min (cron hasta 60s + pull + recreate + rearmado).
  updateMsg.value = 'Aplicando la actualización…';
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    let status = '';
    try {
      const { data } = await api.get<{ status: string; to?: string }>('/admin/update/status');
      status = data.status;
    } catch {
      // API reiniciándose (esperado durante el recreate) → seguir esperando, no abortar.
      updateMsg.value = 'Aplicando la actualización… (reiniciando servicios)';
      continue;
    }
    if (status === 'queued' || status === 'in_progress' || status === 'idle') {
      updateMsg.value = 'Aplicando la actualización…';
      continue;
    }
    if (status === 'succeeded') {
      updateMsg.value = '✅ Actualizado a la última versión. Recargando…';
      // El bundle web también cambió → recargar para verlo. Damos 2s para que se lea el mensaje.
      setTimeout(() => {
        window.location.reload();
      }, 2000);
      return;
    }
    if (status === 'rolledback') {
      updateMsg.value = '⚠ El build nuevo no levantó; se revirtió al anterior (sistema estable).';
      updating.value = false;
      return;
    }
    if (status === 'failed') {
      updateMsg.value = '✗ La actualización falló. Revisá los logs del servidor.';
      updating.value = false;
      return;
    }
  }
  updateMsg.value = 'La actualización está tardando; revisá en unos minutos.';
  updating.value = false;
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  mq = window.matchMedia('(max-width: 900px)');
  isNarrow.value = mq.matches;
  mq.addEventListener('change', onMq);
  await Promise.all([loadAccounts(), loadBranding(), loadStorage(), loadApiBuild(), loadUpdate()]);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  mq?.removeEventListener('change', onMq);
});

function choose(provider: ProviderType) {
  selected.value = provider;
  saved.value = false;
  error.value = '';
  tested.value = null;
  if (provider !== 's3') s3.value.secretAccessKey = '';
}
function clearStatus() {
  saved.value = false;
  error.value = '';
  tested.value = null;
}
function s3Incomplete(): boolean {
  if (selected.value !== 's3') return false;
  // S3 vía rol de instancia: lo gestiona el aprovisionamiento (no se edita por UI) → no exige claves.
  if (s3.value.useInstanceRole) return false;
  return (
    !s3.value.bucket.trim() ||
    !s3.value.region.trim() ||
    !s3.value.accessKeyId.trim() ||
    !s3.value.secretAccessKey
  );
}
function s3Payload() {
  return {
    ...(s3.value.endpoint.trim() ? { endpoint: s3.value.endpoint.trim() } : {}),
    bucket: s3.value.bucket.trim(),
    region: s3.value.region.trim(),
    accessKeyId: s3.value.accessKeyId.trim(),
    secretAccessKey: s3.value.secretAccessKey,
  };
}
const testing = ref(false);
const tested = ref<'ok' | 'fail' | null>(null);
async function testConnection() {
  testing.value = true;
  tested.value = null;
  error.value = '';
  try {
    await api.post('/admin/config/storage/test', s3Payload());
    tested.value = 'ok';
  } catch {
    tested.value = 'fail';
  } finally {
    testing.value = false;
  }
}
async function save() {
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    const payload =
      selected.value === 's3'
        ? { providerType: 's3' as const, s3: s3Payload() }
        : { providerType: 'local' as const };
    const { data } = await api.patch<StorageConfig>('/admin/config/storage', payload);
    current.value = data;
    selected.value = data.providerType;
    if (data.s3) secretAlreadyConfigured.value = data.s3.secretConfigured;
    s3.value.secretAccessKey = '';
    saved.value = true;
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 400) {
      error.value = t('admin.errInvalid');
    } else {
      error.value = t('admin.errSave');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppLayout>
    <div class="admin" :class="{ 'nav-open': navOpen }">
      <!-- Scrim del drawer (sólo móvil/tablet angosto) -->
      <div v-if="navOpen" class="admin-scrim" @click="navOpen = false" />

      <!-- Sidebar de secciones (tipo Google Workspace Admin). En móvil es drawer: atrapa foco al
           abrir y queda `inert` (fuera del tab order) al cerrar; en desktop nada de esto aplica. -->
      <nav
        v-focus-trap="isNarrow && navOpen"
        :inert="isNarrow && !navOpen"
        class="admin-nav"
        :aria-label="t('admin.title')"
        data-testid="admin-sidebar"
      >
        <div class="admin-brand">
          <AppIcon name="shield" :size="22" />
          <span>{{ t('admin.title') }}</span>
        </div>
        <ul class="admin-navlist">
          <li v-for="s in SECTIONS" :key="s.key">
            <button
              class="admin-navitem"
              :class="{ active: tab === s.key }"
              :aria-current="tab === s.key ? 'page' : undefined"
              :data-testid="`admin-section-${s.key}`"
              @click="selectSection(s.key)"
            >
              <AppIcon :name="s.icon" :size="18" />
              <span>{{ t(s.label) }}</span>
            </button>
          </li>
        </ul>
        <footer class="admin-nav-foot" data-testid="build-info">
          <div class="bi-line">
            <span class="bi-app">{{ brand.name }}</span>
            <span class="bi-ver">v{{ BUILD_INFO.version }}</span>
          </div>
          <div class="bi-line bi-dim">
            <span data-testid="build-web">web {{ BUILD_INFO.build }}</span>
            <span class="bi-sha">{{ BUILD_INFO.sha }}</span>
          </div>
          <div v-if="apiBuild" class="bi-line bi-dim">
            <span data-testid="build-api">api {{ apiBuild }}</span>
          </div>
        </footer>
      </nav>

      <!-- Área de contenido -->
      <main class="admin-main">
        <header class="admin-head">
          <button class="admin-burger" :aria-label="t('nav.menu')" @click="navOpen = true">
            <AppIcon name="menu" :size="20" />
          </button>
          <div class="admin-head-text">
            <h1 class="admin-section-title" data-testid="admin-section-title">
              {{ t(activeSection.title) }}
            </h1>
            <p class="admin-section-desc">{{ t(activeSection.desc) }}</p>
          </div>
          <button
            v-if="tab === 'accounts'"
            class="btn-primary admin-head-action"
            data-testid="admin-new-account"
            @click="showCreate = !showCreate"
          >
            {{ showCreate ? t('admin.accounts.cancelNew') : t('admin.accounts.new') }}
          </button>
        </header>

        <!-- Aviso de actualización (estilo WordPress) -->
        <div
          v-if="update?.updateAvailable"
          class="update-banner update-yes"
          data-testid="update-available"
        >
          <AppIcon name="download" :size="18" />
          <div class="ub-text">
            <strong>Hay una actualización disponible</strong>
            <span
              >Última: build {{ update.latest?.build }} · tenés build {{ update.current.build }}
              <template v-if="update.behind">({{ update.behind }} builds atrás)</template></span
            >
          </div>
          <a
            v-if="update.compareUrl"
            :href="update.compareUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="ub-link"
            >Ver cambios</a
          >
          <button class="ub-btn" :disabled="updating" @click="applyUpdate">
            {{ updating ? 'Actualizando…' : 'Actualizar' }}
          </button>
        </div>
        <p v-if="updateMsg" class="ub-msg" data-testid="update-msg">{{ updateMsg }}</p>
        <div
          v-else-if="update && !update.updateAvailable && update.latest"
          class="update-banner update-ok"
          data-testid="update-current"
        >
          <AppIcon name="check" :size="16" />
          <span>Estás en la última versión (build {{ update.current.build }})</span>
          <button class="ub-refresh" :disabled="checkingUpdate" @click="loadUpdate(true)">
            {{ checkingUpdate ? 'Buscando…' : 'Buscar ahora' }}
          </button>
        </div>
        <div
          v-else-if="update?.checkError"
          class="update-banner update-ok"
          data-testid="update-unknown"
        >
          <span
            >No se pudo verificar la última versión (build actual {{ update.current.build }})</span
          >
          <button class="ub-refresh" :disabled="checkingUpdate" @click="loadUpdate(true)">
            {{ checkingUpdate ? 'Buscando…' : 'Reintentar' }}
          </button>
        </div>

        <div class="admin-body">
          <!-- ===================== AGENDA ===================== -->
          <AdminSchedulingPanel v-if="tab === 'scheduling'" />

          <!-- ===================== PREFERENCIAS DE CALENDARIO ===================== -->
          <AdminCalendarPrefs v-else-if="tab === 'preferences'" />

          <!-- ===================== CUENTAS ===================== -->
          <div v-if="tab === 'accounts'" class="card">
            <!-- Form de alta -->
            <div v-if="showCreate" class="create-form" @input="createError = ''">
              <div class="grid2">
                <label class="fld"
                  ><span>{{ t('admin.accounts.email') }}</span
                  ><input v-model="form.email" class="adminput" placeholder="user@empresa.com"
                /></label>
                <label class="fld"
                  ><span>{{ t('admin.accounts.password') }}</span
                  ><input
                    v-model="form.password"
                    type="password"
                    class="adminput"
                    autocomplete="new-password"
                /></label>
                <label class="fld"
                  ><span>{{ t('admin.accounts.displayName') }}</span
                  ><input v-model="form.displayName" class="adminput"
                /></label>
                <label class="fld"
                  ><span>{{ t('admin.accounts.quotaMb') }}</span
                  ><input v-model.number="form.quotaMb" type="number" min="0" class="adminput"
                /></label>
                <label class="fld"
                  ><span>{{ t('admin.accounts.imapHost') }}</span
                  ><input v-model="form.imapHost" class="adminput" placeholder="imap.empresa.com"
                /></label>
                <div class="grid2 tight">
                  <label class="fld"
                    ><span>{{ t('admin.accounts.imapPort') }}</span
                    ><input v-model.number="form.imapPort" type="number" class="adminput"
                  /></label>
                  <label class="fld check2"
                    ><input v-model="form.imapSecure" type="checkbox" />
                    {{ t('admin.accounts.tls') }}
                  </label>
                </div>
                <label class="fld"
                  ><span>{{ t('admin.accounts.smtpHost') }}</span
                  ><input v-model="form.smtpHost" class="adminput" placeholder="smtp.empresa.com"
                /></label>
                <div class="grid2 tight">
                  <label class="fld"
                    ><span>{{ t('admin.accounts.smtpPort') }}</span
                    ><input v-model.number="form.smtpPort" type="number" class="adminput"
                  /></label>
                  <label class="fld check2"
                    ><input v-model="form.smtpSecure" type="checkbox" />
                    {{ t('admin.accounts.tls') }}
                  </label>
                </div>
              </div>
              <p class="hint">{{ t('admin.accounts.imapHint') }}</p>
              <div class="actions">
                <button
                  class="btn-primary"
                  :disabled="creating || createIncomplete"
                  @click="createAccount"
                >
                  {{ creating ? t('admin.accounts.creating') : t('admin.accounts.create') }}
                </button>
                <span v-if="createError" class="err-text">{{ createError }}</span>
              </div>
            </div>

            <p v-if="accLoading" class="muted">{{ t('common.loading') }}</p>
            <p v-else-if="accError" class="err-text">{{ accError }}</p>
            <table v-else class="acc-table">
              <thead>
                <tr>
                  <th>{{ t('admin.accounts.colEmail') }}</th>
                  <th>{{ t('admin.accounts.colStatus') }}</th>
                  <th>{{ t('admin.accounts.colQuota') }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="a in accounts" :key="a.id" :class="{ dim: a.status === 'disabled' }">
                  <td>
                    <template v-if="editingId === a.id">
                      <input v-model="editName" class="adminput sm" />
                    </template>
                    <template v-else>
                      <div class="acc-name">
                        {{ a.displayName }}
                        <span v-if="a.role === 'admin'" class="badge admin">admin</span>
                      </div>
                      <div class="acc-email">{{ a.email }}</div>
                    </template>
                  </td>
                  <td>
                    <span class="status" :class="a.status">{{
                      t('admin.accounts.st.' + a.status)
                    }}</span>
                  </td>
                  <td>
                    <template v-if="editingId === a.id">
                      <input
                        v-model.number="editQuotaMb"
                        type="number"
                        min="0"
                        class="adminput sm"
                      />
                      <span class="mb">MB</span>
                    </template>
                    <template v-else>
                      <span class="quota">{{ fmtBytes(a.usedBytes) }}</span>
                      <span class="quota-sep">/</span>
                      <span class="quota">{{
                        a.quotaBytes > 0 ? fmtBytes(a.quotaBytes) : t('admin.accounts.unlimited')
                      }}</span>
                    </template>
                  </td>
                  <td class="row-actions">
                    <template v-if="editingId === a.id">
                      <button class="link-btn" :disabled="rowBusy === a.id" @click="saveEdit(a)">
                        {{ t('admin.accounts.saveRow') }}
                      </button>
                      <button class="link-btn" @click="cancelEdit">
                        {{ t('admin.accounts.cancelRow') }}
                      </button>
                    </template>
                    <template v-else>
                      <button
                        class="icon-act"
                        :title="t('admin.accounts.edit')"
                        @click="startEdit(a)"
                      >
                        <AppIcon name="settings" :size="16" />
                      </button>
                      <button
                        class="icon-act"
                        :disabled="rowBusy === a.id"
                        :title="
                          a.status === 'disabled'
                            ? t('admin.accounts.enable')
                            : t('admin.accounts.disable')
                        "
                        @click="toggleStatus(a)"
                      >
                        <AppIcon :name="a.status === 'disabled' ? 'check' : 'x'" :size="16" />
                      </button>
                      <button
                        class="icon-act danger"
                        :disabled="rowBusy === a.id"
                        :title="t('admin.accounts.delete')"
                        @click="removeAccount(a)"
                      >
                        <AppIcon name="trash" :size="16" />
                      </button>
                    </template>
                  </td>
                </tr>
                <tr v-if="accounts.length === 0">
                  <td colspan="4" class="muted center">{{ t('admin.accounts.empty') }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- ===================== MARCA ===================== -->
          <div v-else-if="tab === 'branding'" class="card">
            <p v-if="brandLoading" class="muted">{{ t('common.loading') }}</p>
            <div v-else class="brand-form" @input="brandSaved = false">
              <label class="fld"
                ><span>{{ t('admin.branding.companyName') }}</span
                ><input
                  v-model="brandForm.companyName"
                  class="adminput"
                  maxlength="60"
                  placeholder="Bifrost"
              /></label>
              <label class="fld"
                ><span>{{ t('admin.branding.tagline') }}</span
                ><input v-model="brandForm.tagline" class="adminput" maxlength="80"
              /></label>
              <label class="fld"
                ><span>{{ t('admin.branding.accent') }}</span>
                <span class="color-row">
                  <input v-model="brandForm.accentColor" type="color" class="color-input" />
                  <input v-model="brandForm.accentColor" class="adminput" maxlength="7" />
                </span>
              </label>
              <label class="fld"
                ><span>{{ t('admin.branding.logo') }}</span>
                <div class="logo-row">
                  <div class="logo-preview" :class="{ empty: !brandForm.logoDataUrl }">
                    <img v-if="brandForm.logoDataUrl" :src="brandForm.logoDataUrl" alt="logo" />
                    <span v-else class="muted sm">{{ t('admin.branding.noLogo') }}</span>
                  </div>
                  <div class="logo-actions">
                    <label class="btn-secondary file-btn">
                      {{ t('admin.branding.pickLogo') }}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        hidden
                        @change="onLogoPick"
                      />
                    </label>
                    <button v-if="brandForm.logoDataUrl" class="link-btn" @click="clearLogo">
                      {{ t('admin.branding.removeLogo') }}
                    </button>
                    <p class="hint">{{ t('admin.branding.logoHint') }}</p>
                  </div>
                </div>
              </label>
              <div class="actions">
                <button class="btn-primary" :disabled="brandSaving" @click="saveBranding">
                  {{ brandSaving ? t('admin.saving') : t('admin.save') }}
                </button>
                <span v-if="brandSaved" class="ok-text">{{ t('admin.saved') }}</span>
                <span v-if="brandError" class="err-text">{{ brandError }}</span>
              </div>
            </div>
          </div>

          <!-- ===================== COMPLIANCE ===================== -->
          <div v-else-if="tab === 'compliance'" class="card card--flush">
            <ComplianceAdmin />
          </div>

          <!-- ===================== ALMACENAMIENTO ===================== -->
          <div v-else-if="tab === 'storage'" class="card">
            <p v-if="loading" class="muted">{{ t('common.loading') }}</p>

            <div v-else class="options">
              <label class="option" :class="{ active: selected === 'local' }">
                <input
                  type="radio"
                  name="provider"
                  value="local"
                  :checked="selected === 'local'"
                  @change="choose('local')"
                />
                <span class="option-body">
                  <span class="option-title">
                    {{ t('admin.localTitle') }}
                    <span class="badge ok">{{ t('admin.available') }}</span>
                  </span>
                  <span class="option-desc">{{ t('admin.localDesc') }}</span>
                </span>
              </label>

              <label class="option" :class="{ active: selected === 's3' }">
                <input
                  type="radio"
                  name="provider"
                  value="s3"
                  :checked="selected === 's3'"
                  @change="choose('s3')"
                />
                <span class="option-body">
                  <span class="option-title">
                    {{ t('admin.s3Title') }}
                    <span class="badge ok">{{ t('admin.available') }}</span>
                  </span>
                  <span class="option-desc">{{ t('admin.s3Desc') }}</span>
                </span>
              </label>

              <!-- S3 vía rol de instancia EC2 (lo fija el aprovisionamiento): sólo lectura, sin claves. -->
              <div v-if="selected === 's3' && s3.useInstanceRole" class="s3-instance-note">
                <p class="hint">{{ t('admin.s3InstanceRole') }}</p>
                <div class="s3-instance-info">
                  <div>
                    <span class="fld-lbl">{{ t('admin.bucket') }}</span>
                    <strong>{{ s3.bucket || '—' }}</strong>
                  </div>
                  <div>
                    <span class="fld-lbl">{{ t('admin.region') }}</span>
                    <strong>{{ s3.region || '—' }}</strong>
                  </div>
                </div>
              </div>

              <div v-else-if="selected === 's3'" class="s3-fields" @input="clearStatus">
                <label class="fld-lbl">{{ t('admin.endpoint') }}</label>
                <input
                  v-model="s3.endpoint"
                  class="adminput"
                  placeholder="https://s3.amazonaws.com · http://minio:9000"
                />
                <label class="fld-lbl">{{ t('admin.bucket') }}</label>
                <input v-model="s3.bucket" class="adminput" placeholder="mi-bucket" />
                <label class="fld-lbl">{{ t('admin.region') }}</label>
                <input v-model="s3.region" class="adminput" placeholder="us-east-1" />
                <label class="fld-lbl">{{ t('admin.accessKeyId') }}</label>
                <input v-model="s3.accessKeyId" class="adminput" placeholder="AKIA…" />
                <label class="fld-lbl">
                  {{ t('admin.secret') }}
                  <span v-if="secretAlreadyConfigured" class="fld-hint">{{
                    t('admin.secretConfigured')
                  }}</span>
                </label>
                <input
                  v-model="s3.secretAccessKey"
                  type="password"
                  class="adminput"
                  :placeholder="
                    secretAlreadyConfigured ? t('admin.secretPlaceholderSet') : t('admin.secret')
                  "
                  autocomplete="new-password"
                />
              </div>

              <div class="actions">
                <button
                  v-if="selected === 's3' && !s3.useInstanceRole"
                  class="btn-secondary"
                  :disabled="testing || s3Incomplete()"
                  @click="testConnection"
                >
                  {{ testing ? t('admin.testing') : t('admin.test') }}
                </button>
                <span v-if="tested === 'ok'" class="ok-text">{{ t('admin.testOk') }}</span>
                <span v-if="tested === 'fail'" class="err-text">{{ t('admin.testFail') }}</span>
                <!-- S3 instance-role no se guarda por UI (lo gestiona el aprovisionamiento). -->
                <button
                  v-if="!(selected === 's3' && s3.useInstanceRole)"
                  class="btn-primary"
                  :disabled="saving || s3Incomplete()"
                  @click="save"
                >
                  {{ saving ? t('admin.saving') : t('admin.save') }}
                </button>
                <span v-if="saved" class="ok-text">{{ t('admin.saved') }}</span>
                <span v-if="error" class="err-text">{{ error }}</span>
              </div>

              <p
                v-if="selected === 's3' && !s3.useInstanceRole && tested !== 'ok' && !s3Incomplete()"
                class="warn-text"
              >
                {{ t('admin.testHint') }}
              </p>
              <p v-if="current?.updatedAt" class="current" data-testid="storage-current">
                {{
                  t('admin.current', {
                    provider: current.providerType,
                    date: fmtDate(current.updatedAt),
                  })
                }}
              </p>
            </div>
          </div>
        </div>
        <!-- /.admin-body -->
      </main>
    </div>
  </AppLayout>
</template>

<style scoped>
/* ===== Shell admin (sidebar + contenido), tipo Google Workspace Admin ===== */
.admin {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}
.admin-scrim {
  display: none;
}
/* ---- Sidebar ---- */
.admin-nav {
  flex-shrink: 0;
  width: 248px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}
.admin-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px 14px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-1);
}
.admin-brand :deep(svg) {
  color: var(--accent);
}
.admin-navlist {
  list-style: none;
  margin: 0;
  padding: 4px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.admin-navitem {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}
.admin-navitem:hover {
  background: var(--hover);
  color: var(--text-1);
}
.admin-navitem.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.admin-navitem:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.admin-nav-foot {
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.admin-nav-foot .bi-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  line-height: 1.6;
}
.admin-nav-foot .bi-app {
  font-weight: 700;
  color: var(--text-1);
}
.admin-nav-foot .bi-dim {
  opacity: 0.85;
}
.admin-nav-foot .bi-sha {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.75;
}
/* ---- Contenido ---- */
.admin-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 24px clamp(16px, 4vw, 40px) 40px;
}
.admin-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 20px;
}
.admin-burger {
  display: none;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text-1);
  cursor: pointer;
  align-items: center;
  justify-content: center;
}
.admin-head-text {
  min-width: 0;
  flex: 1;
}
.admin-section-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--text-1);
}
.admin-section-desc {
  font-size: 13.5px;
  color: var(--text-3);
  line-height: 1.5;
  margin: 4px 0 0;
}
.admin-head-action {
  flex-shrink: 0;
}
.admin-body {
  display: block;
}
/* ---- Aviso de actualización ---- */
.update-banner {
  margin-bottom: 18px;
  padding: 12px 14px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.update-banner.update-yes {
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--text-1);
}
.update-banner.update-ok {
  background: var(--surface-dim);
  border: 1px solid var(--border);
  color: var(--text-2);
}
.update-banner .ub-text {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.update-banner .ub-text span {
  opacity: 0.8;
  font-size: 12px;
}
.update-banner .ub-link {
  margin-left: auto;
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
}
.update-banner .ub-btn,
.update-banner .ub-refresh {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.update-banner .ub-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.update-banner .ub-refresh {
  margin-left: auto;
  background: transparent;
  color: var(--text-1);
}
/* ---- Responsive: sidebar como drawer <900px ---- */
@media (max-width: 900px) {
  .admin-burger {
    display: inline-flex;
  }
  .admin-nav {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 60;
    width: 280px;
    max-width: 84vw;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: var(--shadow-lg);
  }
  .admin.nav-open .admin-nav {
    transform: translateX(0);
  }
  .admin.nav-open .admin-scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 55;
    background: rgba(15, 20, 30, 0.45);
  }
}
.card {
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 24px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
/* Compliance hostea su propio layout: la card no aporta marco para evitar doble caja. */
.card--flush {
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.card-h {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 4px;
}
.card-desc {
  font-size: 13.5px;
  color: var(--text-3);
  line-height: 1.5;
  margin: 0 0 18px;
}
.muted {
  font-size: 14px;
  color: var(--text-3);
}
.muted.sm {
  font-size: 12px;
}
.center {
  text-align: center;
  padding: 18px 0;
}
.hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 8px 0 0;
}
.options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  transition:
    border-color 0.12s,
    box-shadow 0.12s;
}
.option.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.option input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.option-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.option-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.option-desc {
  font-size: 13px;
  color: var(--text-3);
  line-height: 1.5;
}
.badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 5px;
}
.badge.ok {
  color: #16a34a;
  background: color-mix(in srgb, #16a34a 14%, transparent);
}
.badge.admin {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  margin-left: 6px;
}
.s3-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  border-radius: 10px;
  background: var(--surface-dim);
  border: 1px solid var(--border);
}
.fld-lbl {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  margin-top: 6px;
}
.fld-hint {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-3);
  margin-left: 4px;
}
.adminput {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  font: inherit;
  font-size: 13.5px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-1);
  outline: none;
}
.adminput:focus {
  border-color: var(--accent);
}
.adminput.sm {
  width: 96px;
  padding: 6px 8px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding-top: 6px;
}
.btn-primary {
  padding: 9px 20px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  white-space: nowrap;
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-700);
}
.btn-secondary {
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
.btn-secondary:hover:not(:disabled) {
  background: var(--hover);
}
.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: 0.55;
  cursor: default;
}
.ok-text {
  font-size: 13.5px;
  color: #16a34a;
  font-weight: 600;
}
.err-text {
  font-size: 13.5px;
  color: var(--danger);
}
.warn-text {
  font-size: 12px;
  color: #d97706;
  margin: 8px 0 0;
}
.current {
  font-size: 12px;
  color: var(--text-3);
  margin: 8px 0 0;
}

/* ---- Cuentas ---- */
.create-form {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 18px;
  background: var(--surface-dim);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.grid2.tight {
  gap: 8px;
  align-items: end;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.fld.check2 {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.acc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
}
.acc-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.acc-table td {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.acc-table tr.dim {
  opacity: 0.55;
}
.acc-name {
  font-weight: 600;
  color: var(--text-1);
}
.acc-email {
  font-size: 12.5px;
  color: var(--text-3);
}
.status {
  font-size: 11.5px;
  font-weight: 700;
  padding: 2px 9px;
  border-radius: 12px;
}
.status.active {
  color: #16a34a;
  background: color-mix(in srgb, #16a34a 14%, transparent);
}
.status.disabled {
  color: var(--text-3);
  background: var(--hover);
}
.status.error {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}
.status.syncing {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.quota {
  color: var(--text-1);
}
.quota-sep {
  color: var(--text-3);
  margin: 0 4px;
}
.mb {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 4px;
}
.row-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  align-items: center;
}
.icon-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
}
.icon-act:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text-1);
}
.icon-act.danger:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}
.icon-act:disabled {
  opacity: 0.5;
  cursor: default;
}
.link-btn {
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 4px 6px;
}
.link-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---- Marca ---- */
.brand-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 460px;
}
.color-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.color-input {
  width: 44px;
  height: 38px;
  padding: 2px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  cursor: pointer;
}
.logo-row {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.logo-preview {
  width: 120px;
  height: 64px;
  border: 1px solid var(--border);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  overflow: hidden;
  flex-shrink: 0;
}
.logo-preview.empty {
  border-style: dashed;
}
.logo-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.logo-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.file-btn {
  display: inline-block;
  cursor: pointer;
}
</style>
