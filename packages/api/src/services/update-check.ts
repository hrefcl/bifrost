import { BUILD_INFO } from '../lib/buildInfo.js';
import { redis } from '../config/redis.js';

/**
 * Chequeo de actualización estilo WordPress para un deploy Docker. La versión "instalada" es el
 * BUILD_INFO baked en la imagen (build = GITHUB_RUN_NUMBER del workflow Docker). La "última
 * disponible" se deriva del run_number del ÚLTIMO Docker workflow EXITOSO en GitHub (la misma fuente
 * que numera las imágenes) → no requiere infra extra (ni releases ni manifiestos). Se compara y se
 * informa al admin. Aplicar la actualización (pull + recreate) es la Fase 2 (sidecar updater).
 *
 * CACHE DE DOS NIVELES para no gastar el rate-limit no autenticado de GitHub (60/h por IP):
 *  - L1 en-proceso (TTL): cubre el caso normal (single-box, una réplica).
 *  - L2 en Redis (compartido): a escala 10x con N réplicas de API detrás del mismo IP de egress, una
 *    réplica con L1 frío consulta primero lo que otra ya cacheó en Redis → de "N llamadas por request"
 *    a ~1 por TTL cluster-wide (review D, HIGH de rate-limit). Si Redis falla, degrada a sólo-L1.
 */
// REPO validado a `owner/repo` (se interpola en la URL de la API de GitHub → evita inyección de
// host/path si el env viniera mal). Si no matchea, cae al default.
const REPO =
  process.env.UPDATE_REPO && /^[\w.-]+\/[\w.-]+$/.test(process.env.UPDATE_REPO)
    ? process.env.UPDATE_REPO
    : 'hrefcl/bifrost';
const WORKFLOW = 'docker.yml';
const L2_KEY = 'bifrost:update-check:v1';
// Un ÉXITO se cachea 10min; un FALLO (GitHub caído/rate-limit → data=null) sólo 60s, para recuperarse
// rápido de un parpadeo en vez de quedar 10min mostrando "no se pudo verificar" (review C).
const FAIL_TTL_MS = 60 * 1000;
const freshMs = (entry: { data: LatestBuild | null }): number =>
  entry.data === null ? FAIL_TTL_MS : TTL_MS;
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
  /** true si no se pudo determinar la última versión (GitHub caído/rate-limit) → la UI lo distingue. */
  checkError: boolean;
  checkedAt: string;
  repoUrl: string;
  /** Diff de los cambios entre la versión instalada y la última (changelog real). */
  compareUrl: string | null;
}

let cache: { at: number; data: LatestBuild | null } | null = null;

async function l2Get(): Promise<{ at: number; data: LatestBuild | null } | undefined> {
  try {
    const raw = await redis.get(L2_KEY);
    return raw ? (JSON.parse(raw) as { at: number; data: LatestBuild | null }) : undefined;
  } catch {
    return undefined; // Redis caído → degradar a sólo-L1
  }
}
async function l2Set(entry: { at: number; data: LatestBuild | null }): Promise<void> {
  try {
    await redis.set(L2_KEY, JSON.stringify(entry), 'PX', freshMs(entry));
  } catch {
    /* Redis caído → ignorar, L1 cubre */
  }
}

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

/** Estado de actualización. `force` ("buscar ahora") salta el TTL pero respeta un piso de
 *  FORCE_FLOOR_MS entre fetches reales (anti rate-limit). Cache L1 (proceso) + L2 (Redis compartido). */
export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  const now = Date.now();
  const l1Age = cache ? now - cache.at : Infinity;

  if (!force && cache && l1Age <= freshMs(cache)) {
    // L1 fresco → ni Redis ni GitHub.
  } else {
    // L1 frío o `force`: antes de pegarle a GitHub, mirar L2 (lo que otra réplica ya cacheó).
    const l2 = await l2Get();
    const l2Age = l2 ? now - l2.at : Infinity;
    if (!force && l2 && l2Age <= freshMs(l2)) {
      cache = l2; // otra réplica ya lo trajo → reusar, no fetch
    } else if (force && l1Age <= FORCE_FLOOR_MS) {
      // piso de force: re-chequeo manual demasiado seguido → usar lo mejor que haya, sin fetch.
      cache = cache ?? l2 ?? { at: now, data: null };
    } else {
      let data: LatestBuild | null;
      try {
        data = await fetchLatestBuild();
      } catch {
        data = null; // red caída / timeout → "desconocido"
      }
      cache = { at: now, data };
      await l2Set(cache);
    }
  }
  const latest = cache.data;
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
    checkError: latest === null,
    checkedAt: new Date().toISOString(),
    repoUrl: `https://github.com/${REPO}`,
    compareUrl:
      latest && currentIsNumeric
        ? `https://github.com/${REPO}/compare/${BUILD_INFO.sha}...${latest.sha}`
        : null,
  };
}

/** Sólo para tests: limpia el cache L1 (y best-effort el L2 de Redis). */
export async function __resetUpdateCache(): Promise<void> {
  cache = null;
  try {
    await redis.del(L2_KEY);
  } catch {
    /* ignore */
  }
}
