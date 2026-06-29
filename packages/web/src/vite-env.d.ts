/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Marca white-label (ver src/config/brand.ts). Todas opcionales → default Bifrost. */
  readonly VITE_BRAND_NAME?: string;
  readonly VITE_BRAND_ACCENT?: string;
  readonly VITE_BRAND_TAGLINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Constantes de build inyectadas por Vite (`define` en vite.config.ts). Ver src/lib/buildInfo.ts.
declare const __APP_VERSION__: string;
declare const __BUILD_NUMBER__: string;
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
