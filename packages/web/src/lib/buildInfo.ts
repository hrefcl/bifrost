// Info de build baked en el bundle por Vite (`define`, ver vite.config.ts). Sirve para que el admin
// muestre QUÉ versión está corriendo realmente el navegador → si el número no cambió tras un deploy,
// estás viendo un bundle cacheado. `build` es el contador de GitHub Actions (sube solo cada build).
export const BUILD_INFO = {
  version: __APP_VERSION__,
  build: __BUILD_NUMBER__,
  sha: __BUILD_SHA__,
  time: __BUILD_TIME__,
} as const;

/** Etiqueta corta para la UI: `v6.0.0 · build 142 · a1b2c3d`. */
export const BUILD_LABEL = `v${BUILD_INFO.version} · build ${BUILD_INFO.build} · ${BUILD_INFO.sha}`;
