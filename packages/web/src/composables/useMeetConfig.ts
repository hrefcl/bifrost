import { ref } from 'vue';
import { api } from '@/lib/http';
import type { PublicConfig } from '@webmail6/shared';

/**
 * Config pública de Meet leída en RUNTIME (no `import.meta.env`: la imagen del SPA es estática y genérica
 * → la wsUrl/base se resuelven por `/api/config/public` en cada instalación — review D-M4). Se cachea en
 * memoria del módulo: una sola fetch por carga de página, compartida por las vistas Meet.
 */
const config = ref<PublicConfig | null>(null);
let inflight: Promise<PublicConfig> | null = null;

export function useMeetConfig() {
  async function load(): Promise<PublicConfig> {
    if (config.value) return config.value;
    if (inflight) return inflight;
    inflight = api
      .get<PublicConfig>('/config/public')
      .then((r) => {
        config.value = r.data;
        return r.data;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }
  return { config, load };
}
