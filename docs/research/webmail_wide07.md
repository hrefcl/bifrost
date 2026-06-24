# Facet: DevOps, Docker & CI/CD — Landscape Scan

## Scope
Best practices for containerizing, testing, and deploying a Vue.js + Node.js webmail application with Docker, Docker Compose, GitHub Actions, Nginx, and monitoring infrastructure.

---

## Key Findings

### Docker & Docker Compose Architecture

- **Multi-stage builds are the standard** for Vue.js + Node.js applications. The recommended pattern uses a Node.js stage for building (`npm ci && npm run build`) and an Nginx Alpine stage to serve static files, dramatically reducing final image size and eliminating build tooling from production [^212^] [^219^].

- **Docker Compose is production-viable** when health checks, restart policies, and resource limits are properly configured. The official Docker docs recommend using `compose.yaml` as the base file and `compose.production.yaml` for environment-specific overrides applied with `docker compose -f compose.yaml -f compose.production.yaml up -d` [^192^] [^190^].

- **Health checks are non-negotiable** for production. Without them, Docker assumes a container is healthy the moment it starts, even if the application is crashing in a loop. A proper `HEALTHCHECK` instruction tells the orchestrator to remove failed containers from the load balancer rotation and restart them [^153^] [^157^].

- **The `unless-stopped` restart policy** is the production favorite for core services — it auto-recovers from crashes and host reboots but respects manual stops for maintenance. Background tasks should use `on-failure:5` to prevent infinite restart loops [^189^] [^190^].

- **Resource limits prevent cascade failures.** Without `deploy.resources.limits`, a memory leak in one container can take down the entire host. Node.js apps should have at least 512M memory limits; databases need 1G-4G depending on data volume [^191^] [^157^].

- **Log rotation must be configured** before disk fills up. The recommended pattern: `json-file` driver with `max-size: "10m"` and `max-file: "3"`, capping total log size at 30MB per service [^189^] [^190^].

- **Production checklist for Docker Compose:** (1) health checks on all services, (2) `depends_on` with `condition: service_healthy`, (3) `restart: unless-stopped`, (4) resource limits, (5) named volumes (not bind mounts), (6) network isolation for databases, (7) concrete image tags (not `latest`), and (8) backup strategy before deployments [^190^] [^195^].

### GitHub Actions CI/CD Pipeline

- **GitHub Actions remains the default CI/CD for GitHub-hosted projects in 2026**, offering zero-config setup inside repos with YAML workflows in `.github/workflows/` [^140^] [^152^]. Public repos are free; private repos get 2,000 minutes/month on the free tier [^140^].

- **Essential Node.js workflow pattern:** `actions/setup-node@v4` with `cache: 'npm'`, use `npm ci` (not `npm install`) for reproducible builds, and cache dependencies for 3x faster builds [^144^] [^148^].

- **Testing integration with Vitest** (Vue.js preferred test runner) supports coverage reporting with `@vitest/coverage-v8`. Thresholds can be set for lines, functions, branches, and statements (e.g., 85% minimum). GitHub Actions can post coverage reports as PR comments and block merges on low coverage [^216^] [^214^].

- **E2E testing with Playwright** is recommended for Vue.js applications. Playwright offers parallel cross-browser execution, automatic waiting to reduce flakiness, and built-in tracing/video for debugging. CI integration requires: install deps, build app, start server in background, then run `npx playwright test` [^196^] [^194^].

- **Concurrency control** via `concurrency: group: ${{ github.workflow }}-${{ github.ref }}; cancel-in-progress: true` cancels previous runs on the same branch when new pushes arrive, saving CI minutes [^140^].

- **The decay timeline of E2E tests in CI:** Week 1 tests are green; by Month 3 design changes break tests; by Month 5, 40% of E2E tests may be disabled while CI remains "green." Root causes: selector rot, CI runners slower than local machines, environment drift, and maintenance spiral [^154^].

- **Path filtering** triggers CI selectively: `paths: ['src/**', 'tests/**']` ignores README changes, saving Actions minutes [^144^].

- **Four common pitfalls:** (1) secrets in `echo` commands leak to logs, (2) default `GITHUB_TOKEN` has read-only rights in 2026 — explicit `permissions:` are needed for write ops, (3) default 6-hour timeout should be reduced with `timeout-minutes: 30`, (4) self-hosted runners need cleanup to prevent disk exhaustion [^144^].

### Nginx Reverse Proxy & SSL

- **Nginx is the world's most popular web server, reverse proxy, and API gateway** [^149^]. It uses an asynchronous event-driven architecture capable of handling 10,000+ simultaneous connections with ~2.5MB memory per 10k inactive connections [^137^].

- **WebSocket proxying** has been supported since Nginx 1.3.13, including reverse proxy and load balancing of WebSocket applications. Requires `proxy_http_version 1.1` with `Upgrade` and `Connection` header forwarding [^137^] [^150^].

- **Rate limiting uses the leaky bucket algorithm** via `limit_req_zone` (defines key, shared memory zone, and rate) and `limit_req` (applies the limit). A 10MB zone fits ~160,000 IPv4 addresses. Per-IP rate limits should be combined with per-server global limits for layered protection [^164^] [^165^].

- **Recommended rate limiting configuration for APIs:**
  - General traffic: `rate=10r/s` with `burst=20 nodelay`
  - Login endpoints: `rate=1r/s` with `burst=3 nodelay`
  - API endpoints: `rate=30r/s` with `burst=50 delay=30`
  - Return HTTP 429 (not default 503) with `limit_req_status 429` [^167^] [^165^].

- **Connection limiting (`limit_conn`)** complements rate limiting. Cap simultaneous connections per IP (e.g., 20 for general, 2 for downloads). Important: HTTP/2 multiplexing means each concurrent request counts as a separate connection — set limits higher than for HTTP/1.1 [^167^] [^168^].

- **Fail2ban integration** provides automated IP banning for repeat offenders. Configure jails with `maxretry`, `findtime`, and `bantime` to escalate: 10 failures in 60s = 10min ban; 30 failures in 3600s = 24h ban [^167^].

- **Native ACME protocol support** (since August 2025) enables automatic TLS certificate issuance and renewal directly in Nginx, simplifying SSL setup [^137^].

- **Dry run mode** (`limit_req_dry_run on`) allows testing rate limits without rejecting requests, available since Nginx 1.17.1 [^167^].

### Kubernetes Deployment

- **Kubernetes is the recommended orchestration platform** for production at scale, offering auto-scaling, self-healing, and rolling deployments that Docker Compose cannot match on a single host [^161^] [^197^].

- **Three probe types for Node.js applications:**
  - **Liveness probe** (`/health/live`): Is the process alive? Failure triggers container restart. Keep it simple — just check the process responds [^193^] [^200^].
  - **Readiness probe** (`/health/ready`): Can the container handle traffic? Failure removes it from the service load balancer. Should check all critical dependencies (DB, cache, external APIs) [^193^] [^200^].
  - **Startup probe**: For slow-starting apps. Gives the application time to initialize before liveness/readiness probes take effect. Set `failureThreshold * periodSeconds` to cover max expected startup time [^193^] [^199^].

- **Resource requests vs limits in Kubernetes:** `requests` = guaranteed minimum for scheduling; `limits` = hard ceiling (OOM kill if exceeded for memory; throttled for CPU). Typical Node.js app: 256Mi request / 512Mi limit, 100m CPU request / 500m CPU limit [^193^].

- **Graceful shutdown handling** is critical: on `SIGTERM`, set shutting-down flag, finish in-flight requests, then exit. The `terminationGracePeriodSeconds` (default 30s) defines how long Kubernetes waits before force-killing [^193^].

### Monitoring: Prometheus + Grafana

- **Prometheus + Grafana is the standard open-source monitoring stack** for Node.js applications. Prometheus scrapes metrics every 15s (configurable) and stores them for 15 days. Grafana visualizes and enables alerting [^155^] [^162^].

- **`prom-client`** is the official Prometheus client for Node.js. Default metrics include: CPU usage, memory (heap/external), GC duration, event loop lag, active handles/requests. Custom metrics: Histograms for HTTP latency, Counters for request totals, Gauges for active connections [^155^] [^163^].

- **The `/metrics` endpoint** must never be exposed to the public internet. It reveals application internals. Expose only on localhost and let Prometheus scrape from the same machine, or protect behind authentication [^155^].

- **Grafana dashboard ID 11159** (Node.js Application Dashboard) provides a ready-made dashboard with memory, CPU, request rate, error rate, and GC pause panels. Dashboard ID 11074 covers system metrics via node-exporter [^155^].

- **Custom histogram buckets for HTTP latency:**
  ```javascript
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.05, 0.1, 0.5, 1, 2, 5]
  });
  ```
  This enables P50, P95, and P99 latency calculation in Grafana [^155^].

- **Grafana Cloud offers a native Node.js integration** with 1 pre-built dashboard and 1 alert (`NodejsDown`), requiring only `prom-client` with `collectDefaultMetrics()` and a `/metrics` endpoint [^160^].

### Security & Secrets Management

- **Environment variables for secrets are widely used but have significant risks:** visible in process listings (`ps -eww`), inherited by child processes, appear in logs during debugging, and leak into Docker image layers if used as build args [^213^] [^215^].

- **Docker secrets** (Swarm/Compose) encrypt data at rest, mount secrets on a memory-backed filesystem (tmpfs) that disappears when the container stops, and restrict access to only containers that need them [^211^].

- **Docker Compose secrets** (v2.30.0+) support three progressive approaches: (1) mount host env vars as files in `/run/secrets/`, (2) mount secret files directly, (3) external secrets from secret managers. Each service receives only its provisioned secrets [^217^].

- **The `_FILE` suffix convention**: Applications should check for `DB_PASSWORD_FILE` (pointing to a secret file) before falling back to `DB_PASSWORD` env var. This pattern is used by official MySQL and Postgres images [^217^].

- **Multi-stage builds with BuildKit secret mounts** allow accessing secrets during build time without embedding them in final image layers. Use `--mount=type=secret` for temporary access during specific `RUN` steps [^213^].

- **Security hardening checklist:** run as non-root user (`USER nginx` or `user: "1001:1001"`), read-only root filesystem, drop all capabilities (`cap_drop: ALL`), add `no-new-privileges:true` security option, use tmpfs for `/tmp` [^197^] [^157^].

### Full-Stack Vue.js + Node.js + MongoDB + Redis Stack

- **Boilerplate stacks** combining Docker, Vue.js, Node.js/Koa2, Nginx, MongoDB, and Redis exist as reference architectures. These integrate front-end, back-end, and database into a single Docker Compose setup [^138^].

- **Redis** is commonly used for session caching and authentication state in Node.js apps. The `redis` npm package with promisified methods enables async/await patterns. Docker Compose links make Redis accessible via `redis://cache` [^145^].

- **MongoDB** in Docker Compose requires persistent named volumes for data. The `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` env vars initialize the admin user on first start [^142^].

- **Branch-based deployment strategy:** Using git branches (`dev`, `test`, `preprod`, `prod`) with different `docker-compose.yml` versions per branch allows environment-specific configs (volumes for dev, built images for prod) [^146^].

### Webmail-Specific Considerations

- **Self-hosted email** remains notoriously difficult due to deliverability issues (spam filters, IP reputation, DKIM/SPF/DMARC requirements). Mailu and Mailcow are Docker-based solutions packaging Postfix (SMTP), Dovecot (IMAP), Rspamd (spam filter), ClamAV (antivirus), and webmail (Roundcube/Rainloop) [^170^] [^169^].

- **Required DNS records for self-hosted email:** MX record, A record for mail subdomain, SPF TXT record, DKIM TXT record (generated by the mail server), DMARC TXT record, and rDNS/PTR (set via hosting provider) [^170^].

---

## Major Players & Sources

| Entity | Role / Relevance |
|--------|-----------------|
| **Docker Inc.** | Container platform standard; Docker Compose for dev and single-host production |
| **GitHub (Microsoft)** | GitHub Actions is the dominant CI/CD for GitHub-hosted projects; free for public repos |
| **F5 / Nginx** | Nginx is the world's most popular reverse proxy and web server; enterprise support available |
| **Prometheus / Grafana Labs** | Open-source monitoring stack; Grafana Cloud offers managed monitoring with free tier |
| **Kubernetes (CNCF/Google)** | Production orchestration standard for multi-host, high-availability deployments |
| **Playwright (Microsoft)** | Modern E2E testing framework; cross-browser, parallel execution, CI-native |
| **Vitest** | Vue.js/Vite-native unit test runner; fast, with built-in coverage via v8 provider |
| **Wiz / GitGuardian** | Container security and secrets detection; secrets scanning in CI/CD pipelines |
| **Mailu / Mailcow** | Docker-based self-hosted email solutions with webmail, SMTP, IMAP, spam filtering |
| **Node.js (OpenJS Foundation)** | Runtime for backend; prom-client for metrics; console.log → stdout/stderr for Docker |

---

## Trends & Signals

- **Docker Compose is increasingly production-viable** for small-to-medium deployments. With health checks, restart policies, resource limits, and secrets management, many teams are skipping Kubernetes for simpler setups [^192^] [^190^].

- **GitHub Actions has become the default CI/CD** for GitHub-first teams, displacing Jenkins for new projects due to zero-config setup and native GitHub integration [^152^] [^140^].

- **Multi-stage Docker builds are now the expected standard** for frontend applications. The pattern of "build with Node, serve with Nginx Alpine" is documented by Docker's official guides and community best practices [^212^] [^219^].

- **Observability is shifting left** — monitoring integration from day one is now considered standard practice, not a post-deployment afterthought. Prometheus metrics are being embedded into application code via prom-client [^155^] [^172^].

- **Security hardening is becoming automated.** Tools like `dotenv-linter`, Trivy, and Clair scan containers and env files for vulnerabilities. Secrets detection is moving into CI/CD pipelines with tools like Wiz Code and GitGuardian [^218^] [^211^].

- **Nginx rate limiting is evolving** beyond simple IP-based rules. Modern configurations use per-URI limits, API-key-based limits, geo-based restrictions, and dry-run testing before enforcement [^167^] [^165^].

- **Playwright is displacing Selenium and Cypress** for modern JavaScript E2E testing due to faster execution, better cross-browser support, and native CI integration [^194^] [^198^].

---

## Controversies & Conflicting Claims

- **Docker Compose vs Kubernetes for production:** Docker Inc. and practitioners like Nick Janetakis argue Compose is production-ready for many scenarios [^201^], while Bunnyshell and others argue it lacks native orchestration, HA, and self-healing for large-scale deployments [^161^]. The consensus: Compose for single-host/small teams; Kubernetes for multi-host/enterprise scale.

- **Environment variables vs Docker secrets:** Despite widespread use of `.env` files, security experts argue against env vars for secrets due to process visibility and child process inheritance [^215^]. Docker secrets (file-based mounts) are preferred, though many teams find them less convenient [^213^] [^217^].

- **Vitest vs Jest for Vue.js:** While Vue CLI historically used Jest [^147^], the modern Vite ecosystem has shifted to Vitest for faster execution and native Vite integration. Teams on older Vue CLI projects face migration decisions [^216^].

- **E2E test maintenance burden:** There is a growing recognition that E2E tests create significant maintenance overhead. The "decay timeline" describes how tests go from green to 40% disabled within months due to UI changes and flaky selectors [^154^]. Some advocate for fewer, more focused E2E tests combined with robust unit testing.

- **Nginx open source vs Nginx Plus:** The free version handles rate limiting, SSL, and WebSocket proxying. Nginx Plus adds advanced load balancing, expanded metrics, and commercial support. For most self-hosted webmail apps, open source Nginx is sufficient [^137^].

- **Self-hosted email deliverability:** Running your own email server is technically feasible with Docker-based solutions like Mailu, but many experts warn that achieving reliable deliverability (avoiding spam folders) requires dedicated IP addresses, proper DNS records, and ongoing reputation management that may outweigh the benefits for small teams [^170^].

---

## Recommended Deep-Dive Areas

1. **Multi-stage Dockerfile optimization for Vite + Vue.js**: The official Docker guide provides a solid starting point [^212^], but customizing the Nginx configuration for SPA routing (fallback to `index.html` for Vue Router history mode) and API proxying requires additional study.

2. **GitHub Actions workflow design**: Investigate reusable workflows for DRY pipelines across multiple environments, matrix builds for testing across Node.js versions, and the vitest-coverage-report-action for PR coverage comments [^216^] [^214^].

3. **Nginx configuration for webmail-specific requirements**: WebSocket support for real-time email notifications, rate limiting for login endpoints and API routes, SSL/TLS termination, and SPA routing fallbacks. The complete rate limiting guide with fail2ban integration is essential reading [^167^].

4. **Prometheus + Grafana dashboard creation**: Building on community dashboards (ID 11159, 11074), create custom panels for webmail-specific metrics: unread message counts, email send/receive latency, attachment size tracking, active WebSocket connections [^155^] [^156^].

5. **Kubernetes migration path**: Design health check endpoints (`/health/live`, `/health/ready`) from day one using the HealthChecker pattern [^193^], so migration from Docker Compose to Kubernetes requires only YAML manifests, not application changes.

6. **Secrets management architecture**: Evaluate Docker Compose secrets vs external secret managers (HashiCorp Vault, AWS Secrets Manager) vs CI/CD secret injection. The `_FILE` suffix convention enables migration between approaches without application changes [^217^].

7. **E2E testing strategy for webmail**: Playwright testing of critical email workflows (compose, send, receive, attachment upload, search) with test isolation and data seeding. Address flakiness through explicit waits, API pre-seeding, and parallel test execution [^196^] [^194^].

8. **Docker security scanning integration**: Add Trivy or Clair container scanning to the GitHub Actions pipeline to catch vulnerabilities before deployment. Integrate with secrets scanning (GitGuardian, Wiz Code) for defense in depth [^218^] [^211^].

---

## Sources Summary

| # | Source | Key Insight |
|---|--------|-------------|
| [^137^] | Wikipedia — Nginx | Feature overview: 10k+ connections, WebSocket, HTTP/2, HTTP/3, mail proxy |
| [^138^] | docker-vue-node-nginx-mongodb-redis | Full-stack boilerplate with Vue2, Koa2, MongoDB, Redis, Nginx |
| [^140^] | GitHub Actions in 2026 (dev.to) | Free tier, concurrency control, cache, path filtering, reusable workflows |
| [^142^] | Stack Overflow — Production vs Development Docker | NODE_ENV management, volume mounting, development vs production configs |
| [^144^] | GitHub Actions Tutorial 2026 (qytera.de) | Node.js 20, npm ci, caching, trigger events, common pitfalls |
| [^145^] | Code with Hugo — Express + Redis + Docker Compose | Redis integration, docker-compose.yml linking |
| [^146^] | Medium — Production Docker with Node.js, MongoDB, Redis, Next.js | Branch-based deployment, multiple docker-compose.yml versions |
| [^147^] | Medium — Vue coverage on GitHub Actions | Jest + Vue3 + TypeScript + GitHub Actions coverage setup |
| [^148^] | CoreUI — GitHub Actions for Node.js | setup-node@v4, cache, npm ci, artifact upload/download |
| [^150^] | Nginx Reverse Proxy Documentation | proxy_pass, WebSocket proxying, header modification |
| [^152^] | GitHub Actions vs Jenkins 2026 | Comparison table, GitHub Actions default for GitHub teams |
| [^153^] | Docker Best Practices for Production 2026 | HEALTHCHECK, stdout/stderr logging, timezone configuration |
| [^154^] | GitHub Actions automated testing guide | E2E test decay timeline, selector rot, CI runner slowness |
| [^155^] | Monitor Node.js with Prometheus and Grafana | Complete setup: prom-client, histograms, Grafana dashboards |
| [^157^] | Docker Production Best Practices 2026 | Security, health checks, resource limits, non-root user |
| [^160^] | Grafana Cloud Node.js Integration | Pre-built dashboard, NodejsDown alert, /metrics endpoint |
| [^161^] | Docker Compose for Production (bunnyshell.com) | Limitations: no HA, no self-healing, scaling issues |
| [^162^] | Node.js Monitoring with Prometheus and Grafana | prom-client Registry, default metrics, docker-compose cluster |
| [^163^] | Monitor Node.js TypeScript with Prometheus/Grafana | Histogram, Counter, Gauge examples, custom dashboard queries |
| [^164^] | Nginx Limiting Access Documentation | limit_req_zone, limit_conn_zone, burst, nodelay |
| [^165^] | NGINX Rate Limiting Complete Guide 2026 | Leaky bucket algorithm, logging, multiple zones, dry_run |
| [^167^] | Nginx Rate Limiting and DDoS Protection (virtua.cloud) | Complete 3-layer config with fail2ban, allowlisting, testing |
| [^168^] | Rate Limiting Configuration in Nginx (cubepath.com) | Best practices, distributed architectures, security hardening |
| [^169^] | Mailcow Setup Guide 2026 | Self-hosted email with Docker, DNS configuration |
| [^170^] | Self-Hosting in 2026 (zeonedge.com) | Mailu Docker deployment, DNS records, DKIM/SPF/DMARC |
| [^172^] | Ultimate Full-Stack Deployment Guide 2026 | Monitoring stack, common mistakes, best practices |
| [^189^] | Docker Compose Production Deployment (eastondev.com) | Health checks, restart policies, resource limits, FAQ |
| [^190^] | Docker Compose in Production 12 Best Practices (techz.at) | File structure, secrets, restart policies, health checks, resource limits |
| [^191^] | Docker Compose Best Practices (patrykgolabek.dev) | CV rules for health checks, resource limits, restart policies |
| [^192^] | Docker Docs — Use Compose in production | Multiple compose files, production overrides, deployment commands |
| [^193^] | Node.js Health Checks for Kubernetes (oneuptime.com) | HealthChecker class, liveness/readiness probes, graceful shutdown |
| [^194^] | Playwright E2E Testing in CI/CD (gtinfotech.co.in) | Benefits: speed, reliability, CI integration, cross-browser |
| [^195^] | Docker Compose in Production Practical Guide (medium.com) | Separate configs, named volumes, environment variables, backup strategy |
| [^196^] | Testing Vue.js with Playwright (dev.to) | Vue Router navigation, reactive state testing, CI/CD integration |
| [^197^] | Docker Compose Complete Guide (cubepath.com) | Security best practices, production config, resource limits |
| [^198^] | Ultimate Guide to E2E Testing in CI/CD (ranger.net) | Playwright vs Selenium vs Cypress, flaky test handling |
| [^199^] | Kubernetes Health Checks Guide (semaphore.io) | Startup, liveness, readiness probes explained |
| [^200^] | Node.js in a Kubernetes World (OpenJS Foundation) | Health endpoints, probe types, cloud-health package |
| [^201^] | Production-Ready Web Apps with Docker Compose (nickjanetakis.com) | Port binding security, restart policies, non-root user |
| [^211^] | Docker Secrets Explained (wiz.io) | Encryption, isolation, vs Kubernetes secrets, best practices |
| [^212^] | Docker Docs — Containerize a Vue.js App | Official multi-stage build guide with Node + Nginx Alpine |
| [^213^] | Best Practices for Environment Variables (gitguardian.com) | Security risks, secrets managers, container approaches |
| [^214^] | GitHub Actions to Run Vitest (stevekinney.com) | Workflow setup, coverage reporting, artifact upload |
| [^215^] | Do Not Use Secrets in Environment Variables (nodejs-security.com) | 7 reasons why env vars are risky, proposed alternatives |
| [^216^] | Vitest Code Coverage with GitHub Actions (medium.com) | Thresholds, PR comments, coverage comparison, quality gates |
| [^217^] | Managing Secrets in Docker Compose (phase.dev) | Three progressive approaches, _FILE suffix convention |
| [^218^] | Handling Environment Variables in Docker Compose (medium.com) | dotenv-linter, Trivy/Clair scanning, CI/CD integration |
| [^219^] | Containerizing SPA with Multi-Stage Nginx Build (dev.to) | Vue/Vite/React pattern, non-root user, custom nginx.conf |
