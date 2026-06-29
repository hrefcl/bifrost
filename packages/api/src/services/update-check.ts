import { BUILD_INFO } from '../lib/buildInfo.js';

/**
 * Chequeo de actualización estilo WordPress para un deploy Docker. La versión "instalada" es el
 * BUILD_INFO baked en la imagen (build = GITHUB_RUN_NUMBER del workflow Docker). La "última
 * disponible" se deriva del run_number del ÚLTIMO Docker workflow EXITOSO en GitHub (la misma fuente
 * que numera las imágenes) → no requiere infra extra (ni releases ni manifiestos). Se compara y se
 * informa al admin. Aplicar la actualización (pull + recreate) es la Fase 2 (sidecar updater).
 *
 * El resultado se cachea en proceso (TTL) para no pegarle a la API de GitHub en cada request ni
 * gastar el rate-limit no autenticado (60/h por IP).
 */
const REPO = process.env.UPDATE_REPO ?? 'hrefcl/bifrost';
const WORKFLOW = 'docker.yml';
const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
// Piso entre fetches reales aunque sea `force`: evita que spamear "Buscar ahora" agote el rate-limit
// no autenticado de GitHub (60/h por IP). 30s tolera un re-chequeo manual sin quemar la cuota.
const FORCE_FLOOR_MS = 30 * 1000;

export interface LatestBuild {
  build: number;
  sha: string;
  date: string;
}
export interface UpdateStatus {
  current: typeof BUILD_INFO;
  latest: LatestBuild | null;
  updateAvailable: boolean;
  /** behind = cuántos builds de diferencia (si ambos son numéricos). */
  behind: number | null;
  checkedAt: string;
  repoUrl: string;
  /** Diff de los cambios entre la versión instalada y la última (changelog real). */
  compareUrl: string | null;
}

let cache: { at: number; data: LatestBuild | null } | null = null;

async function fetchLatestBuild(): Promise<LatestBuild | null> {
  // CRÍTICO: filtrar branch=main + event=push. docker.yml también corre en pull_request (los PRs
  // buildean imágenes pero NO pushean `:latest`), y run_number es GLOBAL al workflow. Sin el filtro,
  // el build de un PR/feature podría ser "el último run exitoso" → falso "actualización disponible"
  // apuntando a una imagen que nunca se desplegó. `:latest` sólo lo pushea el push a main → ésa es la
  // única fuente válida del "último build disponible".
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&event=push&status=success&per_page=1`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bifrost-update-check' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    workflow_runs?: { run_number: number; head_sha: string; created_at: string }[];
  };
  const run = json.workflow_runs?.[0];
  if (!run) return null;
  return { build: run.run_number, sha: run.head_sha.slice(0, 7), date: run.created_at };
}

/** Estado de actualización (cacheado). `force` salta el cache (botón "buscar ahora") pero respeta un
 *  piso de FORCE_FLOOR_MS entre fetches reales para no agotar el rate-limit de GitHub. */
export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  const age = cache ? Date.now() - cache.at : Infinity;
  const shouldFetch = !cache || age > TTL_MS || (force && age > FORCE_FLOOR_MS);
  if (shouldFetch) {
    try {
      cache = { at: Date.now(), data: await fetchLatestBuild() };
    } catch {
      cache = { at: Date.now(), data: null }; // red caída / timeout → degradar a "desconocido"
    }
  }
  // shouldFetch incluye `!cache`, así que tras el bloque cache nunca es null (TS no lo infiere).
  const latest = cache?.data ?? null;
  const currentBuild = Number(BUILD_INFO.build);
  const currentIsNumeric = Number.isFinite(currentBuild);
  const updateAvailable = latest !== null && currentIsNumeric && latest.build > currentBuild;
  const behind =
    latest !== null && currentIsNumeric ? Math.max(0, latest.build - currentBuild) : null;
  return {
    current: BUILD_INFO,
    latest,
    updateAvailable,
    behind,
    checkedAt: new Date().toISOString(),
    repoUrl: `https://github.com/${REPO}`,
    compareUrl:
      latest && currentIsNumeric
        ? `https://github.com/${REPO}/compare/${BUILD_INFO.sha}...${latest.sha}`
        : null,
  };
}

/** Sólo para tests: limpia el cache en memoria. */
export function __resetUpdateCache(): void {
  cache = null;
}
