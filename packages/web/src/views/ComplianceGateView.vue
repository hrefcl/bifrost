<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useComplianceStore, type ComplianceDocumentView } from '@/stores/compliance';
import { useAuthStore } from '@/stores/auth';

const compliance = useComplianceStore();
const auth = useAuthStore();
const router = useRouter();
const { t } = useI18n();

const blockingDocs = computed(() => compliance.pending.filter((d) => d.blocking));
const index = ref(0);
// `.at()` devuelve `T | undefined` → los guards `if (!current.value)` son válidos (el índice puede
// quedar fuera de rango si la lista bloqueante se vacía tras una aceptación).
const current = computed(() => blockingDocs.value.at(index.value));
const doc = ref<ComplianceDocumentView | null>(null);
const loading = ref(false);
const accepting = ref(false);
const scrolledToEnd = ref(false);
const error = ref('');
const scrollBox = ref<HTMLElement | null>(null);

const progress = computed(() =>
  blockingDocs.value.length > 0
    ? `${String(index.value + 1)} / ${String(blockingDocs.value.length)}`
    : ''
);

async function loadCurrent(): Promise<void> {
  if (!current.value) return;
  loading.value = true;
  error.value = '';
  scrolledToEnd.value = false;
  doc.value = null;
  try {
    doc.value = await compliance.fetchDocument(current.value.key);
    loading.value = false; // se baja ANTES del chequeo para que el contenedor (v-else) ya esté en el DOM
    // Tras renderizar: si el documento es corto y NO desborda el contenedor, no habrá evento scroll →
    // se habilita la aceptación de inmediato (no hay nada que desplazar). Evita atrapar al usuario.
    await nextTick();
    onScroll();
  } catch {
    error.value = t('compliance.loadError');
    loading.value = false;
  }
}

/** Habilita "Aceptar" cuando el usuario llegó al final (evidencia de lectura) o si no hay scroll. */
function onScroll(): void {
  const el = scrollBox.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) scrolledToEnd.value = true;
}

async function acceptCurrent(): Promise<void> {
  if (!current.value || !scrolledToEnd.value || accepting.value) return;
  accepting.value = true;
  error.value = '';
  try {
    await compliance.accept(
      current.value.key,
      current.value.version,
      'scroll_confirmed',
      doc.value?.locale
    );
    // Tras aceptar, el store refrescó `pending`. Si ya no hay bloqueo (full ni partial), salir al inbox.
    if (!compliance.blockFull && !compliance.blockPartial) {
      await router.push({ name: 'inbox' });
      return;
    }
    index.value = 0; // recomenzar sobre la lista bloqueante restante
    if (blockingDocs.value.length > 0) await loadCurrent();
  } catch {
    error.value = t('compliance.acceptError');
  } finally {
    accepting.value = false;
  }
}

async function doLogout(): Promise<void> {
  await auth.logout();
  compliance.reset();
  await router.push({ name: 'login' });
}

onMounted(async () => {
  await compliance.fetchPending(); // hidrata la lista autoritativa de pendientes
  // Si NO hay bloqueo (full ni partial), no hay nada que aceptar aquí → salir al inbox.
  if (!compliance.blockFull && !compliance.blockPartial) {
    await router.push({ name: 'inbox' });
    return;
  }
  // Bloqueado pero sin documentos cargables (respuesta inconsistente del backend): se muestra un
  // mensaje en vez de rebotar (rebotar generaría loop con el router, que mantiene el bloqueo) (D-001).
  if (blockingDocs.value.length === 0) {
    error.value = t('compliance.inconsistentError');
    return;
  }
  await loadCurrent();
});

watch(current, () => {
  if (current.value) void loadCurrent();
});
</script>

<template>
  <div class="fixed inset-0 z-50 flex flex-col bg-gray-50 dark:bg-gray-900">
    <header
      class="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700"
    >
      <div>
        <h1 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {{ doc?.title ?? current?.title ?? t('compliance.title') }}
        </h1>
        <p class="text-sm text-gray-500 dark:text-gray-400">
          {{ t('compliance.subtitle') }} · {{ progress }}
        </p>
      </div>
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
        @click="doLogout"
      >
        {{ t('compliance.logout') }}
      </button>
    </header>

    <main class="flex flex-1 justify-center overflow-hidden p-6">
      <div class="flex w-full max-w-3xl flex-col">
        <div v-if="loading" class="flex flex-1 items-center justify-center text-gray-500">
          {{ t('compliance.loading') }}
        </div>
        <!-- v-html: `bodyHtml` viene SANEADO del backend (pipeline markdown html:false + sanitize-html
             allowlist estricta, DESIGN §6). El saneo en servidor es la defensa autoritativa. -->
        <!-- eslint-disable vue/no-v-html -->
        <div
          v-else
          ref="scrollBox"
          class="prose prose-sm max-w-none flex-1 overflow-y-auto rounded-lg border border-gray-200 bg-white p-6 dark:prose-invert dark:border-gray-700 dark:bg-gray-800"
          @scroll="onScroll"
          v-html="doc?.bodyHtml ?? ''"
        ></div>
        <!-- eslint-enable vue/no-v-html -->

        <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>

        <div class="mt-4 flex items-center justify-between">
          <span class="text-xs text-gray-500 dark:text-gray-400">
            {{ scrolledToEnd ? t('compliance.read') : t('compliance.scrollHint') }}
          </span>
          <button
            type="button"
            :disabled="!scrolledToEnd || accepting"
            class="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white enabled:hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            @click="acceptCurrent"
          >
            {{ accepting ? t('compliance.accepting') : t('compliance.accept') }}
          </button>
        </div>
      </div>
    </main>
  </div>
</template>
