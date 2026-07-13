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

// Catálogo COMPLETO de la API máquina-a-máquina (`/api/provision/*`). Documentación viva: refleja
// exactamente los endpoints registrados en routes/provision.ts. Todos usan el header `X-Provision-Key`.
interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  desc: string;
}
const ENDPOINTS: ApiEndpoint[] = [
  {
    method: 'POST',
    path: '/api/provision/reconcile',
    desc: 'Fuerza la sincronización con el servidor de correo: importa a Bifrost los buzones que existen en el servidor pero no están registrados, y reporta los huérfanos (registrados en Bifrost pero ya no en el servidor). Idempotente.',
  },
  {
    method: 'GET',
    path: '/api/provision/mailboxes',
    desc: 'Lista los buzones (paginado + búsqueda). Query: ?page (1), ?pageSize (1–500, 50), ?search (email o nombre).',
  },
  {
    method: 'POST',
    path: '/api/provision/mailboxes',
    desc: 'Crea un buzón. Si omitís password, se genera una y viene en la respuesta (una vez). Acepta header Idempotency-Key (reintento seguro). Si el buzón ya existía en el servidor sin registro en Bifrost, lo reconcilia y responde 200 con rescued:true en vez de 409.',
  },
  {
    method: 'GET',
    path: '/api/provision/mailboxes/:email',
    desc: 'Consulta un buzón por email (404 si no existe). El email va URL-encoded (@ → %40).',
  },
  {
    method: 'PATCH',
    path: '/api/provision/mailboxes/:email',
    desc: 'Edita el buzón: displayName, quotaBytes, aliases (array, reemplaza el set), active (false=suspende cortando IMAP/SMTP sin perder la clave; true=reactiva).',
  },
  {
    method: 'PUT',
    path: '/api/provision/mailboxes/:email/password',
    desc: 'Fija una contraseña concreta para el buzón.',
  },
  {
    method: 'POST',
    path: '/api/provision/mailboxes/:email/reset-password',
    desc: 'Genera una contraseña fuerte (o usa la que mandes) y la devuelve una sola vez.',
  },
  {
    method: 'DELETE',
    path: '/api/provision/mailboxes/:email',
    desc: 'Elimina el buzón: revoca el acceso IMAP/SMTP en el servidor y borra la cuenta y sus datos.',
  },
];

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

    <!-- Referencia de la API (autodocumentada desde ENDPOINTS) -->
    <div class="card">
      <h3 class="prov__h">Referencia de la API</h3>
      <p class="prov__muted">
        API máquina-a-máquina para gestionar buzones desde sistemas externos. Base:
        <code>{{ baseUrl }}</code
        >. Autenticá TODAS las llamadas con el header <code>X-Provision-Key: &lt;TU_KEY&gt;</code>.
        El <code>:email</code> de la ruta va URL-encoded (<code>@</code> → <code>%40</code>).
      </p>

      <!-- Tabla de endpoints -->
      <div class="prov__eptable">
        <div v-for="ep in ENDPOINTS" :key="ep.method + ep.path" class="prov__eprow">
          <span class="prov__method" :class="'prov__method--' + ep.method.toLowerCase()">{{
            ep.method
          }}</span>
          <code class="prov__eppath">{{ ep.path }}</code>
          <span class="prov__epdesc">{{ ep.desc }}</span>
        </div>
      </div>

      <!-- Códigos de respuesta -->
      <p class="prov__lbl">Códigos de respuesta</p>
      <ul class="prov__codes">
        <li>
          <code>200</code> / <code>201</code> — OK (201 = creado; 200 = reconciliado/consulta).
        </li>
        <li><code>401</code> — key inválida o ausente.</li>
        <li><code>404</code> — el buzón no existe.</li>
        <li><code>409</code> — conflicto: ya existe, o el email ya es alias de otro buzón.</li>
        <li>
          <code>502</code> — falló el servidor de correo (los escritos son atómicos → reintentar es
          seguro).
        </li>
        <li><code>503</code> — el provisioning de buzones está apagado en este servidor.</li>
      </ul>

      <!-- Ejemplos -->
      <p class="prov__lbl">
        Sincronizar / reconciliar (importar los que falten + detectar huérfanos)
      </p>
      <pre class="prov__code">
curl -X POST {{ baseUrl }}/api/provision/reconcile \
  -H "X-Provision-Key: &lt;TU_KEY&gt;"
# → {"serverTotal":34,"alreadyTracked":34,"imported":0,"importedEmails":[],"orphans":[]}</pre
      >

      <p class="prov__lbl">Listar buzones (paginado + búsqueda)</p>
      <pre class="prov__code">
curl "{{ baseUrl }}/api/provision/mailboxes?page=1&amp;pageSize=50&amp;search=juan" \
  -H "X-Provision-Key: &lt;TU_KEY&gt;"</pre
      >

      <p class="prov__lbl">
        Crear un buzón (si omitís <code>password</code>, la respuesta trae una generada; con
        <code>Idempotency-Key</code> el reintento es seguro)
      </p>
      <pre class="prov__code">
curl -X POST {{ baseUrl }}/api/provision/mailboxes \
  -H "X-Provision-Key: &lt;TU_KEY&gt;" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: crea-juan-001" \
  -d '{"email":"juan@tudominio.com","displayName":"Juan","quotaBytes":0}'</pre
      >

      <p class="prov__lbl">Consultar un buzón</p>
      <pre class="prov__code">
curl {{ baseUrl }}/api/provision/mailboxes/juan%40tudominio.com \
  -H "X-Provision-Key: &lt;TU_KEY&gt;"</pre
      >

      <p class="prov__lbl">Editar: nombre, cuota, alias, suspender/reactivar</p>
      <pre class="prov__code">
curl -X PATCH {{ baseUrl }}/api/provision/mailboxes/juan%40tudominio.com \
  -H "X-Provision-Key: &lt;TU_KEY&gt;" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Juan Pérez","aliases":["ventas@tudominio.com"],"active":false}'</pre
      >

      <p class="prov__lbl">Fijar o resetear la contraseña</p>
      <pre class="prov__code">
curl -X PUT {{ baseUrl }}/api/provision/mailboxes/juan%40tudominio.com/password \
  -H "X-Provision-Key: &lt;TU_KEY&gt;" \
  -H "Content-Type: application/json" \
  -d '{"password":"&lt;UNA_CLAVE_FUERTE&gt;"}'

curl -X POST {{ baseUrl }}/api/provision/mailboxes/juan%40tudominio.com/reset-password \
  -H "X-Provision-Key: &lt;TU_KEY&gt;"
# → {"email":"juan@tudominio.com","password":"&lt;generada-una-vez&gt;"}</pre
      >

      <p class="prov__lbl">Eliminar un buzón (revoca IMAP/SMTP y borra la cuenta)</p>
      <pre class="prov__code">
curl -X DELETE {{ baseUrl }}/api/provision/mailboxes/juan%40tudominio.com \
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
/* Tabla de endpoints de la API */
.prov__eptable {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
  margin: 10px 0 6px;
}
.prov__eprow {
  display: grid;
  grid-template-columns: 68px minmax(200px, auto) 1fr;
  gap: 12px;
  align-items: start;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border, #e5e7eb);
  font-size: 12.5px;
}
.prov__eprow:last-child {
  border-bottom: none;
}
.prov__method {
  font-weight: 700;
  font-size: 11px;
  text-align: center;
  padding: 3px 0;
  border-radius: 5px;
  letter-spacing: 0.02em;
}
.prov__method--get {
  background: #d1fae5;
  color: #065f46;
}
.prov__method--post {
  background: #dbeafe;
  color: #1e40af;
}
.prov__method--put,
.prov__method--patch {
  background: #fef3c7;
  color: #92400e;
}
.prov__method--delete {
  background: #fee2e2;
  color: #991b1b;
}
.prov__eppath {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-1, #111827);
  word-break: break-all;
  align-self: center;
}
.prov__epdesc {
  color: var(--text-muted, #6b7280);
  line-height: 1.45;
}
.prov__codes {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--text-muted, #6b7280);
  line-height: 1.7;
}
.prov__codes code {
  font-family: monospace;
}
@media (max-width: 640px) {
  .prov__eprow {
    grid-template-columns: 60px 1fr;
  }
  .prov__epdesc {
    grid-column: 1 / -1;
  }
}
</style>
