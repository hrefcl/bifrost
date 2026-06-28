<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/layouts/AppLayout.vue';
import AppIcon from '@/components/AppIcon.vue';
import AppAvatar from '@/components/AppAvatar.vue';
import { api } from '@/lib/http';
import { useUiStore } from '@/stores/ui';
import { useComposerStore } from '@/stores/composer';
import { colorFor } from '@/lib/people';
import { buildEmailPrintHtml } from '@/lib/print-email';
import type {
  Folder,
  Email,
  Account,
  EmailBody,
  EmailAttachmentMeta,
  SpecialUse,
} from '@webmail6/shared';

const ui = useUiStore();
const composer = useComposerStore();
const { t, locale } = useI18n();

const accounts = ref<Account[]>([]);
const folders = ref<Folder[]>([]);
const emails = ref<Email[]>([]);
const selectedFolderId = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const category = ref<'primary' | 'updates' | 'promotions'>('primary');

// Filtro de la lista visible (estilo Gmail): todos / no leídos / destacados / con adjuntos.
type ListFilter = 'all' | 'unread' | 'starred' | 'attachments';
const listFilter = ref<ListFilter>('all');
const LIST_FILTERS: { key: ListFilter; label: string; icon: string }[] = [
  { key: 'all', label: 'list.filterAll', icon: 'mail' },
  { key: 'unread', label: 'list.filterUnread', icon: 'dot' },
  { key: 'starred', label: 'list.filterStarred', icon: 'star' },
  { key: 'attachments', label: 'list.filterAttachments', icon: 'paperclip' },
];
// Predicado del filtro (client-side). En carpetas reales el backend ya filtró (server-side), así que
// aquí es idempotente; es el que filtra las vistas client-only: búsqueda y Pospuestos/Destacados.
function matchesListFilter(e: Email): boolean {
  if (listFilter.value === 'unread') return !e.flags.seen;
  if (listFilter.value === 'starred') return e.flags.flagged;
  if (listFilter.value === 'attachments') return e.hasAttachments;
  return true;
}

const selected = ref<Email | null>(null);
const body = ref<EmailBody | null>(null);
const attachments = ref<EmailAttachmentMeta[]>([]);
const bodyLoading = ref(false);

// ---- Set estándar estilo Gmail: SIEMPRE visible, mapeado a la carpeta real si existe ----
interface StdItem {
  key: string;
  icon: string;
  special?: SpecialUse;
  virtual?: 'starred' | 'snoozed';
}
const STANDARD: StdItem[] = [
  { key: 'inbox', icon: 'inbox', special: 'inbox' },
  { key: 'starred', icon: 'star', virtual: 'starred' },
  { key: 'snoozed', icon: 'clock', virtual: 'snoozed' },
  { key: 'sent', icon: 'send', special: 'sent' },
  { key: 'drafts', icon: 'file', special: 'drafts' },
  { key: 'archive', icon: 'archive', special: 'archive' },
  { key: 'spam', icon: 'shield', special: 'junk' },
  { key: 'trash', icon: 'trash', special: 'trash' },
];
const STD_LABEL: Record<string, string> = {
  inbox: 'folders.inbox',
  starred: 'folders.starred',
  snoozed: 'folders.snoozed',
  sent: 'folders.sent',
  drafts: 'folders.drafts',
  archive: 'folders.archive',
  spam: 'folders.spam',
  trash: 'folders.trash',
};

const selectedKey = ref('inbox');
const virtualView = ref<'starred' | 'snoozed' | null>(null);

function folderForSpecial(special?: SpecialUse): Folder | undefined {
  return special ? folders.value.find((f) => f.specialUse === special) : undefined;
}
function stdCount(item: StdItem): number {
  if (item.virtual) return 0;
  return folderForSpecial(item.special)?.unseenMessages ?? 0;
}

// Etiquetas = carpetas IMAP sin specialUse (las "labels" de Gmail).
const labelFolders = computed(() => folders.value.filter((f) => !f.specialUse));

// ---- Búsqueda server-side global (estilo Gmail; Enter en la barra) ----
const searchResults = ref<Email[] | null>(null);
const searchActiveQuery = ref('');
const searching = ref(false);
const inSearch = computed(() => searchResults.value !== null);

const isInbox = computed(() => selectedKey.value === 'inbox' && !inSearch.value);
const currentTitle = computed(() => {
  if (inSearch.value) return t('list.searchResultsFor', { q: searchActiveQuery.value });
  const std = STANDARD.find((s) => s.key === selectedKey.value);
  if (std) return t(STD_LABEL[std.key]);
  return labelFolders.value.find((f) => f.id === selectedKey.value)?.displayName ?? '';
});

// Filtro en cliente de la carpeta actual (mientras se tipea) + vistas virtuales.
const filteredEmails = computed(() => {
  let list = emails.value; // Pospuestos: emails.value ya viene de GET /emails/snoozed
  if (virtualView.value === 'starred') list = list.filter((e) => e.flags.flagged);
  // Filtro de la barra de la lista (server-side en carpetas; client-side aquí para vistas virtuales).
  if (listFilter.value !== 'all') list = list.filter(matchesListFilter);
  const q = ui.searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (e) =>
        (e.from.name ?? '').toLowerCase().includes(q) ||
        e.from.address.toLowerCase().includes(q) ||
        e.subject.toLowerCase().includes(q) ||
        (e.preview ?? '').toLowerCase().includes(q)
    );
  }
  if (selectedKey.value === 'inbox' && category.value !== 'primary') return [];
  return list;
});

// Lo que se muestra: resultados globales de búsqueda (si hay) o los de la carpeta. El filtro de
// lista también se aplica a la búsqueda (client-side sobre los ≤50 resultados — review B+D).
const displayedEmails = computed(() => {
  if (!inSearch.value) return filteredEmails.value;
  const results = searchResults.value ?? [];
  return listFilter.value === 'all' ? results : results.filter(matchesListFilter);
});

// Token de cancelación: una búsqueda vieja no debe pisar la carpeta/búsqueda actual ni
// reactivar el modo búsqueda tras salir (review B+D).
let searchToken = 0;
// IDs eliminados/movidos/pospuestos durante una búsqueda EN VUELO. searchToken evita que una
// búsqueda vieja pise una nueva, pero NO que la respuesta de la búsqueda actual reinserte un
// email que se quitó mientras estaba pendiente (race real de UI — review B). Filtramos la
// respuesta contra este set para que nunca reviva un elemento ya removido.
const removedIds = new Set<string>();
// Acciones mutadoras en vuelo por email-id: evita que un doble-click dispare la acción dos veces
// (p.ej. dos POST /unsnooze que sumarían +2 al badge, o dos delete/move). Review B+D.
const actionInFlight = new Set<string>();
async function runSearch(q: string) {
  const token = ++searchToken;
  removedIds.clear();
  searching.value = true;
  selected.value = null;
  searchActiveQuery.value = q;
  try {
    const { data } = await api.get<{ data: Email[] }>('/emails/search', { params: { q } });
    if (token === searchToken) {
      searchResults.value = data.data.filter((e) => !removedIds.has(e.id));
    }
  } catch {
    if (token === searchToken) searchResults.value = [];
  } finally {
    if (token === searchToken) searching.value = false;
  }
}
function exitSearch() {
  searchToken++; // invalida cualquier búsqueda en vuelo
  searchResults.value = null;
  searchActiveQuery.value = '';
}

/** Saca un email de la lista visible (carpeta Y resultados de búsqueda) tras eliminar/mover/snooze. */
function removeFromLists(id: string) {
  removedIds.add(id); // que una búsqueda en vuelo no lo reinserte al volver (review B).
  emails.value = emails.value.filter((e) => e.id !== id);
  if (searchResults.value) searchResults.value = searchResults.value.filter((e) => e.id !== id);
  if (selected.value?.id === id) selected.value = null;
}

/**
 * Refresca los badges de no-leídos desde el BACKEND (fuente autoritativa, ya consciente de snooze)
 * tras una acción que cambia el conteo. Reemplaza el ajuste local por-delta, que era frágil ante
 * concurrencia: snapshots `wasInBadge` capturados antes de un await podían quedar obsoletos si
 * `openEmail` marcaba leído en paralelo → doble ajuste (review B). Aquí el backend recalcula la
 * verdad; un token descarta respuestas viejas y el debounce coalesce ráfagas (leer varios emails
 * seguidos = una sola petición). Sólo se mezcla `unseenMessages` para no pisar el resto del folder.
 */
let badgeTimer: ReturnType<typeof setTimeout> | null = null;
let badgeToken = 0;
let disposed = false; // el componente se desmontó: no aplicar resultados en vuelo (review B).
async function refreshBadges() {
  const id = accountId();
  if (!id) return;
  const token = ++badgeToken;
  try {
    const { data } = await api.get<Folder[]>(`/accounts/${id}/folders`);
    if (disposed || token !== badgeToken) return; // desmontado o llegó una más nueva.
    const byId = new Map(data.map((f) => [f.id, f.unseenMessages]));
    folders.value.forEach((f) => {
      const n = byId.get(f.id);
      if (n !== undefined) f.unseenMessages = n;
    });
  } catch {
    /* badge queda como estaba; se corrige en el próximo refresh/sync. */
  }
}
function scheduleBadgeRefresh() {
  if (disposed) return;
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => void refreshBadges(), 400);
}

/** ¿El email está pospuesto AHORA (snoozedUntil futuro)? Gobierna el botón Recuperar/Unsnooze. */
function isSnoozedNow(email: Email): boolean {
  return email.snoozedUntil ? new Date(email.snoozedUntil).getTime() > Date.now() : false;
}
const selectedSnoozed = computed(() => (selected.value ? isSnoozedNow(selected.value) : false));
// Enter en la barra → búsqueda global. Vaciar la barra → salir del modo búsqueda.
watch(
  () => ui.searchSubmitNonce,
  () => {
    const q = ui.searchQuery.trim();
    if (q) void runSearch(q);
    else exitSearch();
  }
);
watch(
  () => ui.searchQuery,
  (v) => {
    if (!v.trim() && inSearch.value) exitSearch();
  }
);

// ---- Almacenamiento (barra del sidebar; usedBytes REAL = bytes de adjuntos del usuario) ----
const storage = ref<{ usedBytes: number; limitBytes: number } | null>(null);
const storagePct = computed(() =>
  storage.value && storage.value.limitBytes > 0
    ? Math.min(100, (storage.value.usedBytes / storage.value.limitBytes) * 100)
    : 0
);
function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function accountId(): string {
  return accounts.value[0]?.id ?? '';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale.value, { day: '2-digit', month: 'short' });
}
function fmtFull(iso: string): string {
  return new Date(iso).toLocaleString(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function loadAccountsAndFolders() {
  try {
    const { data } = await api.get<Account[]>('/accounts');
    accounts.value = data;
    if (data.length > 0) await loadFolders(data[0].id);
    void loadStorage();
  } catch {
    error.value = t('errors.accounts');
  }
}

async function loadFolders(id: string) {
  try {
    const { data } = await api.get<Folder[]>(`/accounts/${id}/folders`);
    folders.value = data;
    await selectStandard(STANDARD[0]); // Recibidos por defecto
  } catch {
    error.value = t('errors.folders');
  }
}

async function loadStorage() {
  try {
    const { data } = await api.get<{ usedBytes: number; limitBytes: number }>('/accounts/storage');
    storage.value = data;
  } catch {
    storage.value = null;
  }
}

async function selectFolder(folderId: string) {
  selectedFolderId.value = folderId;
  selected.value = null;
  category.value = 'primary';
  // NO se resetea listFilter aquí: el reset es responsabilidad de la navegación (selectStandard/
  // selectLabel). Así un sync (que llama selectFolder) preserva el filtro, y el filtro se aplica
  // server-side en el fetch (review B+D: client-side sólo veía la página cargada).
  loading.value = true;
  try {
    const params = listFilter.value !== 'all' ? { filter: listFilter.value } : undefined;
    const { data } = await api.get<{ data: Email[] }>(
      `/accounts/${accountId()}/folders/${folderId}/emails`,
      { params }
    );
    emails.value = data.data;
  } catch {
    error.value = t('errors.emails');
  } finally {
    loading.value = false;
  }
}

/** Selecciona un ítem estándar del sidebar: carpeta real o vista virtual (Destacados/Pospuestos). */
async function selectStandard(item: StdItem) {
  if (inSearch.value) {
    ui.searchQuery = '';
    exitSearch();
  }
  selectedKey.value = item.key;
  selected.value = null;
  listFilter.value = 'all'; // el filtro de lista no persiste entre carpetas
  if (item.virtual) {
    virtualView.value = item.virtual;
    selectedFolderId.value = null;
    if (item.virtual === 'starred') {
      const inbox = folderForSpecial('inbox');
      if (inbox) await selectFolder(inbox.id);
      else emails.value = [];
    } else {
      // Pospuestos: los emails snoozed del usuario (reaparecen en su carpeta al vencer).
      loading.value = true;
      try {
        const { data } = await api.get<{ data: Email[] }>('/emails/snoozed');
        emails.value = data.data;
      } catch {
        error.value = t('errors.emails');
      } finally {
        loading.value = false;
      }
    }
  } else {
    virtualView.value = null;
    const f = folderForSpecial(item.special);
    if (f) await selectFolder(f.id);
    else {
      selectedFolderId.value = null;
      emails.value = [];
    }
  }
}

/** Selecciona una etiqueta (carpeta IMAP sin specialUse). */
async function selectLabel(f: Folder) {
  if (inSearch.value) {
    ui.searchQuery = '';
    exitSearch();
  }
  selectedKey.value = f.id;
  virtualView.value = null;
  listFilter.value = 'all'; // el filtro no persiste al cambiar de carpeta (reset antes del fetch)
  await selectFolder(f.id);
}

let openToken = 0;
async function openEmail(email: Email) {
  const token = ++openToken;
  selected.value = email;
  body.value = null;
  attachments.value = [];
  bodyLoading.value = true;
  try {
    const bodyRes = await api.get<EmailBody>(`/emails/${email.id}/body`);
    if (token !== openToken) return;
    body.value = bodyRes.data;
    attachments.value = bodyRes.data.attachments ?? [];
    if (!email.flags.seen) {
      // Marca leído optimista (row instantánea) con rollback si el PATCH falla. El badge lo recalcula
      // el backend vía refreshBadges() — sin deltas locales, sin carreras de conteo (review B).
      email.flags.seen = true;
      scheduleBadgeRefresh();
      void api.patch(`/emails/${email.id}/flags`, { seen: true }).catch(() => {
        email.flags.seen = false;
        scheduleBadgeRefresh();
      });
    }
  } catch {
    if (token === openToken) error.value = t('errors.body');
  } finally {
    if (token === openToken) bodyLoading.value = false;
  }
}

// Guard de estrella SEPARADO de actionInFlight: destacar no remueve el email, así que no debe
// bloquear un delete/move/snooze inmediato sobre el mismo id (review B) — sólo evita dos PATCH
// de estrella con valores opuestos por doble-click.
const starInFlight = new Set<string>();
async function toggleStar(email: Email, ev?: Event) {
  ev?.stopPropagation();
  const id = email.id;
  if (starInFlight.has(id)) return;
  starInFlight.add(id);
  const next = !email.flags.flagged;
  email.flags.flagged = next;
  try {
    await api.patch(`/emails/${id}/flags`, { flagged: next });
  } catch {
    email.flags.flagged = !next; // rollback
  } finally {
    starInFlight.delete(id);
  }
}

async function downloadAttachment(att: EmailAttachmentMeta) {
  if (!selected.value) return;
  const res = await api.get<Blob>(`/emails/${selected.value.id}/attachments/${att.id}`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = att.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

async function deleteEmail(email: Email | null, ev?: Event) {
  ev?.stopPropagation();
  if (!email) return;
  const id = email.id;
  if (actionInFlight.has(id)) return;
  actionInFlight.add(id);
  try {
    await api.delete(`/emails/${id}`);
    removeFromLists(id);
    scheduleBadgeRefresh(); // si era no-leído, el backend recalcula el badge.
  } catch {
    error.value = t('errors.delete');
  } finally {
    actionInFlight.delete(id);
  }
}

/** Mover/archivar (Gmail): mueve el email a una carpeta por specialUse y lo saca de la lista. */
async function doMove(
  email: Email | null,
  payload: { specialUse: SpecialUse } | { folderId: string },
  ev?: Event
) {
  ev?.stopPropagation();
  if (!email) return;
  const id = email.id;
  if (actionInFlight.has(id)) return;
  actionInFlight.add(id);
  try {
    await api.post(`/emails/${id}/move`, payload);
    removeFromLists(id);
    scheduleBadgeRefresh(); // si era no-leído, sale de la carpeta origen → backend recalcula.
  } catch {
    error.value = t('errors.move');
  } finally {
    actionInFlight.delete(id);
  }
}
function moveEmail(email: Email | null, specialUse: SpecialUse, ev?: Event) {
  return doMove(email, { specialUse }, ev);
}
function archive(email: Email | null, ev?: Event) {
  void moveEmail(email, 'archive', ev);
}

// ---- Mover a (carpeta/etiqueta, estilo Gmail "Mover a"): en IMAP/Roundcube las etiquetas SON
// carpetas. Destinos = Recibidos + carpetas-etiqueta, EXCLUYENDO la carpeta actual del email (mover
// a la misma sería un no-op del backend pero el front lo sacaría de la vista — review B; además
// incluir Recibidos da el camino de vuelta — review D). El menú es honesto: MUEVE, no etiqueta
// no-destructivamente (el modelo IMAP-carpeta no soporta multi-etiqueta).
const showLabelMenu = ref(false);
const moveTargets = computed(() => {
  const currentId = selected.value?.folderId;
  return folders.value.filter(
    (f) => (f.specialUse === 'inbox' || !f.specialUse) && f.id !== currentId
  );
});
function toggleLabelMenu() {
  showFilterMenu.value = false; // sólo un popover abierto a la vez (review B/D)
  if (moveTargets.value.length > 0) showLabelMenu.value = !showLabelMenu.value;
}

// ---- Filtro de la lista ----
const showFilterMenu = ref(false);
function toggleFilterMenu() {
  showLabelMenu.value = false; // sólo un popover abierto a la vez
  showFilterMenu.value = !showFilterMenu.value;
}
function setListFilter(v: ListFilter) {
  if (v === listFilter.value) {
    showFilterMenu.value = false;
    return;
  }
  listFilter.value = v;
  showFilterMenu.value = false;
  // En carpeta real, re-consultar server-side (filtra TODA la carpeta, no sólo la página cargada).
  // En vistas virtuales (Pospuestos/Destacados) y búsqueda, el filtro se aplica client-side sobre
  // la lista ya cargada (acotada).
  if (selectedFolderId.value && !virtualView.value && !inSearch.value) {
    void selectFolder(selectedFolderId.value);
  }
}
/** Mueve el email a la carpeta/etiqueta elegida (owner-bound en el backend, por folderId). */
function applyLabel(email: Email | null, folderId: string) {
  showLabelMenu.value = false;
  void doMove(email, { folderId });
}

// ---- Posponer (snooze, estilo Gmail) ----
const showSnooze = ref(false);
const snoozeTarget = ref<Email | null>(null);
const customSnooze = ref('');

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function presetLaterToday(): Date {
  const d = new Date();
  d.setHours(d.getHours() + 3, 0, 0, 0);
  return d;
}
function presetTomorrow(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}
function presetNextWeek(): Date {
  const d = new Date();
  const add = (1 - d.getDay() + 7) % 7 || 7; // próximo lunes
  d.setDate(d.getDate() + add);
  d.setHours(8, 0, 0, 0);
  return d;
}
function openSnooze(email: Email | null) {
  if (!email) return;
  snoozeTarget.value = email;
  customSnooze.value = toLocalInput(presetTomorrow());
  showSnooze.value = true;
}
async function doSnooze(until: Date) {
  const email = snoozeTarget.value;
  // Guard de fecha inválida (datetime-local vacío → Invalid Date → NaN) y pasada (review B+D).
  if (!email || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    if (email && (Number.isNaN(until.getTime()) || until.getTime() <= Date.now())) {
      error.value = t('errors.snooze');
    }
    return;
  }
  showSnooze.value = false;
  snoozeTarget.value = null;
  const id = email.id;
  if (actionInFlight.has(id)) return; // anti doble-submit.
  actionInFlight.add(id);
  try {
    await api.post(`/emails/${id}/snooze`, { until: until.toISOString() });
    removeFromLists(id);
    scheduleBadgeRefresh(); // pospuesto = oculto de la carpeta → backend recalcula el badge.
  } catch {
    error.value = t('errors.snooze');
  } finally {
    actionInFlight.delete(id);
  }
}
/** Recuperar (unsnooze, estilo Gmail): saca el email de Pospuestos y lo devuelve a su carpeta YA. */
async function doUnsnooze(email: Email | null, ev?: Event) {
  ev?.stopPropagation();
  if (!email) return;
  const id = email.id;
  if (actionInFlight.has(id)) return; // anti doble-click.
  actionInFlight.add(id);
  try {
    await api.post(`/emails/${id}/unsnooze`);
    removeFromLists(id); // sale de la lista de Pospuestos
    scheduleBadgeRefresh(); // vuelve a su carpeta → backend recalcula el badge (snooze-aware).
  } catch {
    error.value = t('errors.unsnooze');
  } finally {
    actionInFlight.delete(id);
  }
}

function compose() {
  composer.openComposer();
}
function reply() {
  if (selected.value) composer.openComposer({ replyTo: selected.value.id });
}
function replyAll() {
  if (selected.value) composer.openComposer({ replyAll: selected.value.id });
}
function forward() {
  if (selected.value) composer.openComposer({ forward: selected.value.id });
}

const senderName = (e: Email) => (e.from.name?.trim() ? e.from.name : e.from.address);

/** Imprime el email abierto (estilo Gmail): abre una ventana con el mensaje y lanza el diálogo de
 *  impresión. Cabeceras escapadas; el cuerpo usa el sanitizedHtml ya saneado por el backend. */
function printEmail() {
  const email = selected.value;
  if (!email || !body.value) return; // requiere el cuerpo cargado (no imprimir un mensaje vacío)
  const html = buildEmailPrintHtml({
    subject: email.subject || t('thread.noSubject'),
    fromName: senderName(email),
    fromAddress: email.from.address,
    toLabel: t('thread.to', { name: t('thread.me') }),
    dateText: fmtFull(email.date),
    sanitizedHtml: body.value.sanitizedHtml,
    text: body.value.text,
  });
  // iframe oculto con srcdoc (sin document.write deprecado, sin popup-blocker). SANDBOX sin
  // allow-scripts → ningún script del cuerpo se ejecuta aunque sanitize-html tuviera un bypass
  // (el contenido del email es NO confiable); allow-same-origin para que el padre pueda llamar
  // print(); allow-modals para el diálogo. Defensa en profundidad sobre el saneo + CSP (review B+D).
  try {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      iframe.remove();
    };
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        setTimeout(cleanup, 1000);
      }
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
    setTimeout(cleanup, 10_000); // respaldo: si onload no dispara, no dejar el iframe colgado
  } catch {
    error.value = t('errors.print');
  }
}

// ---- Atajos de teclado estilo Gmail (no disparan mientras se escribe en un campo) ----
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && (showLabelMenu.value || showFilterMenu.value)) {
    showLabelMenu.value = false; // Escape cierra los menús (Mover a / Filtro) — review D
    showFilterMenu.value = false;
    return;
  }
  const el = e.target as HTMLElement | null;
  const typing =
    el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true;
  if (typing || e.metaKey || e.ctrlKey || e.altKey || composer.open) return;
  if (e.key === 'c') compose();
  else if (e.key === '/') {
    e.preventDefault();
    ui.focusSearch();
  } else if (selected.value) {
    if (e.key === 'e') archive(selected.value);
    else if (e.key === 'r') reply();
    else if (e.key === '#' || e.key === 'Delete') void deleteEmail(selected.value);
  }
}

// Cierra los menús flotantes al hacer click fuera (los botones/menús usan @click.stop).
function closeMenus() {
  showLabelMenu.value = false;
  showFilterMenu.value = false;
}
onMounted(() => {
  void loadAccountsAndFolders();
  window.addEventListener('keydown', onKey);
  window.addEventListener('click', closeMenus);
});
onBeforeUnmount(() => {
  disposed = true; // descarta refreshBadges() en vuelo (no mutar tras desmontar).
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('click', closeMenus);
  if (badgeTimer) clearTimeout(badgeTimer);
});
</script>

<template>
  <AppLayout>
    <div class="mail">
      <!-- ===== Sidebar ===== -->
      <nav class="sidebar" :class="{ collapsed: ui.sidebarCollapsed }">
        <div class="compose-wrap">
          <button class="compose" @click="compose">
            <AppIcon name="pencil" :size="20" />
            <span v-if="!ui.sidebarCollapsed">{{ t('compose.new') }}</span>
          </button>
        </div>

        <div class="folders">
          <button
            v-for="item in STANDARD"
            :key="item.key"
            class="folder"
            :class="{ active: selectedKey === item.key }"
            :title="t(STD_LABEL[item.key])"
            :aria-label="t(STD_LABEL[item.key])"
            @click="selectStandard(item)"
          >
            <AppIcon
              :name="item.icon"
              :size="19"
              :fill="item.key === 'starred' && selectedKey === 'starred' ? 'currentColor' : 'none'"
            />
            <template v-if="!ui.sidebarCollapsed">
              <span class="folder-name">{{ t(STD_LABEL[item.key]) }}</span>
              <span v-if="stdCount(item) > 0" class="folder-count">{{ stdCount(item) }}</span>
            </template>
          </button>

          <div v-if="!ui.sidebarCollapsed && labelFolders.length" class="labels">
            <div class="section-title">{{ t('folders.labels') }}</div>
            <button
              v-for="f in labelFolders"
              :key="f.id"
              class="folder label"
              :class="{ active: selectedKey === f.id }"
              :aria-label="f.displayName"
              @click="selectLabel(f)"
            >
              <span class="dot" :style="{ background: colorFor(f.name) }" />
              <span class="folder-name">{{ f.displayName }}</span>
              <span v-if="f.unseenMessages > 0" class="folder-count">{{ f.unseenMessages }}</span>
            </button>
          </div>
        </div>

        <!-- Almacenamiento (estilo Gmail) -->
        <div v-if="!ui.sidebarCollapsed && storage" class="storage">
          <div class="storage-top">
            <span>{{ t('storage.title') }}</span>
            <span class="storage-val"
              >{{ fmtBytes(storage.usedBytes) }} / {{ fmtBytes(storage.limitBytes) }}</span
            >
          </div>
          <div class="storage-bar">
            <div class="storage-fill" :style="{ width: storagePct + '%' }" />
          </div>
        </div>
      </nav>

      <!-- ===== Lista ===== -->
      <section class="list-pane" :class="{ narrow: selected }">
        <div class="list-head">
          <h2 class="list-title">{{ currentTitle }}</h2>
          <span class="list-count">{{ t('common.conversations', displayedEmails.length) }}</span>
          <div class="list-actions">
            <button
              class="icon-btn"
              :title="t('list.sync')"
              @click="selectedFolderId && selectFolder(selectedFolderId)"
            >
              <AppIcon name="refresh" :size="18" />
            </button>
            <div class="label-wrap">
              <button
                class="icon-btn"
                :class="{ on: listFilter !== 'all' }"
                :title="t('list.filter')"
                @click.stop="toggleFilterMenu"
              >
                <AppIcon name="filter" :size="18" />
              </button>
              <div v-if="showFilterMenu" class="label-menu" @click.stop>
                <button
                  v-for="f in LIST_FILTERS"
                  :key="f.key"
                  class="label-menu-item"
                  :class="{ sel: listFilter === f.key }"
                  @click="setListFilter(f.key)"
                >
                  <AppIcon :name="f.icon" :size="15" />{{ t(f.label) }}
                  <AppIcon v-if="listFilter === f.key" name="check" :size="14" class="fm-check" />
                </button>
              </div>
            </div>
            <button class="icon-btn" :title="t('common.more')">
              <AppIcon name="more" :size="18" />
            </button>
          </div>
        </div>

        <div v-if="isInbox" class="cats">
          <button
            v-for="c in ['primary', 'updates', 'promotions'] as const"
            :key="c"
            class="cat"
            :class="{ active: category === c }"
            @click="category = c"
          >
            <AppIcon
              :name="c === 'primary' ? 'inbox' : c === 'updates' ? 'bell' : 'tag'"
              :size="17"
            />
            {{ t('list.categories.' + c) }}
          </button>
        </div>

        <div class="rows">
          <p v-if="error" class="msg error">{{ error }}</p>
          <p v-else-if="loading || searching" class="msg">{{ t('common.loading') }}</p>
          <div v-else-if="displayedEmails.length === 0" class="empty">
            <AppIcon name="inbox" :size="48" :stroke-width="1.3" />
            <div>{{ t('list.empty') }}</div>
          </div>
          <div
            v-for="email in displayedEmails"
            v-else
            :key="email.id"
            class="row"
            :class="{ selected: selected?.id === email.id, unread: !email.flags.seen }"
            @click="openEmail(email)"
          >
            <button
              class="star"
              :class="{ on: email.flags.flagged }"
              :title="t('thread.star')"
              @click="toggleStar(email, $event)"
            >
              <AppIcon
                name="star"
                :size="18"
                :fill="email.flags.flagged ? 'var(--star)' : 'none'"
              />
            </button>
            <AppAvatar :name="email.from.name" :email="email.from.address" :size="30" />
            <div class="row-from">{{ senderName(email) }}</div>
            <div class="row-main">
              <span class="row-subject">{{ email.subject || t('thread.noSubject') }}</span>
              <span v-if="email.preview" class="row-preview"> — {{ email.preview }}</span>
            </div>
            <AppIcon v-if="email.hasAttachments" name="paperclip" :size="15" class="row-clip" />
            <div class="row-end">
              <button
                v-if="isSnoozedNow(email)"
                class="icon-btn row-hover"
                :title="t('thread.unsnooze')"
                @click="doUnsnooze(email, $event)"
              >
                <AppIcon name="clock" :size="17" :fill="'var(--accent)'" />
              </button>
              <button
                class="icon-btn row-hover"
                :title="t('thread.archive')"
                @click="archive(email, $event)"
              >
                <AppIcon name="archive" :size="17" />
              </button>
              <button
                class="icon-btn row-hover"
                :title="t('thread.delete')"
                @click="deleteEmail(email, $event)"
              >
                <AppIcon name="trash" :size="17" />
              </button>
              <span class="row-date">{{ fmtDate(email.date) }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ===== Lectura ===== -->
      <section v-if="selected" class="thread-pane">
        <div class="thread-head">
          <button class="icon-btn" :title="t('common.close')" @click="selected = null">
            <AppIcon name="arrowLeft" :size="20" />
          </button>
          <button class="icon-btn" :title="t('thread.archive')" @click="archive(selected)">
            <AppIcon name="archive" :size="20" />
          </button>
          <button class="icon-btn" :title="t('thread.delete')" @click="deleteEmail(selected)">
            <AppIcon name="trash" :size="20" />
          </button>
          <button
            v-if="selectedSnoozed"
            class="icon-btn"
            :title="t('thread.unsnooze')"
            @click="doUnsnooze(selected)"
          >
            <AppIcon name="clock" :size="20" :fill="'var(--accent)'" />
          </button>
          <button v-else class="icon-btn" :title="t('thread.snooze')" @click="openSnooze(selected)">
            <AppIcon name="clock" :size="20" />
          </button>
          <div class="label-wrap">
            <button
              class="icon-btn"
              :title="t('thread.moveTo')"
              :disabled="moveTargets.length === 0"
              @click.stop="toggleLabelMenu"
            >
              <AppIcon name="tag" :size="20" />
            </button>
            <div v-if="showLabelMenu" class="label-menu" @click.stop>
              <div class="label-menu-head">{{ t('thread.moveTo') }}</div>
              <button
                v-for="f in moveTargets"
                :key="f.id"
                class="label-menu-item"
                @click="applyLabel(selected, f.id)"
              >
                <AppIcon :name="f.specialUse === 'inbox' ? 'inbox' : 'tag'" :size="15" />{{
                  f.displayName
                }}
              </button>
            </div>
          </div>
          <div class="spacer" />
          <button
            class="icon-btn"
            :title="t('thread.print')"
            :disabled="!body || bodyLoading"
            @click="printEmail"
          >
            <AppIcon name="printer" :size="20" />
          </button>
          <button class="icon-btn" :title="t('common.more')">
            <AppIcon name="more" :size="20" />
          </button>
        </div>

        <div class="thread-body">
          <div class="thread-subject-row">
            <h1 class="thread-subject">{{ selected.subject || t('thread.noSubject') }}</h1>
            <button
              class="star big"
              :class="{ on: selected.flags.flagged }"
              @click="toggleStar(selected)"
            >
              <AppIcon
                name="star"
                :size="20"
                :fill="selected.flags.flagged ? 'var(--star)' : 'none'"
              />
            </button>
          </div>

          <div class="msg-block">
            <div class="msg-head">
              <AppAvatar :name="selected.from.name" :email="selected.from.address" :size="40" />
              <div class="msg-id">
                <div class="msg-from">
                  <span class="msg-name">{{ senderName(selected) }}</span>
                  <span class="msg-addr">&lt;{{ selected.from.address }}&gt;</span>
                </div>
                <div class="msg-to">{{ t('thread.to', { name: t('thread.me') }) }}</div>
              </div>
              <span class="msg-date">{{ fmtFull(selected.date) }}</span>
              <button class="icon-btn" :title="t('thread.reply')" @click="reply">
                <AppIcon name="reply" :size="18" />
              </button>
            </div>

            <div class="msg-content">
              <p v-if="bodyLoading" class="msg">{{ t('common.loading') }}</p>
              <template v-else-if="body">
                <!-- sanitizedHtml ya viene saneado por el backend (sanitize-html). -->
                <!-- eslint-disable vue/no-v-html -->
                <div
                  v-if="body.sanitizedHtml"
                  class="prose max-w-none dark:prose-invert"
                  v-html="body.sanitizedHtml"
                />
                <!-- eslint-enable vue/no-v-html -->
                <pre v-else class="plain">{{ body.text }}</pre>
              </template>

              <div v-if="attachments.length" class="attachments">
                <div class="att-title">
                  <AppIcon name="paperclip" :size="14" />
                  {{ t('thread.attachments', attachments.length) }}
                </div>
                <div class="att-list">
                  <button
                    v-for="att in attachments"
                    :key="att.id"
                    class="att"
                    @click="downloadAttachment(att)"
                  >
                    <div class="att-icon"><AppIcon name="file" :size="18" /></div>
                    <div class="att-meta">
                      <div class="att-name">{{ att.filename }}</div>
                      <div class="att-size">{{ Math.round(att.size / 1024) }} KB</div>
                    </div>
                    <AppIcon name="download" :size="16" class="att-dl" />
                  </button>
                </div>
              </div>
            </div>

            <div class="reply-bar">
              <button class="btn-secondary" @click="reply">
                <AppIcon name="reply" :size="18" />{{ t('thread.reply') }}
              </button>
              <button class="btn-secondary" @click="replyAll">
                <AppIcon name="replyAll" :size="18" />{{ t('thread.replyAll') }}
              </button>
              <button class="btn-secondary" @click="forward">
                <AppIcon name="forward" :size="18" />{{ t('thread.forward') }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- Modal de posponer (snooze) -->
    <div v-if="showSnooze" class="snooze-overlay" @click.self="showSnooze = false">
      <div class="snooze-modal">
        <div class="snooze-head">
          <h3>{{ t('snooze.title') }}</h3>
          <button class="icon-btn" :title="t('common.close')" @click="showSnooze = false">
            <AppIcon name="x" :size="18" />
          </button>
        </div>
        <button class="snooze-preset" @click="doSnooze(presetLaterToday())">
          <AppIcon name="clock" :size="17" />{{ t('snooze.laterToday') }}
        </button>
        <button class="snooze-preset" @click="doSnooze(presetTomorrow())">
          <AppIcon name="clock" :size="17" />{{ t('snooze.tomorrow') }}
        </button>
        <button class="snooze-preset" @click="doSnooze(presetNextWeek())">
          <AppIcon name="clock" :size="17" />{{ t('snooze.nextWeek') }}
        </button>
        <div class="snooze-custom">
          <span class="snooze-custom-lbl">{{ t('snooze.custom') }}</span>
          <input v-model="customSnooze" type="datetime-local" class="snooze-input" />
          <button class="snooze-go" @click="doSnooze(new Date(customSnooze))">
            {{ t('snooze.action') }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.mail {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

/* ---------- Sidebar ---------- */
.sidebar {
  width: 256px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  padding-top: 8px;
  transition: width 0.18s;
  overflow: hidden;
}
.sidebar.collapsed {
  width: 72px;
}
.compose-wrap {
  padding: 8px 14px 14px;
}
.compose {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  padding: 0 22px 0 16px;
  border-radius: 14px;
  border: none;
  cursor: pointer;
  background: var(--compose-bg);
  color: var(--compose-fg);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.15s;
}
.compose:hover {
  box-shadow: var(--shadow-md);
}
.collapsed .compose {
  width: 48px;
  height: 48px;
  padding: 0;
  border-radius: 50%;
  justify-content: center;
}
.folders {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 12px;
}
.folder {
  display: flex;
  align-items: center;
  gap: 16px;
  width: calc(100% - 8px);
  padding: 0 16px;
  height: 36px;
  border: none;
  border-radius: 0 18px 18px 0;
  cursor: pointer;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
}
.folder:hover {
  background: var(--hover);
}
.folder.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 700;
}
.collapsed .folder {
  width: 48px;
  height: 48px;
  margin: 0 auto;
  padding: 0;
  border-radius: 50%;
  justify-content: center;
}
.folder-name {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.folder-count {
  font-size: 12px;
  font-weight: 700;
  color: inherit;
}
.labels {
  margin-top: 18px;
}
.section-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 0 16px 8px;
}
.folder.label {
  border-radius: 0 18px 18px 0;
  height: 34px;
}
.dot {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  flex-shrink: 0;
}
.storage {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-3);
  flex-shrink: 0;
}
.storage-top {
  display: flex;
  justify-content: space-between;
  margin-bottom: 5px;
}
.storage-val {
  font-weight: 600;
}
.storage-bar {
  height: 5px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
}
.storage-fill {
  height: 100%;
  background: var(--accent);
}

/* ---------- Lista ---------- */
.list-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
}
.list-pane.narrow {
  flex: 0 0 460px;
  max-width: 460px;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.list-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}
.list-count {
  font-size: 12.5px;
  color: var(--text-3);
}
.list-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.cats {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  padding-left: 8px;
}
.cat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 18px;
  height: 44px;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-2);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.cat.active {
  color: var(--accent);
  font-weight: 700;
  border-bottom-color: var(--accent);
}
.rows {
  flex: 1;
  overflow-y: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  min-height: 52px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  background: var(--surface-dim);
  transition: background 0.08s;
}
.row.unread {
  background: var(--surface);
}
.row:hover {
  box-shadow: inset 0 0 0 100vmax color-mix(in srgb, var(--accent) 4%, transparent);
}
.row.selected {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}
.star {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  display: flex;
  color: var(--text-3);
  flex-shrink: 0;
}
.star.on {
  color: var(--star);
}
.row-from {
  width: 168px;
  flex-shrink: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-1);
}
.row.unread .row-from,
.row.unread .row-subject {
  font-weight: 700;
}
.row-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.row-subject {
  font-size: 13.5px;
  color: var(--text-1);
}
.row-preview {
  font-size: 13.5px;
  color: var(--text-2);
}
.row-clip {
  color: var(--text-3);
  flex-shrink: 0;
}
.row-end {
  width: 96px;
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
.row-date {
  font-size: 12.5px;
  color: var(--text-2);
}
.row.unread .row-date {
  color: var(--accent-ink);
  font-weight: 700;
}
.row-hover {
  display: none;
  width: 30px;
  height: 30px;
}
.row:hover .row-hover {
  display: inline-flex;
}
.row:hover .row-date {
  display: none;
}

/* ---------- Lectura ---------- */
.thread-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--surface);
}
.thread-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px 0 14px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.spacer {
  margin-left: auto;
}
.label-wrap {
  position: relative;
  display: inline-flex;
}
.label-menu {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 30;
  margin-top: 4px;
  min-width: 200px;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
}
.label-menu-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-2);
  padding: 4px 8px 6px;
}
.label-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border-radius: 7px;
  font: inherit;
  font-size: 13.5px;
  color: var(--text-1);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}
.label-menu-item:hover {
  background: var(--surface-2, rgba(127, 127, 127, 0.12));
}
.label-menu-item.sel {
  color: var(--accent);
  font-weight: 600;
}
.fm-check {
  margin-left: auto;
  color: var(--accent);
}
.icon-btn.on {
  color: var(--accent);
}
.thread-body {
  flex: 1;
  overflow-y: auto;
}
.thread-subject-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 22px 28px 14px;
}
.thread-subject {
  flex: 1;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.3;
  margin: 0;
}
.star.big {
  padding: 4px;
}
.msg-block {
  padding: 0 0 16px;
}
.msg-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 28px 14px;
}
.msg-id {
  flex: 1;
  min-width: 0;
}
.msg-from {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.msg-name {
  font-weight: 600;
  font-size: 14.5px;
}
.msg-addr {
  font-size: 12.5px;
  color: var(--text-3);
}
.msg-to {
  font-size: 12.5px;
  color: var(--text-3);
}
.msg-date {
  font-size: 12.5px;
  color: var(--text-3);
  white-space: nowrap;
}
.msg-content {
  padding: 0 28px 0 80px;
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--text-1);
}
.plain {
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 14px;
  margin: 0;
}
.attachments {
  margin-top: 16px;
}
.att-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 8px;
}
.att-list {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.att {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface);
  min-width: 180px;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.att:hover {
  background: var(--hover);
}
.att-icon {
  width: 34px;
  height: 34px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 13%, transparent);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}
.att-meta {
  flex: 1;
  min-width: 0;
}
.att-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att-size {
  font-size: 11.5px;
  color: var(--text-3);
}
.att-dl {
  color: var(--text-3);
}
.reply-bar {
  display: flex;
  gap: 10px;
  padding: 8px 28px 28px 80px;
}
.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 18px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
}
.btn-secondary:hover {
  background: var(--hover);
}

/* ---------- compartidos ---------- */
.icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-2);
}
.icon-btn:hover {
  background: var(--hover);
}
.msg {
  padding: 16px;
  font-size: 14px;
  color: var(--text-2);
}
.msg.error {
  color: var(--danger);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--text-3);
  font-size: 14px;
  font-weight: 500;
  padding: 40px;
}

/* ---- Modal de snooze ---- */
.snooze-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 70;
}
.snooze-modal {
  width: 340px;
  max-width: calc(100vw - 32px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  padding: 16px;
}
.snooze-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.snooze-head h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.snooze-preset {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 12px;
  border: none;
  background: transparent;
  border-radius: 9px;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  text-align: left;
}
.snooze-preset:hover {
  background: var(--hover);
}
.snooze-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.snooze-custom-lbl {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.snooze-input {
  flex: 1;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text-1);
  outline: none;
}
.snooze-input:focus {
  border-color: var(--accent);
}
.snooze-go {
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.snooze-go:hover {
  background: var(--accent-700);
}
</style>
