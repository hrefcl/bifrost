<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '@/lib/http';
import type { SchedulingSettings, Booking } from '@webmail6/shared';

/**
 * Panel admin de la Agenda Inteligente (Fase 3.7):
 *  - A1: activar la feature, links públicos, valores por defecto y límites.
 *  - A2: auditoría global de reservas (sólo lectura, filtrable).
 * Todo pasa por /api/admin/scheduling/* (rol admin verificado en el backend).
 */
const settings = ref<SchedulingSettings | null>(null);
const summary = ref<{
  eventTypes: number;
  confirmed: number;
  cancelled: number;
  hostsWithUsername: number;
} | null>(null);
const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [s, sum] = await Promise.all([
      api.get<SchedulingSettings>('/admin/scheduling/settings'),
      api.get<typeof summary.value>('/admin/scheduling/summary'),
    ]);
    settings.value = s.data;
    summary.value = sum.data;
  } catch {
    error.value = 'No se pudo cargar la configuración.';
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!settings.value) return;
  saving.value = true;
  saved.value = false;
  error.value = '';
  try {
    const { data } = await api.patch<SchedulingSettings>('/admin/scheduling/settings', {
      enabled: settings.value.enabled,
      publicLinksEnabled: settings.value.publicLinksEnabled,
      auditEnabled: settings.value.auditEnabled,
      defaults: settings.value.defaults,
      maxEventTypesPerUser: settings.value.maxEventTypesPerUser,
    });
    settings.value = data;
    saved.value = true;
    // Reflejar de inmediato el toggle de auditoría (puede haber quedado habilitada/deshabilitada).
    skip.value = 0;
    await loadAudit();
  } catch {
    error.value = 'No se pudo guardar. Revisa los valores (zona horaria válida, rangos).';
  } finally {
    saving.value = false;
  }
}

// ── Auditoría ──
const bookings = ref<Booking[]>([]);
const auditTotal = ref(0);
const auditStatus = ref<'' | 'confirmed' | 'cancelled' | 'rescheduled'>('');
const auditLoading = ref(false);
const auditDisabled = ref(false);
const skip = ref(0);
const LIMIT = 25;

async function loadAudit() {
  auditLoading.value = true;
  try {
    const params: Record<string, string | number> = { limit: LIMIT, skip: skip.value };
    if (auditStatus.value) params.status = auditStatus.value;
    const { data } = await api.get<{ total: number; bookings: Booking[] }>(
      '/admin/scheduling/bookings',
      { params }
    );
    bookings.value = data.bookings;
    auditTotal.value = data.total;
    auditDisabled.value = false;
  } catch (e) {
    // 403 = auditoría apagada en settings (no es un error real).
    auditDisabled.value = (e as { response?: { status?: number } }).response?.status === 403;
    bookings.value = [];
  } finally {
    auditLoading.value = false;
  }
}

function filterAudit() {
  skip.value = 0;
  void loadAudit();
}
function pageAudit(delta: number) {
  const next = skip.value + delta * LIMIT;
  if (next < 0 || next >= auditTotal.value) return;
  skip.value = next;
  void loadAudit();
}

const statusLabel: Record<string, string> = {
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
  rescheduled: 'Reagendada',
};
function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

onMounted(async () => {
  await load();
  await loadAudit();
});
</script>

<template>
  <div class="sched-admin">
    <div v-if="loading" class="muted">Cargando…</div>
    <template v-else-if="settings">
      <!-- A1: configuración (el header de sección lo pone AdminView; no se duplica acá). -->
      <section class="card">
        <label class="row">
          <input v-model="settings.enabled" type="checkbox" />
          <span><strong>Activar agenda</strong> — habilita descubrimiento y nuevas reservas.</span>
        </label>
        <label class="row">
          <input v-model="settings.publicLinksEnabled" type="checkbox" />
          <span>Links públicos (<code>/u/usuario</code>) habilitados.</span>
        </label>
        <label class="row">
          <input v-model="settings.auditEnabled" type="checkbox" />
          <span>Registrar auditoría de reservas.</span>
        </label>

        <div class="grid">
          <label class="fld">
            <span>Zona horaria por defecto</span>
            <input v-model="settings.defaults.timezone" class="in" placeholder="America/Santiago" />
          </label>
          <label class="fld">
            <span>Duración por defecto (min)</span>
            <input
              v-model.number="settings.defaults.durationMinutes"
              type="number"
              min="5"
              max="480"
              class="in"
            />
          </label>
          <label class="fld">
            <span>Ventana reservable (días)</span>
            <input
              v-model.number="settings.defaults.dateRangeDays"
              type="number"
              min="1"
              max="365"
              class="in"
            />
          </label>
          <label class="fld">
            <span>Máx. tipos por usuario</span>
            <input
              v-model.number="settings.maxEventTypesPerUser"
              type="number"
              min="1"
              max="100"
              class="in"
              placeholder="sin límite"
            />
          </label>
        </div>

        <div class="actions">
          <button class="btn" :disabled="saving" @click="save">
            {{ saving ? 'Guardando…' : 'Guardar' }}
          </button>
          <span v-if="saved" class="ok">Guardado ✓</span>
          <span v-if="error" class="err">{{ error }}</span>
        </div>
      </section>

      <!-- Resumen -->
      <section v-if="summary" class="stats">
        <div class="stat">
          <b>{{ summary.eventTypes }}</b
          ><span>tipos activos</span>
        </div>
        <div class="stat">
          <b>{{ summary.confirmed }}</b
          ><span>confirmadas</span>
        </div>
        <div class="stat">
          <b>{{ summary.cancelled }}</b
          ><span>canceladas</span>
        </div>
        <div class="stat">
          <b>{{ summary.hostsWithUsername }}</b
          ><span>con link público</span>
        </div>
      </section>

      <!-- A2: auditoría -->
      <section class="card">
        <div class="audit-head">
          <h2 class="h">Auditoría de reservas</h2>
          <select v-model="auditStatus" class="in" :disabled="auditDisabled" @change="filterAudit">
            <option value="">Todas</option>
            <option value="confirmed">Confirmadas</option>
            <option value="cancelled">Canceladas</option>
            <option value="rescheduled">Reagendadas</option>
          </select>
        </div>
        <p v-if="auditDisabled" class="muted">
          La auditoría está deshabilitada en la configuración.
        </p>
        <div v-else-if="auditLoading" class="muted">Cargando…</div>
        <table v-else-if="bookings.length" class="tbl">
          <thead>
            <tr>
              <th>Inicio</th>
              <th>Reunión</th>
              <th>Invitado</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in bookings" :key="b.id">
              <td>{{ fmt(b.startAt) }}</td>
              <td>{{ b.snapshot.title }}</td>
              <td>
                {{ b.invitee.name }}<br /><small class="muted">{{ b.invitee.email }}</small>
              </td>
              <td>
                <span class="badge" :class="b.status">{{ statusLabel[b.status] ?? b.status }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">Sin reservas para el filtro.</p>
        <div v-if="auditTotal > LIMIT" class="pager">
          <button class="btn-ghost" :disabled="skip === 0" @click="pageAudit(-1)">
            ‹ Anterior
          </button>
          <span class="muted"
            >{{ skip + 1 }}–{{ Math.min(skip + LIMIT, auditTotal) }} de {{ auditTotal }}</span
          >
          <button class="btn-ghost" :disabled="skip + LIMIT >= auditTotal" @click="pageAudit(1)">
            Siguiente ›
          </button>
        </div>
      </section>
    </template>
    <p v-else class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
.sched-admin {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* Alineado al design-system del admin (AdminView): card/input/botón/campo consistentes. */
.card {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 14px;
  padding: 24px;
  box-shadow: var(--shadow-sm);
}
.h {
  margin: 0 0 2px;
  font-size: 18px;
}
.desc {
  margin: 0 0 14px;
  color: var(--text-3, #8a8a8a);
}
.muted {
  color: var(--text-3, #8a8a8a);
}
.row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 10px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin: 16px 0;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.in {
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
.in:focus {
  border-color: var(--accent);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding-top: 6px;
}
.btn {
  padding: 9px 20px;
  font-size: 14px;
  font-weight: 600;
  background: var(--accent, #1b66ff);
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: var(--accent-700);
}
.btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.btn-ghost {
  background: transparent;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  cursor: pointer;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--hover);
}
.btn-ghost:disabled {
  opacity: 0.55;
  cursor: default;
}
.ok {
  color: #1e7e34;
}
.err {
  color: #c0392b;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}
.stat {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 12px;
  padding: 16px;
  text-align: center;
}
.stat b {
  display: block;
  font-size: 24px;
}
.stat span {
  color: var(--text-3, #8a8a8a);
  font-size: 13px;
}
.audit-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.tbl th,
.tbl td {
  text-align: left;
  padding: 10px;
  border-bottom: 1px solid var(--border, #eee);
  vertical-align: top;
}
.badge {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.badge.confirmed {
  background: #e6f4ea;
  color: #1e7e34;
}
.badge.cancelled {
  background: #fdecea;
  color: #c0392b;
}
.badge.rescheduled {
  background: #fff4e5;
  color: #b26a00;
}
.pager {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
}
</style>
