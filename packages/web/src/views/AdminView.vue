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
import AdminGroups from '@/components/admin/AdminGroups.vue';
import AdminRoles from '@/components/admin/AdminRoles.vue';
import AdminSignaturePolicy from '@/components/admin/AdminSignaturePolicy.vue';
import AdminProvisioning from '@/components/admin/AdminProvisioning.vue';
import AdminGoogleCalendar from '@/components/admin/AdminGoogleCalendar.vue';
import { api } from '@/lib/http';
import {
  brand,
  applyBrand,
  ICON_WEIGHTS,
  DEFAULT_ICON_WEIGHT,
  type IconWeight,
} from '@/config/brand';
import { BUILD_INFO } from '@/lib/buildInfo';
import { useAuthStore } from '@/stores/auth';
import { s3FormFromConfig, s3Incomplete as computeS3Incomplete } from '@/lib/adminStorage';

/**
 * Panel de administración (Roundcube administrable) con cuatro secciones:
 *  - Cuentas: alta/edición/baja de cuentas y cuota de almacenamiento.
 *  - Marca: branding white-label en runtime (nombre, eslogan, color, logo de empresa).
 *  - Almacenamiento: destino de los adjuntos (local / S3) — wizard preexistente.
 *  - Compliance: gestión de documentos legales, versiones, enforcement y auditoría de aceptaciones.
 * Todo exige rol admin (verificado también en el backend).
 */
type Tab =
  | 'accounts'
  | 'groups'
  | 'roles'
  | 'branding'
  | 'signatures'
  | 'storage'
  | 'provisioning'
  | 'compliance'
  | 'scheduling'
  | 'preferences'
  | 'gcal';
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
    key: 'groups',
    icon: 'user',
    label: 'admin.tabs.groups',
    title: 'admin.groups.title',
    desc: 'admin.groups.desc',
  },
  {
    key: 'roles',
    icon: 'shield',
    label: 'admin.tabs.roles',
    title: 'admin.roles.title',
    desc: 'admin.roles.desc',
  },
  {
    key: 'branding',
    icon: 'palette',
    label: 'admin.tabs.branding',
    title: 'admin.branding.title',
    desc: 'admin.branding.desc',
  },
  {
    key: 'signatures',
    icon: 'pencil',
    label: 'admin.tabs.signatures',
    title: 'admin.signatures.title',
    desc: 'admin.signatures.desc',
  },
  {
    key: 'storage',
    icon: 'database',
    label: 'admin.tabs.storage',
    title: 'admin.question',
    desc: 'admin.questionDesc',
  },
  {
    key: 'provisioning',
    icon: 'lock',
    label: 'admin.tabs.provisioning',
    title: 'admin.provisioning.title',
    desc: 'admin.provisioning.desc',
  },
  {
    key: 'preferences',
    icon: 'calendar',
    label: 'admin.tabs.preferences',
    title: 'admin.preferences.title',
    desc: 'admin.preferences.desc',
  },
  {
    key: 'gcal',
    icon: 'globe',
    label: 'admin.tabs.gcal',
    title: 'admin.gcal.title',
    desc: 'admin.gcal.desc',
  },
  {
    key: 'compliance',
    icon: 'file',
    label: 'admin.tabs.compliance',
    title: 'admin.compliance.title',
    desc: 'admin.compliance.desc',
  },
  {
    key: 'scheduling',
    icon: 'clock',
    label: 'admin.tabs.scheduling',
    title: 'admin.scheduling.title',
    desc: 'admin.scheduling.desc',
  },
];
const activeSection = computed(() => SECTIONS.find((s) => s.key === tab.value) ?? SECTIONS[0]);

// Grupos del sidebar (tipo Google Workspace Admin): cada grupo agrupa secciones bajo un encabezado.
// `count` (opcional) es la clave de un contador reactivo mostrado como badge junto al item.
interface NavGroup {
  label: string; // i18n key del encabezado
  keys: Tab[];
}
const NAV_GROUPS: NavGroup[] = [
  { label: 'admin.navGroups.directory', keys: ['accounts', 'groups', 'roles'] },
  {
    label: 'admin.navGroups.config',
    keys: ['branding', 'signatures', 'storage', 'provisioning', 'preferences', 'gcal'],
  },
  { label: 'admin.navGroups.compliance', keys: ['compliance', 'scheduling'] },
];
function sectionOf(key: Tab): AdminSection {
  return SECTIONS.find((s) => s.key === key) ?? SECTIONS[0];
}

// ── Visibilidad por permiso (RBAC F8) ──
// El admin real ve TODO. Un delegado ve sólo las secciones cuyo permiso posee (mismo criterio que el
// default-deny del backend). `compliance` no tiene permiso en el catálogo → sólo admin (sus endpoints
// /compliance/admin son admin-only).
const auth = useAuthStore();
const isAdmin = computed(() => auth.user?.role === 'admin');
const myPerms = computed(() => new Set(auth.user?.adminPermissions ?? []));
const SECTION_PERMISSION: Record<Tab, string | null> = {
  accounts: 'accounts.manage',
  groups: 'groups.manage',
  roles: 'roles.manage',
  branding: 'branding.manage',
  signatures: 'branding.manage',
  storage: 'storage.manage',
  provisioning: 'accounts.manage',
  preferences: 'calendar.manage',
  scheduling: 'scheduling.manage',
  compliance: null, // admin-only (sin permiso delegable)
  gcal: null, // admin-only (credenciales OAuth de Google — endpoints /admin/google-calendar)
};
function canSee(key: Tab): boolean {
  if (isAdmin.value) return true;
  const perm = SECTION_PERMISSION[key];
  return perm != null && myPerms.value.has(perm);
}
const canManageRoles = computed(() => isAdmin.value || myPerms.value.has('roles.manage'));
// Grupos del nav ya filtrados a lo que el usuario puede ver (grupo vacío se oculta).
const visibleNavGroups = computed(() =>
  NAV_GROUPS.map((g) => ({ label: g.label, keys: g.keys.filter(canSee) })).filter(
    (g) => g.keys.length > 0
  )
);
// Contador por sección (badge del nav). Sólo donde el dato ya está cargado; undefined = sin badge.
const navCounts = computed<Partial<Record<Tab, number>>>(() => ({
  accounts: accounts.value.length || undefined,
  groups: groupCount.value || undefined,
  roles: roles.value.length || undefined,
}));

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
  customRoleId: string | null;
  customRoleName: string | null;
  isPrimary: boolean;
  status: 'active' | 'syncing' | 'error' | 'disabled';
  quotaBytes: number;
  usedBytes: number;
  lastSyncedAt: string | null;
  // false ⇒ buzón importado del servidor sin sesión iniciada aún (sin credenciales de webmail).
  linked?: boolean;
}

const accounts = ref<AdminAccount[]>([]);
const accLoading = ref(true);
const accError = ref('');
// Total real de buzones en el servidor de correo (accounts.cf). null = provisioning no aplica.
const serverMailboxCount = ref<number | null>(null);
const importing = ref(false);
// Cuántos buzones existen en el servidor pero aún NO están registrados en Bifrost (brownfield).
const unregisteredCount = computed(() =>
  serverMailboxCount.value === null
    ? 0
    : Math.max(0, serverMailboxCount.value - accounts.value.length)
);

async function loadAccounts() {
  accLoading.value = true;
  accError.value = '';
  try {
    const { data } = await api.get<{ accounts: AdminAccount[]; serverMailboxCount: number | null }>(
      '/admin/accounts'
    );
    accounts.value = data.accounts;
    serverMailboxCount.value = data.serverMailboxCount;
  } catch {
    accError.value = t('admin.accounts.errLoad');
  } finally {
    accLoading.value = false;
  }
}

// Importa a Bifrost los buzones que existen en el servidor pero no están registrados (brownfield:
// migrados de otro webmail o creados a mano). Tras importar, quedan gestionables (suspender/borrar/clave).
async function importAccounts() {
  importing.value = true;
  accError.value = '';
  try {
    await api.post('/admin/accounts/import');
    await loadAccounts();
  } catch {
    accError.value = t('admin.accounts.errImport');
  } finally {
    importing.value = false;
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
  // `null` = "usar la cuota por defecto" (F6): si el admin no escribe nada, NO se manda `quotaBytes`
  // y el backend aplica el default. Un número (incl. 0=ilimitado) se respeta tal cual.
  quotaMb: null as number | null,
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
  // Campo de cuota vacío → NO mandar `quotaBytes` (el backend aplica la cuota por defecto, F6).
  const q = form.value.quotaMb;
  const hasQuota = typeof q === 'number' && !Number.isNaN(q);
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
      ...(hasQuota ? { quotaBytes: Math.max(0, Math.round(q)) * 1024 * 1024 } : {}),
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

// --- Edición de cuota / nombre (desde la ficha de usuario) ---
// `editName`/`editQuotaMb` los alimenta `openUser` y los consume `saveProfile` (ver más abajo).
const editQuotaMb = ref(0);
const editName = ref('');
const rowBusy = ref<string | null>(null);

async function toggleStatus(a: AdminAccount) {
  rowBusy.value = a.id;
  accError.value = '';
  try {
    await api.patch(`/admin/accounts/${a.id}`, {
      status: a.status === 'disabled' ? 'active' : 'disabled',
    });
    await loadAccounts();
    // Re-vincular la ficha al registro recargado (refleja el nuevo estado sin cerrarla).
    if (selectedUser.value?.id === a.id) {
      selectedUser.value = accounts.value.find((x) => x.id === a.id) ?? null;
    }
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
    if (selectedUser.value?.id === a.id) closeUser(); // la cuenta ya no existe → cerrar la ficha
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

// --- Cambiar/resetear la contraseña del buzón (sólo con provisioning) ---
const showPwReset = ref(false);
const pwNew = ref('');
const pwResult = ref(''); // contraseña generada: se muestra UNA vez
const pwError = ref('');
const pwBusy = ref(false);
function openPwReset() {
  showPwReset.value = true;
  pwNew.value = '';
  pwResult.value = '';
  pwError.value = '';
}
async function submitPwReset() {
  const target = selectedUser.value;
  if (!target) return;
  pwBusy.value = true;
  pwError.value = '';
  pwResult.value = '';
  try {
    const { data } = await api.post<{ ok: boolean; password?: string }>(
      `/admin/accounts/${target.id}/reset-password`,
      pwNew.value ? { password: pwNew.value } : {}
    );
    await loadAccounts();
    // Re-vincular la ficha (la cuenta importada pasa a "vinculada" tras fijarle la clave).
    selectedUser.value = accounts.value.find((x) => x.id === target.id) ?? selectedUser.value;
    if (data.password) {
      pwResult.value = data.password; // generada → mostrarla para copiar
    } else {
      showPwReset.value = false; // el admin fijó una → nada que mostrar
    }
  } catch {
    pwError.value = t('admin.accounts.pwErr');
  } finally {
    pwBusy.value = false;
  }
}

// ── Presentación de usuarios (maqueta admin.html): avatar de color + badge de rol + barra de uso ──
/** Iniciales para el avatar (1–2 letras a partir del nombre visible o el email). */
function initials(a: AdminAccount): string {
  const src = (a.displayName || a.name || a.email || '?').trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : src.slice(0, 2);
  return chars.toUpperCase();
}
// Paleta determinista para el avatar (mismo usuario → mismo color). Tonos de la maqueta.
const AVATAR_COLORS = ['#1b66ff', '#e0457b', '#f59e0b', '#16a34a', '#9333ea', '#0891b2', '#ea580c'];
function avatarColor(a: AdminAccount): string {
  let h = 0;
  const key = a.userId || a.email;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
/** Etiqueta de rol: admin real → "Super administrador"; rol custom → su nombre; si no → "Usuario". */
function roleLabel(a: AdminAccount): string {
  if (a.role === 'admin') return t('admin.roles.superAdmin');
  return a.customRoleName ?? t('admin.roles.plainUser');
}
/** Tono del badge de rol: admin (rojo), custom (azul), usuario (gris). */
function roleTone(a: AdminAccount): 'admin' | 'custom' | 'plain' {
  if (a.role === 'admin') return 'admin';
  return a.customRoleName ? 'custom' : 'plain';
}
// `usagePct` ya existe (F6, más abajo). Tono de la barra según % de uso.
function usageTone(pct: number): 'ok' | 'warn' | 'over' {
  if (pct >= 90) return 'over';
  if (pct >= 70) return 'warn';
  return 'ok';
}

// ── Ficha de usuario (detalle): al hacer click en una fila se abre el perfil (maqueta img 2) ──
const selectedUser = ref<AdminAccount | null>(null);
function openUser(a: AdminAccount) {
  selectedUser.value = a;
  editName.value = a.displayName;
  editQuotaMb.value = Math.round(a.quotaBytes / (1024 * 1024));
  assignRoleId.value = a.customRoleId ?? '';
  // Reset del panel de contraseña al abrir otra ficha (no arrastrar una clave generada entre usuarios).
  showPwReset.value = false;
  pwResult.value = '';
  pwError.value = '';
}
function closeUser() {
  selectedUser.value = null;
}
// Guardado del perfil desde la ficha (nombre + cuota) reusando el endpoint de edición.
async function saveProfile() {
  const a = selectedUser.value;
  if (!a) return;
  rowBusy.value = a.id;
  accError.value = '';
  try {
    await api.patch(`/admin/accounts/${a.id}`, {
      quotaBytes: Math.max(0, Math.round(editQuotaMb.value)) * 1024 * 1024,
      ...(editName.value.trim() ? { displayName: editName.value.trim() } : {}),
    });
    await loadAccounts();
    // Re-vincular la ficha al registro recargado (para reflejar cambios).
    selectedUser.value = accounts.value.find((x) => x.id === a.id) ?? null;
  } catch {
    accError.value = t('admin.accounts.errSave');
  } finally {
    rowBusy.value = null;
  }
}

// ============================ ROLES (RBAC, F8) ============================
interface AdminRole {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}
const roles = ref<AdminRole[]>([]);
const groupCount = ref(0);
// Asignación de rol desde la ficha de usuario.
const assignRoleId = ref<string>('');

async function loadRoles() {
  try {
    const { data } = await api.get<{ roles: AdminRole[] }>('/admin/roles');
    roles.value = data.roles;
  } catch {
    /* silencioso: la sección Roles muestra su propio estado si falla */
  }
}
async function loadGroupCount() {
  try {
    const { data } = await api.get<{ groups: unknown[] }>('/admin/groups');
    groupCount.value = data.groups.length;
  } catch {
    /* contador best-effort */
  }
}
// Asigna (o quita con '') el rol custom a la cuenta abierta en la ficha.
async function assignRole() {
  const a = selectedUser.value;
  if (!a) return;
  rowBusy.value = a.id;
  accError.value = '';
  try {
    await api.patch(`/admin/accounts/${a.id}/role`, {
      customRoleId: assignRoleId.value || null,
    });
    await loadAccounts();
    selectedUser.value = accounts.value.find((x) => x.id === a.id) ?? null;
  } catch {
    accError.value = t('admin.roles.errAssign');
  } finally {
    rowBusy.value = null;
  }
}

// ============================ MARCA (branding) ============================
const brandForm = ref({
  companyName: '',
  tagline: '',
  accentColor: '#1b66ff',
  logoDataUrl: '',
  // Branding extendido (F1) — alimenta los templates de firma white-label.
  domainUrl: '',
  phone: '',
  address: '',
  linkedin: '',
  instagram: '',
  x: '',
  facebook: '',
  youtube: '',
  github: '',
  whatsapp: '',
  website: '',
  appStoreUrl: '',
  googlePlayUrl: '',
  logoWidthPx: 120,
  lockAccentColor: false,
  iconWeight: DEFAULT_ICON_WEIGHT,
});
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
      domainUrl?: string | null;
      phone?: string | null;
      address?: string | null;
      socialLinks?: Record<string, string> | null;
      appStoreUrl?: string | null;
      googlePlayUrl?: string | null;
      logoWidthPx?: number | null;
      lockAccentColor?: boolean;
      iconWeight?: IconWeight;
    }>('/admin/config/branding');
    brandForm.value.companyName = data.companyName ?? '';
    brandForm.value.tagline = data.tagline ?? '';
    brandForm.value.accentColor = data.accentColor ?? brand.accent;
    brandForm.value.logoDataUrl = data.logoDataUrl ?? '';
    brandForm.value.domainUrl = data.domainUrl ?? '';
    brandForm.value.phone = data.phone ?? '';
    brandForm.value.address = data.address ?? '';
    brandForm.value.linkedin = data.socialLinks?.linkedin ?? '';
    brandForm.value.instagram = data.socialLinks?.instagram ?? '';
    brandForm.value.x = data.socialLinks?.x ?? '';
    brandForm.value.facebook = data.socialLinks?.facebook ?? '';
    brandForm.value.youtube = data.socialLinks?.youtube ?? '';
    brandForm.value.github = data.socialLinks?.github ?? '';
    brandForm.value.whatsapp = data.socialLinks?.whatsapp ?? '';
    brandForm.value.website = data.socialLinks?.website ?? '';
    brandForm.value.appStoreUrl = data.appStoreUrl ?? '';
    brandForm.value.googlePlayUrl = data.googlePlayUrl ?? '';
    brandForm.value.logoWidthPx = data.logoWidthPx ?? 120;
    brandForm.value.lockAccentColor = data.lockAccentColor ?? false;
    brandForm.value.iconWeight = data.iconWeight ?? 'light';
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
    const f = brandForm.value;
    const payload = {
      companyName: f.companyName.trim(),
      tagline: f.tagline.trim(),
      accentColor: f.accentColor,
      logoDataUrl: f.logoDataUrl, // '' limpia el logo
      // Branding extendido (F1). '' limpia cada campo (nonEmpty en el backend).
      domainUrl: f.domainUrl.trim(),
      phone: f.phone.trim(),
      address: f.address.trim(),
      appStoreUrl: f.appStoreUrl.trim(),
      googlePlayUrl: f.googlePlayUrl.trim(),
      socialLinks: {
        linkedin: f.linkedin.trim(),
        instagram: f.instagram.trim(),
        x: f.x.trim(),
        facebook: f.facebook.trim(),
        youtube: f.youtube.trim(),
        github: f.github.trim(),
        whatsapp: f.whatsapp.trim(),
        website: f.website.trim(),
      },
      logoWidthPx: f.logoWidthPx,
      lockAccentColor: f.lockAccentColor,
      iconWeight: f.iconWeight,
    };
    await api.put('/admin/config/branding', payload);
    // Aplicar en vivo (sin recargar): la marca es reactiva y la consume toda la UI.
    brand.name = payload.companyName || 'Bifrost';
    brand.tagline = payload.tagline || brand.tagline;
    brand.accent = payload.accentColor;
    brand.logoUrl = payload.logoDataUrl || null;
    brand.lockAccentColor = payload.lockAccentColor;
    brand.iconWeight = payload.iconWeight; // live: los iconos cambian de estilo al instante
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
      // s3FormFromConfig guarda cada campo contra undefined (con rol de instancia no viene accessKeyId →
      // sin el guard, un `.trim()` posterior crasheaba la sección). Lógica pura + testeada en lib/adminStorage.
      Object.assign(s3.value, s3FormFromConfig(data.s3));
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

// ============================ ALMACENAMIENTO: defaults + uso (F6) ============================
const defaultQuotaMb = ref(0);
const defQuotaSaving = ref(false);
const defQuotaSaved = ref(false);
async function loadStorageDefaults() {
  try {
    const { data } = await api.get<{ defaultQuotaBytes: number }>('/admin/config/storage-defaults');
    defaultQuotaMb.value = Math.round(data.defaultQuotaBytes / (1024 * 1024));
  } catch {
    /* defaults a 0 (sin límite) si no responde */
  }
}
async function saveStorageDefaults() {
  defQuotaSaving.value = true;
  defQuotaSaved.value = false;
  try {
    await api.patch('/admin/config/storage-defaults', {
      defaultQuotaBytes: Math.max(0, Math.round(defaultQuotaMb.value)) * 1024 * 1024,
    });
    defQuotaSaved.value = true;
  } finally {
    defQuotaSaving.value = false;
  }
}
/** % de uso (0..100) sólo cuando hay cuota; sin cuota (0=ilimitado) no hay barra significativa. */
function usagePct(a: AdminAccount): number {
  if (a.quotaBytes <= 0) return 0;
  return Math.min(100, Math.round((a.usedBytes / a.quotaBytes) * 100));
}

onMounted(async () => {
  // Si la sección inicial no es visible para este usuario (delegado sin accounts.manage), saltar a la
  // primera sección que sí puede ver.
  if (!canSee(tab.value)) {
    const first = SECTIONS.find((s) => canSee(s.key));
    if (first) tab.value = first.key;
  }
  window.addEventListener('keydown', onKeydown);
  mq = window.matchMedia('(max-width: 900px)');
  isNarrow.value = mq.matches;
  mq.addEventListener('change', onMq);
  // Cargas por permiso: un delegado sólo pide lo que puede ver (evita 403 ruidosos). El admin ve todo.
  await Promise.all([
    canSee('accounts') ? loadAccounts() : Promise.resolve(),
    canManageRoles.value ? loadRoles() : Promise.resolve(),
    canSee('groups') ? loadGroupCount() : Promise.resolve(),
    canSee('branding') ? loadBranding() : Promise.resolve(),
    canSee('storage') ? loadStorage() : Promise.resolve(),
    canSee('storage') ? loadStorageDefaults() : Promise.resolve(),
    // /admin/version y /admin/update/check son admin-only.
    isAdmin.value ? loadApiBuild() : Promise.resolve(),
    isAdmin.value ? loadUpdate() : Promise.resolve(),
  ]);
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
  // Lógica pura + testeada en lib/adminStorage (short-circuit por useInstanceRole incluido).
  return computeS3Incomplete(s3.value);
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
        <div class="admin-navscroll">
          <div v-for="g in visibleNavGroups" :key="g.label" class="admin-navgroup">
            <p class="admin-navgroup-label">{{ t(g.label) }}</p>
            <ul class="admin-navlist">
              <li v-for="key in g.keys" :key="key">
                <button
                  class="admin-navitem"
                  :class="{ active: tab === key }"
                  :aria-current="tab === key ? 'page' : undefined"
                  :data-testid="`admin-section-${key}`"
                  @click="selectSection(key)"
                >
                  <AppIcon :name="sectionOf(key).icon" :size="18" />
                  <span>{{ t(sectionOf(key).label) }}</span>
                  <span v-if="navCounts[key] != null" class="admin-navcount">{{
                    navCounts[key]
                  }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
        <footer class="admin-nav-foot" data-testid="build-info">
          <!-- Estado de actualización: UNA sola vez acá (#35; antes se repetía en cada sección). Sólo
               lo carga el admin real (isAdmin) → un delegado no ve este widget. -->
          <div
            v-if="update?.updateAvailable"
            class="bi-update bi-update-yes"
            data-testid="update-available"
          >
            <button class="ub-btn-sm" :disabled="updating" @click="applyUpdate">
              <AppIcon name="download" :size="14" />
              {{ updating ? 'Actualizando…' : `Actualizar a build ${update.latest?.build ?? ''}` }}
            </button>
            <a
              v-if="update.compareUrl"
              :href="update.compareUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="ub-link-sm"
              >Ver cambios</a
            >
          </div>
          <div
            v-else-if="update && !update.updateAvailable && update.latest"
            class="bi-update"
            data-testid="update-current"
          >
            <span class="bi-uptodate"><AppIcon name="check" :size="13" /> Última versión</span>
            <button class="bi-check-link" :disabled="checkingUpdate" @click="loadUpdate(true)">
              {{ checkingUpdate ? 'Buscando…' : 'Buscar' }}
            </button>
          </div>
          <div v-else-if="update?.checkError" class="bi-update" data-testid="update-unknown">
            <button class="bi-check-link" :disabled="checkingUpdate" @click="loadUpdate(true)">
              {{ checkingUpdate ? 'Buscando…' : 'Verificar versión' }}
            </button>
          </div>
          <p v-if="updateMsg" class="ub-msg-sm" data-testid="update-msg">{{ updateMsg }}</p>
          <!-- Chip de versión (rediseño maqueta): reemplaza las líneas build sueltas. El testid
               `build-web` va en la línea "web {build}" (contrato del e2e: detecta cache tras deploy). -->
          <div class="admin-verchip">
            <AppIcon name="shield" :size="16" />
            <div class="admin-verchip-text">
              <span class="bi-app">{{ brand.name }} v{{ BUILD_INFO.version }}</span>
              <span class="bi-dim" data-testid="build-web"
                >web {{ BUILD_INFO.build }} · {{ BUILD_INFO.sha }}</span
              >
              <span v-if="apiBuild" class="bi-dim" data-testid="build-api">api {{ apiBuild }}</span>
            </div>
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
            v-if="tab === 'accounts' && !selectedUser"
            class="btn-primary admin-head-action"
            data-testid="admin-new-account"
            @click="showCreate = !showCreate"
          >
            {{ showCreate ? t('admin.accounts.cancelNew') : t('admin.accounts.new') }}
          </button>
        </header>

        <!-- El estado de actualización se muestra UNA vez en el footer del sidebar (no por sección). -->
        <div class="admin-body">
          <!-- ===================== AGENDA ===================== -->
          <AdminSchedulingPanel v-if="tab === 'scheduling'" />

          <!-- ===================== PREFERENCIAS DE CALENDARIO ===================== -->
          <AdminCalendarPrefs v-else-if="tab === 'preferences'" />

          <!-- ===================== GRUPOS ===================== -->
          <AdminGroups v-else-if="tab === 'groups'" />

          <!-- ===================== ROLES Y PERMISOS (RBAC, F8) ===================== -->
          <AdminRoles v-else-if="tab === 'roles'" @changed="loadRoles" />

          <!-- ===================== PROVISIONING (API-keys de buzones) ===================== -->
          <AdminProvisioning v-else-if="tab === 'provisioning'" />

          <AdminGoogleCalendar v-else-if="tab === 'gcal'" />

          <!-- ===================== USUARIOS ===================== -->
          <template v-if="tab === 'accounts'">
            <!-- Ficha de usuario (detalle, maqueta admin.html) -->
            <div v-if="selectedUser" class="user-detail" data-testid="user-detail">
              <button class="back-link" @click="closeUser">
                <AppIcon name="arrowLeft" :size="16" />
                <span>{{ t('admin.users.back') }}</span>
              </button>
              <div class="user-detail-grid">
                <aside class="card user-hero">
                  <div class="user-hero-band" :style="{ background: avatarColor(selectedUser) }" />
                  <div class="user-hero-avatar" :style="{ background: avatarColor(selectedUser) }">
                    {{ initials(selectedUser) }}
                  </div>
                  <h2 class="user-hero-name">{{ selectedUser.displayName }}</h2>
                  <p class="user-hero-email">{{ selectedUser.email }}</p>
                  <div class="user-hero-badges">
                    <span class="role-badge" :class="roleTone(selectedUser)">{{
                      roleLabel(selectedUser)
                    }}</span>
                    <span class="status-dot" :class="selectedUser.status"
                      ><i />{{ t('admin.accounts.st.' + selectedUser.status) }}</span
                    >
                  </div>
                  <ul class="user-hero-meta">
                    <li v-if="selectedUser.lastSyncedAt">
                      <AppIcon name="clock" :size="15" />
                      <span>{{ fmtDate(selectedUser.lastSyncedAt) }}</span>
                    </li>
                    <li>
                      <AppIcon name="database" :size="15" />
                      <span
                        >{{ fmtBytes(selectedUser.usedBytes) }} {{ t('admin.users.of') }}
                        {{
                          selectedUser.quotaBytes > 0
                            ? fmtBytes(selectedUser.quotaBytes)
                            : t('admin.accounts.unlimited')
                        }}</span
                      >
                    </li>
                  </ul>
                </aside>

                <div class="user-detail-main">
                  <section class="card user-panel">
                    <h3>{{ t('admin.users.profile') }}</h3>
                    <div class="grid2">
                      <label class="fld"
                        ><span>{{ t('admin.accounts.displayName') }}</span
                        ><input v-model="editName" class="adminput"
                      /></label>
                      <label class="fld"
                        ><span>{{ t('admin.accounts.email') }}</span
                        ><input :value="selectedUser.email" class="adminput" disabled
                      /></label>
                      <label class="fld"
                        ><span>{{ t('admin.accounts.quotaMb') }}</span
                        ><input v-model.number="editQuotaMb" type="number" min="0" class="adminput"
                      /></label>
                    </div>
                    <div class="actions">
                      <button
                        class="btn-primary"
                        :disabled="rowBusy === selectedUser.id"
                        @click="saveProfile"
                      >
                        {{ t('admin.users.saveChanges') }}
                      </button>
                      <button
                        v-if="selectedUser.role !== 'admin'"
                        class="btn-ghost"
                        :disabled="rowBusy === selectedUser.id"
                        @click="toggleStatus(selectedUser)"
                      >
                        {{
                          selectedUser.status === 'disabled'
                            ? t('admin.accounts.enable')
                            : t('admin.accounts.disable')
                        }}
                      </button>
                      <button
                        v-if="selectedUser.role !== 'admin'"
                        class="btn-ghost"
                        :disabled="pwBusy"
                        @click="showPwReset ? (showPwReset = false) : openPwReset()"
                      >
                        {{ t('admin.accounts.pwChange') }}
                      </button>
                    </div>

                    <!-- Cambiar/generar contraseña del buzón (sólo provisioning; vincula las importadas). -->
                    <div v-if="showPwReset" class="pw-reset">
                      <p class="hint">{{ t('admin.accounts.pwHint') }}</p>
                      <div class="pw-row">
                        <input
                          v-model="pwNew"
                          type="text"
                          class="adminput"
                          autocomplete="off"
                          :placeholder="t('admin.accounts.pwNewPh')"
                        />
                        <button class="btn-primary" :disabled="pwBusy" @click="submitPwReset">
                          {{
                            pwBusy ? t('admin.accounts.pwApplying') : t('admin.accounts.pwApply')
                          }}
                        </button>
                      </div>
                      <p v-if="pwError" class="err-text">{{ pwError }}</p>
                      <div v-if="pwResult" class="pw-result">
                        <span>{{ t('admin.accounts.pwGenerated') }}</span>
                        <code>{{ pwResult }}</code>
                      </div>
                    </div>
                    <p v-if="accError" class="err-text">{{ accError }}</p>
                  </section>

                  <section v-if="canManageRoles" class="card user-panel">
                    <h3>{{ t('admin.users.roleSection') }}</h3>
                    <p v-if="selectedUser.role === 'admin'" class="muted">
                      {{ t('admin.users.adminRoleNote') }}
                    </p>
                    <div v-else class="role-assign">
                      <select
                        v-model="assignRoleId"
                        class="adminput"
                        :aria-label="t('admin.users.roleSection')"
                      >
                        <option value="">{{ t('admin.users.noRole') }}</option>
                        <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
                      </select>
                      <button
                        class="btn-primary"
                        :disabled="rowBusy === selectedUser.id"
                        @click="assignRole"
                      >
                        {{ t('admin.users.assign') }}
                      </button>
                    </div>
                  </section>

                  <section class="card user-panel">
                    <h3>{{ t('admin.users.storage') }}</h3>
                    <p class="storage-line">
                      {{ fmtBytes(selectedUser.usedBytes) }} {{ t('admin.users.of') }}
                      {{
                        selectedUser.quotaBytes > 0
                          ? fmtBytes(selectedUser.quotaBytes)
                          : t('admin.accounts.unlimited')
                      }}
                    </p>
                    <div class="usage-bar">
                      <span
                        :class="usageTone(usagePct(selectedUser))"
                        :style="{
                          width: (selectedUser.quotaBytes > 0 ? usagePct(selectedUser) : 4) + '%',
                        }"
                      />
                    </div>
                    <div v-if="selectedUser.role !== 'admin'" class="danger-zone">
                      <button
                        class="btn-danger"
                        :disabled="rowBusy === selectedUser.id"
                        @click="removeAccount(selectedUser)"
                      >
                        {{ t('admin.accounts.delete') }}
                      </button>
                    </div>
                  </section>
                </div>
              </div>
            </div>

            <!-- Lista de usuarios + alta -->
            <template v-else>
              <!-- Form de alta -->
              <div v-if="showCreate" class="card create-card" @input="createError = ''">
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
                    ><input
                      v-model.number="form.quotaMb"
                      type="number"
                      min="0"
                      class="adminput"
                      :placeholder="t('admin.accounts.quotaDefaultPh')"
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

              <!-- Aviso brownfield: el servidor tiene buzones que Bifrost no registra todavía. -->
              <div v-if="unregisteredCount > 0" class="import-banner">
                <AppIcon name="database" :size="18" />
                <span class="import-banner-text">{{
                  t('admin.accounts.importBanner', {
                    n: unregisteredCount,
                    total: serverMailboxCount,
                  })
                }}</span>
                <button class="btn-primary sm" :disabled="importing" @click="importAccounts">
                  {{ importing ? t('admin.accounts.importing') : t('admin.accounts.importBtn') }}
                </button>
              </div>

              <div class="card users-card">
                <p v-if="accLoading" class="muted">{{ t('common.loading') }}</p>
                <p v-else-if="accError" class="err-text">{{ accError }}</p>
                <div v-else class="user-table" data-testid="user-table">
                  <div class="user-thead">
                    <span>{{ t('admin.users.colUser') }}</span>
                    <span>{{ t('admin.users.colRole') }}</span>
                    <span>{{ t('admin.users.colStatus') }}</span>
                    <span>{{ t('admin.users.colStorage') }}</span>
                    <span class="uchev-h" />
                  </div>
                  <button
                    v-for="a in accounts"
                    :key="a.id"
                    class="user-row"
                    :class="{ dim: a.status === 'disabled' }"
                    :data-testid="`user-row-${a.id}`"
                    @click="openUser(a)"
                  >
                    <span class="ucell ucell-user">
                      <span class="uavatar" :style="{ background: avatarColor(a) }">{{
                        initials(a)
                      }}</span>
                      <span class="uinfo">
                        <span class="uname">{{ a.displayName }}</span>
                        <span class="uemail">{{ a.email }}</span>
                      </span>
                    </span>
                    <span class="ucell ucell-role">
                      <span class="role-badge" :class="roleTone(a)">{{ roleLabel(a) }}</span>
                    </span>
                    <span class="ucell ucell-status">
                      <span class="status-dot" :class="a.status"
                        ><i />{{ t('admin.accounts.st.' + a.status) }}</span
                      >
                      <span
                        v-if="a.linked === false"
                        class="unlinked-badge"
                        :title="t('admin.accounts.unlinkedHint')"
                        >{{ t('admin.accounts.unlinked') }}</span
                      >
                    </span>
                    <span class="ucell ucell-storage">
                      <span class="ustorage-text"
                        >{{ fmtBytes(a.usedBytes) }} {{ t('admin.users.of') }}
                        {{
                          a.quotaBytes > 0 ? fmtBytes(a.quotaBytes) : t('admin.accounts.unlimited')
                        }}</span
                      >
                      <span class="usage-bar sm">
                        <span
                          :class="usageTone(usagePct(a))"
                          :style="{ width: (a.quotaBytes > 0 ? usagePct(a) : 4) + '%' }"
                        />
                      </span>
                    </span>
                    <span class="ucell ucell-chev"><AppIcon name="chevronRight" :size="18" /></span>
                  </button>
                  <p v-if="accounts.length === 0" class="muted center empty-row">
                    {{ t('admin.accounts.empty') }}
                  </p>
                </div>
              </div>
            </template>
          </template>

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
                ><span>{{ t('admin.branding.iconStyle') }}</span>
                <select
                  v-model="brandForm.iconWeight"
                  class="adminput"
                  @change="brand.iconWeight = brandForm.iconWeight"
                >
                  <option v-for="w in ICON_WEIGHTS" :key="w" :value="w">
                    {{ t('admin.branding.iconWeights.' + w) }}
                  </option>
                </select>
                <span class="icon-style-preview" aria-hidden="true">
                  <AppIcon name="inbox" :size="22" />
                  <AppIcon name="star" :size="22" />
                  <AppIcon name="send" :size="22" />
                  <AppIcon name="calendar" :size="22" />
                  <AppIcon name="settings" :size="22" />
                  <AppIcon name="user" :size="22" />
                </span>
                <p class="hint">{{ t('admin.branding.iconStyleHint') }}</p>
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

              <!-- ── Branding extendido (F1): datos que alimentan los templates de firma ── -->
              <h3 class="brand-subhead">{{ t('admin.branding.signatureData') }}</h3>
              <p class="hint">{{ t('admin.branding.signatureDataHint') }}</p>
              <div class="grid2">
                <label class="fld"
                  ><span>{{ t('admin.branding.domainUrl') }}</span
                  ><input
                    v-model="brandForm.domainUrl"
                    class="adminput"
                    type="url"
                    placeholder="https://aulion.app"
                /></label>
                <label class="fld"
                  ><span>{{ t('admin.branding.phone') }}</span
                  ><input v-model="brandForm.phone" class="adminput" maxlength="40"
                /></label>
                <label class="fld"
                  ><span>{{ t('admin.branding.address') }}</span
                  ><input v-model="brandForm.address" class="adminput" maxlength="160"
                /></label>
                <label class="fld"
                  ><span>{{ t('admin.branding.logoWidth') }}</span
                  ><input
                    v-model.number="brandForm.logoWidthPx"
                    class="adminput"
                    type="number"
                    min="40"
                    max="400"
                /></label>
                <label class="fld"
                  ><span>LinkedIn</span
                  ><input
                    v-model="brandForm.linkedin"
                    class="adminput"
                    type="url"
                    placeholder="https://linkedin.com/company/…"
                /></label>
                <label class="fld"
                  ><span>Instagram</span
                  ><input v-model="brandForm.instagram" class="adminput" type="url"
                /></label>
                <label class="fld"
                  ><span>X / Twitter</span><input v-model="brandForm.x" class="adminput" type="url"
                /></label>
                <label class="fld"
                  ><span>Facebook</span
                  ><input v-model="brandForm.facebook" class="adminput" type="url"
                /></label>
                <label class="fld"
                  ><span>YouTube</span
                  ><input v-model="brandForm.youtube" class="adminput" type="url"
                /></label>
                <label class="fld"
                  ><span>GitHub</span
                  ><input
                    v-model="brandForm.github"
                    class="adminput"
                    type="url"
                    placeholder="https://github.com/…"
                /></label>
                <label class="fld"
                  ><span>WhatsApp</span
                  ><input
                    v-model="brandForm.whatsapp"
                    class="adminput"
                    type="url"
                    placeholder="https://wa.me/569…"
                /></label>
                <label class="fld"
                  ><span>Sitio web</span
                  ><input
                    v-model="brandForm.website"
                    class="adminput"
                    type="url"
                    placeholder="https://…"
                /></label>
                <label class="fld"
                  ><span>App Store (firma Cleverty)</span
                  ><input
                    v-model="brandForm.appStoreUrl"
                    class="adminput"
                    type="url"
                    placeholder="https://apps.apple.com/…"
                /></label>
                <label class="fld"
                  ><span>Google Play (firma Cleverty)</span
                  ><input
                    v-model="brandForm.googlePlayUrl"
                    class="adminput"
                    type="url"
                    placeholder="https://play.google.com/…"
                /></label>
              </div>
              <label class="fld check2">
                <input v-model="brandForm.lockAccentColor" type="checkbox" />
                {{ t('admin.branding.lockAccent') }}
              </label>
              <p class="hint">{{ t('admin.branding.lockAccentHint') }}</p>

              <div class="actions">
                <button class="btn-primary" :disabled="brandSaving" @click="saveBranding">
                  {{ brandSaving ? t('admin.saving') : t('admin.save') }}
                </button>
                <span v-if="brandSaved" class="ok-text">{{ t('admin.saved') }}</span>
                <span v-if="brandError" class="err-text">{{ brandError }}</span>
              </div>
            </div>
          </div>

          <!-- ===================== FIRMAS (política) ===================== -->
          <div v-else-if="tab === 'signatures'" class="card">
            <AdminSignaturePolicy />
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
                v-if="
                  selected === 's3' && !s3.useInstanceRole && tested !== 'ok' && !s3Incomplete()
                "
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

            <!-- F6: cuota por defecto + uso por cuenta -->
            <div class="storage-extra">
              <div class="quota-default">
                <label class="fld-lbl">{{ t('admin.storage.defaultQuota') }}</label>
                <div class="quota-row">
                  <input
                    v-model.number="defaultQuotaMb"
                    type="number"
                    min="0"
                    class="adminput sm"
                  />
                  <span class="mb">MB</span>
                  <button
                    class="btn-secondary"
                    :disabled="defQuotaSaving"
                    @click="saveStorageDefaults"
                  >
                    {{ defQuotaSaving ? t('admin.saving') : t('admin.apply') }}
                  </button>
                  <span v-if="defQuotaSaved" class="ok-text">{{ t('admin.saved') }}</span>
                </div>
                <p class="hint">{{ t('admin.storage.defaultQuotaHint') }}</p>
              </div>

              <div class="usage-panel">
                <h3 class="usage-h">{{ t('admin.storage.usageByAccount') }}</h3>
                <div v-for="a in accounts" :key="a.id" class="usage-item">
                  <div class="usage-top">
                    <span class="usage-name">{{ a.displayName }}</span>
                    <span class="usage-val">
                      {{ fmtBytes(a.usedBytes) }} /
                      {{
                        a.quotaBytes > 0 ? fmtBytes(a.quotaBytes) : t('admin.accounts.unlimited')
                      }}
                    </span>
                  </div>
                  <div
                    class="usage-bar"
                    :class="{ unlimited: a.quotaBytes <= 0 }"
                    role="progressbar"
                    :aria-valuenow="usagePct(a)"
                    aria-valuemin="0"
                    aria-valuemax="100"
                  >
                    <span
                      class="usage-fill"
                      :class="{ warn: usagePct(a) >= 90 }"
                      :style="{ width: usagePct(a) + '%' }"
                    />
                  </div>
                </div>
                <p v-if="accounts.length === 0" class="muted">{{ t('admin.accounts.empty') }}</p>
              </div>
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
.admin-navscroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 8px;
}
.admin-navgroup {
  margin-top: 12px;
}
.admin-navgroup:first-child {
  margin-top: 2px;
}
.admin-navgroup-label {
  margin: 0 0 4px;
  padding: 0 12px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-3);
}
.admin-navlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.admin-navitem {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 12px;
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
.admin-navitem :deep(svg) {
  flex-shrink: 0;
}
/* Sólo el <span> de la etiqueta debe crecer. Excluir `.app-icon` (el root de AppIcon ahora es un
   <span>, no un <svg>): sin esto el icono recibía flex:1 y ocupaba media fila (gap enorme antes del
   texto). Regresión hallada por review externo B tras la migración a FA duotone. */
.admin-navitem > span:not(.admin-navcount):not(.app-icon) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.admin-navitem:hover {
  background: var(--hover);
  color: var(--text-1);
}
.admin-navitem.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.admin-navitem.active :deep(svg) {
  color: var(--accent);
}
.admin-navitem:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.admin-navcount {
  flex-shrink: 0;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--surface-dim);
  border: 1px solid var(--border);
  color: var(--text-3);
  font-size: 11.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}
.admin-navitem.active .admin-navcount {
  background: var(--surface);
  border-color: transparent;
  color: var(--accent-ink);
}
.admin-nav-foot {
  padding: 12px;
  border-top: 1px solid var(--border);
}
.admin-verchip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-dim);
}
.admin-verchip :deep(svg) {
  color: var(--accent);
  flex-shrink: 0;
}
.admin-verchip-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}
.admin-verchip-text .bi-app {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-1);
}
.admin-verchip-text .bi-dim {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* ---- Estado de actualización (compacto, en el footer del sidebar) ---- */
.bi-update {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.bi-update .bi-uptodate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-2);
}
.bi-update-yes {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  margin-bottom: 12px;
}
.ub-btn-sm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 7px;
  border: none;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.ub-btn-sm:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ub-link-sm {
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
  font-size: 11.5px;
}
.bi-check-link {
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 11.5px;
  padding: 0;
}
.bi-check-link:disabled {
  opacity: 0.6;
  cursor: default;
}
.ub-msg-sm {
  font-size: 11.5px;
  color: var(--text-2);
  margin: 0 0 10px;
  line-height: 1.4;
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
/* Preview del estilo de iconos: muestra en vivo el weight elegido (usa el color de acento). */
.icon-style-preview {
  display: flex;
  gap: 14px;
  align-items: center;
  color: var(--accent);
  margin-top: 8px;
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
  color: var(--green);
  background: var(--green-soft);
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
  color: var(--green);
  font-weight: 600;
}
.err-text {
  font-size: 13.5px;
  color: var(--danger);
}
.warn-text {
  font-size: 12px;
  color: var(--amber);
  margin: 8px 0 0;
}
.current {
  font-size: 12px;
  color: var(--text-3);
  margin: 8px 0 0;
}
/* ---- F6: defaults + uso ---- */
.storage-extra {
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.quota-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.usage-h {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3);
  margin: 0 0 12px;
}
.usage-item {
  margin-bottom: 14px;
}
.usage-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  margin-bottom: 5px;
}
.usage-name {
  font-weight: 600;
  color: var(--text-1);
}
.usage-val {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.usage-bar {
  height: 8px;
  border-radius: 999px;
  background: var(--surface-dim);
  overflow: hidden;
}
.usage-bar.unlimited {
  background: repeating-linear-gradient(
    90deg,
    var(--surface-dim),
    var(--surface-dim) 6px,
    var(--hover) 6px,
    var(--hover) 12px
  );
}
.usage-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.3s;
}
.usage-fill.warn {
  background: var(--danger);
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
  color: var(--green);
  background: var(--green-soft);
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
  max-width: 620px;
}
.brand-subhead {
  margin: 8px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
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

/* ============ USUARIOS: tabla rica (avatar + rol + estado + uso) — maqueta admin.html ============ */
.users-card {
  padding: 6px 6px;
}
.create-card {
  margin-bottom: 16px;
}
.user-table {
  display: flex;
  flex-direction: column;
}
.user-thead,
.user-row {
  display: grid;
  grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.6fr) 28px;
  align-items: center;
  gap: 12px;
}
.user-thead {
  padding: 8px 16px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
}
.user-row {
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: background 0.12s;
}
.user-row:last-child {
  border-bottom: none;
}
.user-row:hover {
  background: var(--hover);
}
.user-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  border-radius: 8px;
}
.user-row.dim {
  opacity: 0.6;
}
.ucell {
  min-width: 0;
}
.ucell-user {
  display: flex;
  align-items: center;
  gap: 12px;
}
.uavatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.uinfo {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.uname {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uemail {
  font-size: 12.5px;
  color: var(--text-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ucell-storage {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ustorage-text {
  font-size: 12.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.ucell-chev {
  display: flex;
  justify-content: flex-end;
  color: var(--text-3);
}
.empty-row {
  padding: 40px 16px;
}

/* Badge de rol */
.role-badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.role-badge.admin {
  background: color-mix(in srgb, var(--red) 14%, var(--surface));
  color: var(--red);
}
.role-badge.custom {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.role-badge.plain {
  background: var(--surface-dim);
  color: var(--text-2);
  border: 1px solid var(--border);
}

/* Estado con punto de color */
.status-dot {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.status-dot i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
}
.status-dot.active {
  color: var(--green);
}
.status-dot.active i {
  background: var(--green);
}
.status-dot.disabled {
  color: var(--red);
}
.status-dot.disabled i {
  background: var(--red);
}
.status-dot.error {
  color: var(--amber);
}
.status-dot.error i {
  background: var(--amber);
}
.status-dot.syncing {
  color: var(--accent);
}
.status-dot.syncing i {
  background: var(--accent);
}
.unlinked-badge {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--amber) 32%, transparent);
  white-space: nowrap;
}
.import-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 14px;
  border-radius: 12px;
  color: var(--text-1);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-1));
  border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent);
}
.import-banner-text {
  flex: 1;
  font-size: 13.5px;
  line-height: 1.4;
}
.btn-primary.sm {
  padding: 7px 14px;
  font-size: 13px;
  flex-shrink: 0;
}
.pw-reset {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border-1);
}
.pw-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.pw-row .adminput {
  flex: 1;
}
.pw-result {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--text-2);
}
.pw-result code {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
  background: var(--surface-2);
  padding: 8px 12px;
  border-radius: 8px;
  user-select: all;
  word-break: break-all;
}

/* Barra de uso de almacenamiento */
.usage-bar {
  width: 100%;
  height: 8px;
  border-radius: 999px;
  background: var(--surface-dim);
  overflow: hidden;
}
.usage-bar.sm {
  height: 6px;
  max-width: 220px;
}
.usage-bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.3s;
}
.usage-bar > span.warn {
  background: var(--amber);
}
.usage-bar > span.over {
  background: var(--red);
}

/* ============ Ficha de usuario (detalle) ============ */
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  padding: 4px 2px;
  margin-bottom: 14px;
}
.back-link:hover {
  color: var(--accent);
}
.user-detail-grid {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.user-hero {
  padding: 0;
  overflow: hidden;
  text-align: center;
}
.user-hero-band {
  height: 88px;
}
.user-hero-avatar {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  margin: -48px auto 0;
  border: 4px solid var(--surface);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 30px;
  font-weight: 700;
}
.user-hero-name {
  margin: 12px 0 2px;
  font-size: 20px;
  font-weight: 800;
}
.user-hero-email {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.user-hero-badges {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0;
}
.user-hero-meta {
  list-style: none;
  margin: 0;
  padding: 0 22px 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}
.user-hero-meta li {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  color: var(--text-2);
}
.user-hero-meta :deep(svg) {
  color: var(--text-3);
  flex-shrink: 0;
}
.user-detail-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.user-panel h3 {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 700;
}
.role-assign {
  display: flex;
  gap: 10px;
  align-items: center;
}
.role-assign .adminput {
  flex: 1;
}
.storage-line {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.danger-zone {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.btn-ghost {
  padding: 9px 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--hover);
}
.btn-ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-danger {
  padding: 9px 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--red) 40%, var(--border));
  border-radius: 8px;
  background: transparent;
  color: var(--red);
  cursor: pointer;
}
.btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--red) 10%, var(--surface));
}
.btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@media (max-width: 760px) {
  .user-detail-grid {
    grid-template-columns: 1fr;
  }
  .user-thead {
    display: none;
  }
  .user-row {
    grid-template-columns: 1fr auto;
    grid-template-areas: 'user chev' 'role role' 'status status' 'storage storage';
    gap: 8px;
  }
  .ucell-user {
    grid-area: user;
  }
  .ucell-role {
    grid-area: role;
  }
  .ucell-status {
    grid-area: status;
  }
  .ucell-storage {
    grid-area: storage;
  }
  .ucell-chev {
    grid-area: chev;
  }
  .usage-bar.sm {
    max-width: none;
  }
}
</style>
