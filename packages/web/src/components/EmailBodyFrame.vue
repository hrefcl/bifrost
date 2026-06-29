<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * Renderiza el cuerpo HTML de un email en un IFRAME SANDBOX. Dos motivos:
 *  1. AISLAMIENTO CSS — el HTML "de tabla" de los emails (firmas, newsletters) colapsa si el CSS de la
 *     app (reset, flex, prose…) se le filtra. El iframe le da su propio documento → renderiza igual
 *     que en Gmail/cliente nativo.
 *  2. SEGURIDAD (defensa en profundidad sobre el saneo del backend) — `sandbox` SIN `allow-scripts`:
 *     ningún script del email se ejecuta aunque el sanitizador tuviera un bypass. `allow-same-origin`
 *     es necesario sólo para que el padre mida la altura (auto-resize); como no hay `allow-scripts`,
 *     no hay JS en el iframe que pueda abusar del mismo-origen. `allow-popups` + base target=_blank →
 *     los links abren en pestaña nueva. (Mismo patrón que lib/print-email.ts, revisado por B+D.)
 */
const props = defineProps<{ html: string }>();
const frame = ref<HTMLIFrameElement | null>(null);
const height = ref(120);

function srcdoc(html: string): string {
  // Documento mínimo: reset de márgenes + tipografía legible + canvas blanco (los emails asumen
  // fondo blanco). El email trae su propio CSS inline, que manda sobre estos defaults.
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:#fff}
    body{font-family:-apple-system,system-ui,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;word-wrap:break-word;overflow-wrap:break-word}
    img{max-width:100%;height:auto}
    a{color:#1b66ff}
  </style></head><body>${html}</body></html>`;
}

function resize() {
  const doc = frame.value?.contentWindow?.document;
  if (!doc?.documentElement) return;
  height.value = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight) + 8;
}
function onLoad() {
  resize();
  const doc = frame.value?.contentWindow?.document;
  // Re-medir cuando carguen las imágenes (cambian la altura del contenido).
  doc?.querySelectorAll('img').forEach((img) => {
    if (!img.complete) {
      img.addEventListener('load', resize, { once: true });
      img.addEventListener('error', resize, { once: true });
    }
  });
  setTimeout(resize, 400); // respaldo: fuentes/imágenes async
}

// Al cambiar de email, reseteamos la altura; el @load del nuevo srcdoc la vuelve a medir.
watch(
  () => props.html,
  () => {
    height.value = 120;
  }
);
</script>

<template>
  <iframe
    ref="frame"
    class="email-frame"
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    :srcdoc="srcdoc(props.html)"
    :style="{ height: height + 'px' }"
    @load="onLoad"
  />
</template>

<style scoped>
.email-frame {
  width: 100%;
  border: 0;
  display: block;
  overflow: hidden;
}
</style>
