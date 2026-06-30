<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '@/lib/http';

type Enforcement = 'none' | 'soft' | 'block_partial' | 'block_full';

interface AdminDoc {
  _id: string;
  key: string;
  title: string;
  category: string;
  enforcement: Enforcement;
  audience: string;
  active: boolean;
  order: number;
  system: boolean;
  currentVersionNumber: number;
  enforcedVersion: number;
}
interface Version {
  _id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  changeSummary: string;
  requiresReacceptance: boolean;
  effectiveAt: string;
  publishedAt: string | null;
  authorEmail: string;
}

const docs = ref<AdminDoc[]>([]);
const selected = ref<AdminDoc | null>(null);
const versions = ref<Version[]>([]);
const error = ref('');
const busy = ref(false);

// Crear documento
const newDoc = ref({ key: '', title: '', category: 'custom', enforcement: 'soft' });
// Crear versión (borrador)
const newVersion = ref({
  locale: 'es',
  title: '',
  bodyMarkdown: '',
  requiresReacceptance: true,
  effectiveAt: '',
});

async function loadDocs(): Promise<void> {
  error.value = '';
  try {
    const { data } = await api.get<{ documents: AdminDoc[] }>('/compliance/admin/documents');
    docs.value = data.documents;
    // Re-sincroniza el documento seleccionado con la versión fresca (p.ej. tras publish/patch) para que
    // el header (currentVersionNumber/enforcedVersion) no quede stale (B P5 LOW).
    if (selected.value) {
      const id = selected.value._id;
      selected.value = docs.value.find((d) => d._id === id) ?? selected.value;
    }
  } catch (e: unknown) {
    error.value = msgOf(e, 'No se pudieron cargar los documentos.');
  }
}

// Secuencia para descartar respuestas tardías si el admin cambia de documento rápido (D-004).
let selectSeq = 0;
async function selectDoc(d: AdminDoc): Promise<void> {
  selected.value = d;
  versions.value = [];
  const seq = ++selectSeq;
  try {
    const { data } = await api.get<{ versions: Version[] }>(
      `/compliance/admin/documents/${d._id}/versions`
    );
    if (seq !== selectSeq) return; // llegó una respuesta de un documento que ya no está seleccionado
    versions.value = data.versions;
  } catch (e: unknown) {
    if (seq === selectSeq) error.value = msgOf(e, 'No se pudieron cargar las versiones.');
  }
}

async function createDoc(): Promise<void> {
  if (!newDoc.value.key || !newDoc.value.title) return;
  busy.value = true;
  error.value = '';
  try {
    await api.post('/compliance/admin/documents', { ...newDoc.value });
    newDoc.value = { key: '', title: '', category: 'custom', enforcement: 'soft' };
    await loadDocs();
  } catch (e: unknown) {
    error.value = msgOf(e, 'No se pudo crear el documento.');
  } finally {
    busy.value = false;
  }
}

async function patchMeta(
  patch: Partial<Pick<AdminDoc, 'enforcement' | 'active' | 'audience' | 'order'>>
): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  error.value = '';
  try {
    const { data } = await api.patch<{ document: AdminDoc }>(
      `/compliance/admin/documents/${selected.value._id}`,
      patch
    );
    selected.value = data.document;
    await loadDocs();
  } catch (e: unknown) {
    error.value = msgOf(e, 'No se pudo actualizar.');
  } finally {
    busy.value = false;
  }
}

async function createVersion(): Promise<void> {
  if (
    !selected.value ||
    !newVersion.value.title ||
    !newVersion.value.bodyMarkdown ||
    !newVersion.value.effectiveAt
  )
    return;
  busy.value = true;
  error.value = '';
  try {
    await api.post(`/compliance/admin/documents/${selected.value._id}/versions`, {
      contents: [
        {
          locale: newVersion.value.locale,
          title: newVersion.value.title,
          bodyMarkdown: newVersion.value.bodyMarkdown,
        },
      ],
      requiresReacceptance: newVersion.value.requiresReacceptance,
      effectiveAt: new Date(newVersion.value.effectiveAt).toISOString(),
    });
    newVersion.value = {
      locale: 'es',
      title: '',
      bodyMarkdown: '',
      requiresReacceptance: true,
      effectiveAt: '',
    };
    await selectDoc(selected.value);
  } catch (e: unknown) {
    error.value = msgOf(e, 'No se pudo crear la versión.');
  } finally {
    busy.value = false;
  }
}

async function publish(v: Version): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.post(`/compliance/admin/versions/${v._id}/publish`);
    await selectDoc(selected.value);
    await loadDocs();
  } catch (e: unknown) {
    error.value = msgOf(e, 'No se pudo publicar.');
  } finally {
    busy.value = false;
  }
}

async function exportCsv(): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  error.value = '';
  try {
    // Vía api.get (NO window.open): así viaja el header Authorization: Bearer del access token en memoria;
    // window.open sólo mandaría la cookie refresh y el backend respondería 401 (B P5 HIGH).
    const { data } = await api.get<Blob>('/compliance/admin/acceptances', {
      params: { documentKey: selected.value.key, format: 'csv' },
      responseType: 'blob',
    });
    const blob = new Blob([data], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `acceptances-${selected.value.key}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e: unknown) {
    error.value = msgOf(e, 'No se pudo exportar el CSV.');
  } finally {
    busy.value = false;
  }
}

function msgOf(e: unknown, fallback: string): string {
  const m = (e as { response?: { data?: { message?: string } } }).response?.data?.message;
  return typeof m === 'string' ? m : fallback;
}

onMounted(loadDocs);
</script>

<template>
  <div class="compliance-admin">
    <p v-if="error" class="ca-error">{{ error }}</p>

    <div class="ca-grid">
      <!-- Lista de documentos -->
      <aside class="ca-list">
        <h3>Documentos</h3>
        <ul>
          <li
            v-for="d in docs"
            :key="d._id"
            :class="{ active: selected?._id === d._id }"
            @click="selectDoc(d)"
          >
            <span class="ca-key">{{ d.key }}</span>
            <span class="ca-badge" :class="d.enforcement">{{ d.enforcement }}</span>
            <small v-if="!d.active">(inactivo)</small>
          </li>
        </ul>

        <div class="ca-create">
          <h4>Nuevo documento</h4>
          <input v-model="newDoc.key" placeholder="clave (kebab-case)" />
          <input v-model="newDoc.title" placeholder="título" />
          <select v-model="newDoc.category">
            <option value="legal">legal</option>
            <option value="privacy">privacy</option>
            <option value="security">security</option>
            <option value="operational">operational</option>
            <option value="cookies">cookies</option>
            <option value="custom">custom</option>
          </select>
          <button :disabled="busy" @click="createDoc">Crear</button>
        </div>
      </aside>

      <!-- Detalle del documento seleccionado -->
      <section v-if="selected" class="ca-detail">
        <header>
          <h3>
            {{ selected.title }} <code>{{ selected.key }}</code>
          </h3>
          <small
            >versión vigente: {{ selected.currentVersionNumber }} · umbral exigido:
            {{ selected.enforcedVersion }}</small
          >
        </header>

        <div class="ca-meta">
          <label>
            Enforcement
            <select
              :value="selected.enforcement"
              :disabled="busy"
              @change="
                patchMeta({
                  enforcement: ($event.target as HTMLSelectElement).value as Enforcement,
                })
              "
            >
              <option value="none">none</option>
              <option value="soft">soft</option>
              <option value="block_partial">block_partial</option>
              <option value="block_full">block_full</option>
            </select>
          </label>
          <label>
            Audiencia
            <select
              :value="selected.audience"
              :disabled="busy"
              @change="patchMeta({ audience: ($event.target as HTMLSelectElement).value })"
            >
              <option value="all">all</option>
              <option value="role:user">role:user</option>
              <option value="role:admin">role:admin</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              :checked="selected.active"
              :disabled="busy"
              @change="patchMeta({ active: ($event.target as HTMLInputElement).checked })"
            />
            Activo
          </label>
          <button class="ca-export" @click="exportCsv">Exportar aceptaciones (CSV)</button>
        </div>

        <h4>Versiones</h4>
        <table class="ca-versions">
          <thead>
            <tr>
              <th>v</th>
              <th>estado</th>
              <th>vigencia</th>
              <th>reacept.</th>
              <th>autor</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v._id">
              <td>{{ v.version }}</td>
              <td>
                <span class="ca-badge" :class="v.status">{{ v.status }}</span>
              </td>
              <td>{{ new Date(v.effectiveAt).toLocaleDateString() }}</td>
              <td>{{ v.requiresReacceptance ? 'sí' : 'no' }}</td>
              <td>
                <small>{{ v.authorEmail }}</small>
              </td>
              <td>
                <button v-if="v.status === 'draft'" :disabled="busy" @click="publish(v)">
                  Publicar
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <details class="ca-newver">
          <summary>Nueva versión (borrador)</summary>
          <div class="ca-newver-form">
            <div class="ca-row">
              <select v-model="newVersion.locale">
                <option value="es">es</option>
                <option value="en">en</option>
              </select>
              <input v-model="newVersion.title" placeholder="título" />
              <input v-model="newVersion.effectiveAt" type="datetime-local" />
              <label
                ><input v-model="newVersion.requiresReacceptance" type="checkbox" /> requiere
                reaceptación</label
              >
            </div>
            <textarea
              v-model="newVersion.bodyMarkdown"
              rows="10"
              placeholder="Contenido Markdown…"
            ></textarea>
            <button :disabled="busy" @click="createVersion">Crear borrador</button>
          </div>
        </details>
      </section>

      <section v-else class="ca-detail ca-empty">Seleccione un documento.</section>
    </div>
  </div>
</template>

<style scoped>
.compliance-admin {
  font-size: 0.9rem;
}
.ca-error {
  color: #dc2626;
  margin-bottom: 0.5rem;
}
.ca-grid {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 1rem;
}
.ca-list ul {
  list-style: none;
  padding: 0;
  margin: 0 0 1rem;
}
.ca-list li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  cursor: pointer;
}
.ca-list li:hover {
  background: rgba(0, 0, 0, 0.05);
}
.ca-list li.active {
  background: rgba(59, 130, 246, 0.12);
}
.ca-key {
  font-family: monospace;
  flex: 1;
}
.ca-badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: #e5e7eb;
}
.ca-badge.block_full {
  background: #fecaca;
}
.ca-badge.block_partial {
  background: #fed7aa;
}
.ca-badge.soft {
  background: #dbeafe;
}
.ca-badge.published {
  background: #bbf7d0;
}
.ca-badge.draft {
  background: #e5e7eb;
}
.ca-create,
.ca-newver-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.ca-create input,
.ca-create select,
.ca-newver input,
.ca-newver select,
.ca-newver textarea {
  padding: 0.35rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
}
.ca-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  margin: 0.5rem 0 1rem;
}
.ca-meta label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.8rem;
}
.ca-versions {
  width: 100%;
  border-collapse: collapse;
}
.ca-versions th,
.ca-versions td {
  text-align: left;
  padding: 0.35rem;
  border-bottom: 1px solid #e5e7eb;
}
.ca-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.5rem;
}
.ca-newver-form textarea {
  width: 100%;
  font-family: monospace;
}
.ca-empty {
  color: #6b7280;
  padding: 2rem;
}
button {
  padding: 0.35rem 0.7rem;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: #fff;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ca-export {
  background: #eff6ff;
}
</style>
