/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Marca white-label (ver src/config/brand.ts). Todas opcionales → default Bifrost. */
  readonly VITE_BRAND_NAME?: string;
  readonly VITE_BRAND_VERSION?: string;
  readonly VITE_BRAND_ACCENT?: string;
  readonly VITE_BRAND_TAGLINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
