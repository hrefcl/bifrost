// Info de build de la imagen API. Se inyecta como ENV en Dockerfile.api (build-args desde el workflow
// Docker: BUILD_NUMBER=GITHUB_RUN_NUMBER, BUILD_SHA=GITHUB_SHA). El admin la consulta vía /health para
// confirmar QUÉ imagen del backend está corriendo (par del build del front, que va baked en el bundle).
// En dev local quedan 'dev'/'local'.
export const BUILD_INFO = {
  version: process.env.APP_VERSION ?? '6.0.0',
  build: process.env.BUILD_NUMBER ?? 'dev',
  sha: (process.env.BUILD_SHA ?? 'local').slice(0, 7),
  time: process.env.BUILD_TIME ?? null,
} as const;
