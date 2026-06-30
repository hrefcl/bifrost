import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from '@/lib/http';

export type ComplianceEnforcement = 'none' | 'soft' | 'block_partial' | 'block_full';

export interface PendingDocument {
  key: string;
  title: string;
  version: number;
  enforcement: ComplianceEnforcement;
  blocking: boolean;
}

export interface ComplianceDocumentView {
  key: string;
  title: string;
  version: number;
  locale: string;
  bodyHtml: string;
  effectiveAt: string;
}

/**
 * Estado de compliance del usuario (DESIGN §6). El backend es la autoridad (el gate devuelve 403
 * COMPLIANCE_REQUIRED); este store es UX: hidrata los pendientes en login/restore y tras un 403,
 * y maneja el flujo de aceptación.
 */
export const useComplianceStore = defineStore('compliance', () => {
  const enforcement = ref<ComplianceEnforcement>('none');
  const pending = ref<PendingDocument[]>([]);
  const loaded = ref(false);

  // El bloqueo se determina por `enforcement` (no por la lista): un 403 autoritativo del backend pone
  // enforcement='block_full' aunque la lista venga vacía → el router mantiene al user en el gate (D-001).
  const blockFull = computed(() => enforcement.value === 'block_full');
  const blockPartial = computed(() => enforcement.value === 'block_partial');
  const hasPending = computed(() => pending.value.length > 0);

  async function fetchPending(): Promise<void> {
    try {
      const { data } = await api.get<{
        enforcement: ComplianceEnforcement;
        documents: PendingDocument[];
      }>('/compliance/pending');
      enforcement.value = data.enforcement;
      pending.value = data.documents;
      loaded.value = true;
    } catch {
      // NO se resetea a 'none' (D-002): una falla transitoria no debe LIMPIAR un bloqueo ya conocido
      // (lo habría puesto el interceptor 403). El gate del backend sigue siendo la autoridad; se conserva
      // el estado hasta una respuesta exitosa.
      loaded.value = true;
    }
  }

  async function fetchDocument(key: string, locale?: string): Promise<ComplianceDocumentView> {
    const { data } = await api.get<ComplianceDocumentView>(
      `/compliance/documents/${encodeURIComponent(key)}`,
      { params: locale ? { locale } : undefined }
    );
    return data;
  }

  async function accept(
    documentKey: string,
    version: number,
    method: 'explicit_click' | 'scroll_confirmed',
    locale?: string
  ): Promise<void> {
    // El POST es lo crítico (registra la evidencia). Si tiene éxito, la aceptación quedó; el refresh
    // posterior es best-effort: si falla, NO se relanza (la aceptación es idempotente en el backend) (D-003).
    await api.post('/compliance/accept', { documentKey, version, method, locale });
    await fetchPending().catch(() => {
      /* refresh best-effort; el POST ya registró la aceptación */
    });
  }

  /** Marca un 403 COMPLIANCE_REQUIRED recibido del gate (lo dispara el interceptor axios). */
  function markRequired(documents?: PendingDocument[]): void {
    if (documents && documents.length > 0) {
      pending.value = documents;
    }
    // Un 403 COMPLIANCE_REQUIRED es AUTORITATIVO: bloquea. Aunque no venga lista (respuesta inconsistente),
    // se marca bloqueo total para que el router retenga al usuario en el gate y no entre en loop (D-001).
    enforcement.value = 'block_full';
    loaded.value = true;
  }

  function reset(): void {
    enforcement.value = 'none';
    pending.value = [];
    loaded.value = false;
  }

  return {
    enforcement,
    pending,
    loaded,
    blockFull,
    blockPartial,
    hasPending,
    fetchPending,
    fetchDocument,
    accept,
    markRequired,
    reset,
  };
});
