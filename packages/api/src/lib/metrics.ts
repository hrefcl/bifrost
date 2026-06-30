/** Contadores de proceso en memoria para /metrics (Prometheus text format). */
export const counters = {
  requests: 0,
  errors5xx: 0,
  bootstrapAdminGrants: 0,
  // Bifrost Meet (in-memory single-node — se resetean al reiniciar el proceso; ver DESIGN §13).
  meetRoomsCreated: 0,
  meetTokensIssued: 0,
};

// Histograma de latencia de requests (segundos). Buckets cumulativos estilo Prometheus.
const BUCKETS = [0.01, 0.05, 0.1, 0.3, 1, 3, 10];
const histo = { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };

/** Registra la duración de un request (en segundos). */
export function observeDuration(seconds: number): void {
  histo.count++;
  histo.sum += seconds;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (seconds <= BUCKETS[i]) histo.counts[i]++;
  }
}

function histogramLines(): string[] {
  const lines = [
    '# HELP webmail_request_duration_seconds Request latency',
    '# TYPE webmail_request_duration_seconds histogram',
  ];
  for (let i = 0; i < BUCKETS.length; i++) {
    lines.push(
      `webmail_request_duration_seconds_bucket{le="${String(BUCKETS[i])}"} ${String(histo.counts[i])}`
    );
  }
  lines.push(`webmail_request_duration_seconds_bucket{le="+Inf"} ${String(histo.count)}`);
  lines.push(`webmail_request_duration_seconds_sum ${histo.sum.toFixed(6)}`);
  lines.push(`webmail_request_duration_seconds_count ${String(histo.count)}`);
  return lines;
}

export function renderMetrics(): string {
  const mem = process.memoryUsage();
  return (
    [
      '# HELP webmail_uptime_seconds Process uptime in seconds',
      '# TYPE webmail_uptime_seconds gauge',
      `webmail_uptime_seconds ${String(Math.round(process.uptime()))}`,
      '# HELP webmail_memory_rss_bytes Resident set size',
      '# TYPE webmail_memory_rss_bytes gauge',
      `webmail_memory_rss_bytes ${String(mem.rss)}`,
      '# HELP webmail_heap_used_bytes Heap used',
      '# TYPE webmail_heap_used_bytes gauge',
      `webmail_heap_used_bytes ${String(mem.heapUsed)}`,
      '# HELP webmail_requests_total Total HTTP responses served',
      '# TYPE webmail_requests_total counter',
      `webmail_requests_total ${String(counters.requests)}`,
      '# HELP webmail_errors_5xx_total Total 5xx responses',
      '# TYPE webmail_errors_5xx_total counter',
      `webmail_errors_5xx_total ${String(counters.errors5xx)}`,
      // Evento de seguridad: cuántas veces se otorgó admin por bootstrap (debería ser 0 ó 1 por
      // instalación). Un valor >1 o creciente = anomalía → alertar.
      '# HELP webmail_bootstrap_admin_grants_total Admin role granted via first-user bootstrap',
      '# TYPE webmail_bootstrap_admin_grants_total counter',
      `webmail_bootstrap_admin_grants_total ${String(counters.bootstrapAdminGrants)}`,
      '# HELP webmail_meet_rooms_created_total Bifrost Meet rooms created',
      '# TYPE webmail_meet_rooms_created_total counter',
      `webmail_meet_rooms_created_total ${String(counters.meetRoomsCreated)}`,
      '# HELP webmail_meet_tokens_issued_total Bifrost Meet access tokens issued',
      '# TYPE webmail_meet_tokens_issued_total counter',
      `webmail_meet_tokens_issued_total ${String(counters.meetTokensIssued)}`,
      ...histogramLines(),
    ].join('\n') + '\n'
  );
}
