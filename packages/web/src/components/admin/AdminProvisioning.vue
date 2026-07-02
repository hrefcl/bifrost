<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '@/lib/http';
import AppIcon from '@/components/AppIcon.vue';

/**
 * Panel admin de Provisioning: estado del backend que crea buzones + gestión de las API-keys de
 * `/api/provision/*` (generar / listar / revocar). El token en claro se muestra UNA sola vez al crearlo.
 * Incluye el instructivo de uso inline (autodocumentado).
 */

interface ProvisionKey {
  id: string;
  label: string;
  prefix: string;
  createdBy: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
}

interface MailboxConfig {
  providerType: 'none' | 'docker-mailserver';
  dockerMailserver?: { accountsFile: string; maildataDir?: string };
  updatedAt?: string;
}

const loading = ref(true);
const error = ref('');
const keys = ref<ProvisionKey[]>([]);
const bootstrapConfigured = ref(false);
const providerType = ref<MailboxConfig['providerType']>('none');

const newLabel = ref('');
const creating = ref(false);
// Token recién generado (se muestra UNA vez, en claro). Se limpia al cerrar el aviso.
const freshToken = ref('');
const copied = ref(false);

const baseUrl = computed(() => window.location.origin);
const provisioningOn = computed(() => providerType.value !== 'none');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [keysRes, cfgRes] = await Promise.all([
      api.get<{ keys: ProvisionKey[]; bootstrapConfigured: boolean }>('/admin/provision-keys'),
      api.get<MailboxConfig>('/admin/config/mailbox-provisioning'),
    ]);
    keys.value = keysRes.data.keys;
    bootstrapConfigured.value = keysRes.data.bootstrapConfigured;
    providerType.value = cfgRes.data.providerType;
  } catch {
    error.value = 'No se pudo cargar la información de provisioning.';
  } finally {
    loading.value = false;
  }
}

async function createKey() {
  const label = newLabel.value.trim();
  if (!label || creating.value) return;
  creating.value = true;
  error.value = '';
  try {
    const { data } = await api.post<ProvisionKey & { token: string }>('/admin/provision-keys', {
      label,
    });
    freshToken.value = data.token;
    copied.value = false;
    newLabel.value = '';
    await load();
  } catch {
    error.value = 'No se pudo generar la key.';
  } finally {
    creating.value = false;
  }
}

async function revokeKey(k: ProvisionKey) {
  if (!confirm(`¿Revocar la key "${k.label}"? Los sistemas que la usen dejarán de tener acceso.`))
    return;
  try {
    await api.delete(`/admin/provision-keys/${k.id}`);
    await load();
  } catch {
    error.value = 'No se pudo revocar la key.';
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(freshToken.value);
    copied.value = true;
  } catch {
    /* clipboard no disponible: el usuario copia a mano */
  }
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

onMounted(load);
</script>

<template>
  <div class="prov">
    <p v-if="error" class="prov__error">{{ error }}</p>

    <!-- Estado del backend de creación de buzones -->
    <div class="card">
      <h3 class="prov__h">Backend de cuentas</h3>
      <p v-if="provisioningOn" class="prov__ok">
        <AppIcon name="check" :size="16" /> Bifrost crea los buzones directamente
        (<code>docker-mailserver</code>). El alta desde <em>Usuarios</em> y esta API generan el
        buzón real.
      </p>
      <p v-else class="prov__muted">
        Este servidor NO crea buzones (modo «traé tu IMAP»). La API de provisioning responde 503.
        Activá un backend en el instalador o configuralo si tu deploy trae mailserver propio.
      </p>
    </div>

    <!-- API keys -->
    <div class="card">
      <h3 class="prov__h">API-keys de provisioning</h3>
      <p class="prov__muted">
        Para que sistemas externos (por ej. un panel corporativo) creen/borren buzones por API, sin
        claves AWS ni SSH al servidor. Generá una key, copiala <strong>ahora</strong> (se muestra
        una sola vez) y pegala en el sistema que la va a usar.
      </p>

      <!-- Token recién generado (una sola vez) -->
      <div v-if="freshToken" class="prov__fresh">
        <div class="prov__fresh-head">
          <AppIcon name="lock" :size="16" />
          <strong>Copiá esta key ahora — no la vas a poder ver de nuevo</strong>
        </div>
        <div class="prov__fresh-row">
          <code class="prov__token">{{ freshToken }}</code>
          <button class="btn btn--sm" type="button" @click="copyToken">
            {{ copied ? '¡Copiada!' : 'Copiar' }}
          </button>
        </div>
        <button class="prov__dismiss" type="button" @click="freshToken = ''">Ya la guardé</button>
      </div>

      <!-- Generar -->
      <form class="prov__new" @submit.prevent="createKey">
        <input
          v-model="newLabel"
          class="input"
          type="text"
          maxlength="120"
          placeholder="Nombre (ej: Panel Vanir, script de altas…)"
        />
        <button class="btn" type="submit" :disabled="!newLabel.trim() || creating">
          {{ creating ? 'Generando…' : 'Generar key' }}
        </button>
      </form>

      <p v-if="loading" class="prov__muted">Cargando…</p>
      <table v-else-if="keys.length" class="prov__table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Key</th>
            <th>Creada</th>
            <th>Último uso</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in keys" :key="k.id" :class="{ 'prov__row--off': !k.active }">
            <td>{{ k.label }}</td>
            <td>
              <code>{{ k.prefix }}</code>
            </td>
            <td>{{ fmt(k.createdAt) }}</td>
            <td>{{ fmt(k.lastUsedAt) }}</td>
            <td>
              <span :class="k.active ? 'badge badge--ok' : 'badge badge--off'">
                {{ k.active ? 'Activa' : 'Revocada' }}
              </span>
            </td>
            <td>
              <button
                v-if="k.active"
                class="btn btn--sm btn--danger"
                type="button"
                @click="revokeKey(k)"
              >
                Revocar
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="prov__muted">Todavía no generaste ninguna key.</p>

      <p v-if="bootstrapConfigured" class="prov__muted prov__note">
        Además hay una key <em>bootstrap</em> del servidor (archivo
        <code>secrets/provision_api_key.txt</code>), válida para el instalador turnkey.
      </p>
    </div>

    <!-- Cómo se usa (autodocumentado) -->
    <div class="card">
      <h3 class="prov__h">Cómo se usa</h3>
      <p class="prov__muted">Mandá la key en el header <code>X-Provision-Key</code>.</p>
      <p class="prov__lbl">
        Crear un buzón (si omitís <code>password</code>, la respuesta trae una generada):
      </p>
      <pre class="prov__code">
curl -X POST {{ baseUrl }}/api/provision/mailboxes \
  -H "X-Provision-Key: &lt;TU_KEY&gt;" \
  -H "Content-Type: application/json" \
  -d '{"email":"nuevo@tudominio.com","displayName":"Nuevo"}'</pre
      >
      <p class="prov__lbl">Eliminar un buzón (revoca el acceso IMAP/SMTP y borra la cuenta):</p>
      <pre class="prov__code">
curl -X DELETE {{ baseUrl }}/api/provision/mailboxes/nuevo%40tudominio.com \
  -H "X-Provision-Key: &lt;TU_KEY&gt;"</pre
      >
      <p class="prov__lbl">Consultar si existe:</p>
      <pre class="prov__code">
curl {{ baseUrl }}/api/provision/mailboxes/nuevo%40tudominio.com \
  -H "X-Provision-Key: &lt;TU_KEY&gt;"</pre
      >
    </div>
  </div>
</template>

<style scoped>
.prov {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.prov__h {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}
.prov__muted {
  color: var(--text-muted, #6b7280);
  font-size: 13px;
  line-height: 1.5;
}
.prov__note {
  margin-top: 12px;
}
.prov__ok {
  color: var(--success, #059669);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.prov__error {
  color: var(--danger, #dc2626);
  font-size: 13px;
}
.prov__new {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}
.prov__new .input {
  flex: 1;
}
.prov__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.prov__table th,
.prov__table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #e5e7eb);
}
.prov__row--off {
  opacity: 0.55;
}
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
}
.badge--ok {
  background: #d1fae5;
  color: #065f46;
}
.badge--off {
  background: #f3f4f6;
  color: #6b7280;
}
.prov__fresh {
  border: 1px solid #fbbf24;
  background: #fffbeb;
  border-radius: 8px;
  padding: 12px;
  margin: 12px 0;
}
.prov__fresh-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin-bottom: 8px;
  color: #92400e;
}
.prov__fresh-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.prov__token {
  flex: 1;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px 10px;
  font-family: monospace;
  font-size: 13px;
  word-break: break-all;
}
.prov__dismiss {
  margin-top: 8px;
  background: none;
  border: none;
  color: #92400e;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
.prov__lbl {
  font-size: 13px;
  font-weight: 500;
  margin: 12px 0 4px;
}
.prov__code {
  background: #1e293b;
  color: #e2e8f0;
  padding: 12px;
  border-radius: 8px;
  font-size: 12px;
  overflow-x: auto;
  margin: 0;
}
.btn--danger {
  background: var(--danger, #dc2626);
  color: #fff;
}
.btn--sm {
  padding: 4px 10px;
  font-size: 12px;
}
</style>
