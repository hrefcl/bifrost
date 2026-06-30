<script setup lang="ts">
import { ref, watch, computed, onBeforeUnmount } from 'vue';
import { splitEmailQuote } from '@/lib/emailQuote';

/**
 * Renderiza el cuerpo HTML de un email en un IFRAME SANDBOX. Dos motivos:
 *  1. AISLAMIENTO CSS — el HTML "de tabla" de los emails (firmas, newsletters) colapsa si el CSS de la
 *     app (reset, flex, prose…) se le filtra. El iframe le da su propio documento → renderiza igual
 *     que en Gmail/cliente nativo.
 *  2. SEGURIDAD (defensa en profundidad sobre el saneo del backend) — `sandbox` SIN `allow-scripts`:
 *     ningún script del email se ejecuta aunque el sanitizador tuviera un bypass. `allow-same-origin`
 *     es necesario sólo para que el padre mida la altura (auto-resize); como no hay `allow-scripts`,
 *     no hay JS en el iframe que pueda abusar del mismo-origen. `allow-popups` + base target=_blank →
 *     los links abren en pestaña nueva; el reverse-tabnabbing lo cierra el BACKEND, que fuerza
 *     rel="noopener noreferrer" en cada <a> (api/src/lib/sanitizeHtml.ts). El mismo patrón sandbox
 *     (sin allow-scripts) lo usa lib/print-email.ts al imprimir (InboxView.printEmail).
 *
 *  ⚠️ INVARIANTE DE SEGURIDAD: NUNCA agregar `allow-scripts` junto con `allow-same-origin`. Esa
 *     combinación deja que el contenido del iframe se quite el sandbox a sí mismo → bypass total
 *     (MDN lo marca explícito). Si alguna vez hace falta correr JS del email, usar un ORIGEN
 *     separado (sandbox domain), no relajar estos flags.
 */
const props = defineProps<{ html: string }>();
const frame = ref<HTMLIFrameElement | null>(null);
const height = ref(120);
// Mostrar/ocultar la CITA (el mensaje anterior citado debajo de la respuesta), estilo Gmail "···".
const showQuoted = ref(false);

// Separa contenido nuevo + cita (ver lib/emailQuote.ts). El split se hace en el PADRE porque el iframe
// no corre scripts; el toggle "···" re-renderiza el srcdoc con/sin la cita.
const split = computed(() => splitEmailQuote(props.html));
const visibleHtml = computed(() =>
  split.value.quoted && !showQuoted.value ? split.value.main : props.html
);
const hasQuote = computed(() => split.value.quoted.length > 0);

// CSP del documento del email — defensa en profundidad sobre el sandbox (que ya bloquea scripts por
// no llevar allow-scripts). Bloquea explícitamente JS/plugins/<base href> malicioso y deja sólo lo
// que un email legítimo necesita: estilos inline, imágenes y fuentes. `script-src 'none'` es redundante
// con el sandbox pero documenta la intención y cubre cualquier rareza de navegador.
const EMAIL_CSP =
  "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src * data:; " +
  "media-src * data:; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

function srcdoc(html: string): string {
  // Documento mínimo: reset de márgenes + tipografía legible + canvas blanco (los emails asumen
  // fondo blanco). El email trae su propio CSS inline, que manda sobre estos defaults.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:#fff}
    body{font-family:-apple-system,system-ui,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;word-wrap:break-word;overflow-wrap:break-word}
    img{max-width:100%;height:auto}
    a{color:#1b66ff}
  </style></head><body>${html}</body></html>`;
}

let ro: ResizeObserver | null = null;

// Techo de altura del iframe. Sin esto, un email malicioso con `height:500000px` infla el panel a
// una tira infinita SIN click (DoS de layout, hallazgo C). Pasado el techo, el iframe scrollea
// internamente (overflow-y:auto vía clase) en vez de empujar toda la UI.
const MAX_PX = 24000;

function resize() {
  const doc = frame.value?.contentWindow?.document;
  if (!doc?.body) return;
  // Medir el BODY (su contenido real), NO documentElement: el <html> llena el viewport del iframe, así
  // que documentElement.scrollHeight reporta el alto ACTUAL del iframe → al colapsar la cita ("···") el
  // contenido se achica pero el iframe quedaría enorme (no encoge). body.scrollHeight = alto del
  // contenido, independiente del tamaño del iframe → encoge y crece bien.
  const measured = doc.body.scrollHeight + 8;
  height.value = Math.min(Math.max(measured, 24), MAX_PX);
}
function onLoad() {
  resize();
  const doc = frame.value?.contentWindow?.document;
  if (!doc) return;
  // Re-medir cuando carguen las imágenes (cambian la altura del contenido).
  doc.querySelectorAll('img').forEach((img) => {
    if (!img.complete) {
      img.addEventListener('load', resize, { once: true });
      img.addEventListener('error', resize, { once: true });
    }
  });
  // Re-medir si el contenido reflowea (p.ej. ventana se angosta → texto/tablas se hacen más altos).
  // Lo observa el PADRE sobre el body same-origin: cero scripts dentro del iframe.
  ro?.disconnect();
  ro = new ResizeObserver(() => {
    resize();
  });
  ro.observe(doc.body);
  setTimeout(resize, 400); // respaldo: fuentes/imágenes async
}

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});

// Al cambiar de email, reseteamos la altura y volvemos a colapsar la cita; el @load la vuelve a medir.
watch(
  () => props.html,
  () => {
    height.value = 120;
    showQuoted.value = false;
  }
);
</script>

<template>
  <div class="ebf">
    <iframe
      ref="frame"
      class="email-frame"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      :srcdoc="srcdoc(visibleHtml)"
      :style="{ height: height + 'px' }"
      @load="onLoad"
    />
    <!-- Toggle estilo Gmail: muestra/oculta la cita (mensaje previo citado). Sólo si hay cita. -->
    <button
      v-if="hasQuote"
      class="ebf-quote-toggle"
      :title="showQuoted ? 'Ocultar lo citado' : 'Mostrar el contenido citado'"
      @click="showQuoted = !showQuoted"
    >
      <span class="ebf-dots">•••</span>
    </button>
  </div>
</template>

<style scoped>
.email-frame {
  width: 100%;
  border: 0;
  display: block;
  /* Normalmente la altura calza exacto (sin scroll); si se capea por MAX_PX, scrollea adentro. */
  overflow-y: auto;
  overflow-x: hidden;
}
.ebf-quote-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
  padding: 0 8px;
  height: 18px;
  border: none;
  border-radius: 9px;
  background: var(--surface-3, #e8eaed);
  color: var(--text-2, #5f6368);
  cursor: pointer;
  line-height: 1;
}
.ebf-quote-toggle:hover {
  background: var(--surface-4, #dadce0);
}
.ebf-dots {
  font-size: 13px;
  letter-spacing: 1px;
}
</style>
