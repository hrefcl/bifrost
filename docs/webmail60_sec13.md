# 13. CI/CD y DevOps

La infraestructura de integración continua y despliegue continuo de Webmail 6.0 está diseñada para operar directamente sobre Docker Compose, que — con health checks, restart policies y resource limits apropiados — es una solución productiva para despliegues self-hosted de pequeña y mediana escala [^192^] [^190^]. Kubernetes se contempla como migración futura para escenarios enterprise.

## 13.1 GitHub Actions Pipeline

GitHub Actions es la plataforma de CI/CD por defecto para proyectos alojados en GitHub en 2026, ofreciendo configuración zero-config con workflows YAML en `.github/workflows/` [^140^] [^152^]. El pipeline se divide en tres workflows independientes.

### 13.1.1 CI: Install → Lint → Unit → Integration → Build → Coverage

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
    paths:
      - 'packages/**'
      - '.github/workflows/**'
      - 'docker-compose*.yml'
      - 'package.json'
      - 'pnpm-workspace.yaml'
  pull_request:
    branches: [main, develop]
    paths:
      - 'packages/**'
      - '.github/workflows/**'
      - 'package.json'
      - 'pnpm-workspace.yaml'

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  changes:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    outputs:
      api: ${{ steps.filter.outputs.api }}
      web: ${{ steps.filter.outputs.web }}
      shared: ${{ steps.filter.outputs.shared }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            api: ['packages/api/**', 'packages/shared/**']
            web: ['packages/web/**', 'packages/shared/**']
            shared: ['packages/shared/**']

  lint:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    needs: changes
    if: ${{ needs.changes.outputs.api == 'true' || needs.changes.outputs.web == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck

  unit-test:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    needs: [changes, lint]
    if: ${{ needs.changes.outputs.api == 'true' || needs.changes.outputs.web == 'true' || needs.changes.outputs.shared == 'true' }}
    strategy:
      fail-fast: false
      matrix:
        package: [api, web, shared]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - name: Run unit tests with coverage
        run: |
          cd packages/${{ matrix.package }}
          pnpm vitest run --coverage --reporter=json --reporter=text --outputFile=coverage-report.json

      - name: Upload coverage artifact
        uses: actions/upload-artifact@v4
        with:
          name: coverage-${{ matrix.package }}
          path: packages/${{ matrix.package }}/coverage/
          retention-days: 7

  integration-test:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    needs: [changes, lint]
    if: ${{ needs.changes.outputs.api == 'true' || needs.changes.outputs.shared == 'true' }}
    services:
      mongo:
        image: mongo:7.0.16
        ports: ['27017:27017']
        env:
          MONGO_INITDB_ROOT_USERNAME: test
          MONGO_INITDB_ROOT_PASSWORD: testpass
        options: >-
          --health-cmd "mongosh --eval 'db.adminCommand(\"ping\")'"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7.4-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 3s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - name: Run integration tests
        run: cd packages/api && pnpm vitest run --config vitest.integration.config.ts
        env:
          MONGODB_URI: mongodb://test:testpass@localhost:27017/test?authSource=admin
          REDIS_URL: redis://localhost:6379
          JWT_SECRET: ci-test-secret-32-bytes-long!!!
          ENCRYPTION_KEY: aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
          NODE_ENV: test

  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    needs: [unit-test, integration-test]
    if: always() && (needs.unit-test.result == 'success') && (needs.integration-test.result == 'success' || needs.integration-test.result == 'skipped')
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: |
            packages/api/dist/
            packages/web/dist/
            packages/shared/dist/
          retention-days: 7

  coverage-report:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    needs: unit-test
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          pattern: coverage-*
          merge-multiple: true

      - name: Post coverage comment to PR
        uses: davelosert/vitest-coverage-report-action@v2
        with:
          json-summary-path: ./coverage/coverage-summary.json
          file-coverage-mode: changes
          reportOnFailure: true
```

### 13.1.2 E2E: Build → Docker Compose → Playwright

```yaml
# .github/workflows/e2e.yml
name: E2E Tests

on:
  push:
    branches: [main, develop]
    paths:
      - 'packages/**'
      - 'docker-compose*.yml'
      - 'Dockerfile*'
  pull_request:
    branches: [main]
    paths:
      - 'packages/**'
      - 'docker-compose*.yml'
      - 'Dockerfile*'

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and start services
        run: |
          docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build

      - name: Wait for services healthy
        run: |
          for i in {1..30}; do
            if docker compose ps | grep -q "unhealthy"; then
              echo "Waiting for services..."
              sleep 5
            else
              echo "All services healthy"
              break
            fi
          done

      - name: Seed test data
        run: |
          docker compose exec -T api node /app/scripts/seed-e2e.js

      - name: Run Playwright tests
        run: |
          cd packages/web
          npx playwright install --with-deps chromium
          npx playwright test --project=chromium
        env:
          BASE_URL: http://localhost:8080
          MAILSLURP_API_KEY: ${{ secrets.MAILSLURP_API_KEY }}

      - name: Upload Playwright report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: packages/web/playwright-report/
          retention-days: 7

      - name: Upload test screenshots
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-screenshots
          path: packages/web/test-results/
          retention-days: 7

      - name: Tear down
        if: always()
        run: docker compose down -v --remove-orphans
```

### 13.1.3 CD: Build Docker → Push Registry → Deploy

```yaml
# .github/workflows/cd.yml
name: CD - Deploy to Production

on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      environment:
        description: 'Entorno de despliegue'
        required: true
        default: 'staging'
        type: choice
        options: [staging, production]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        service: [api, web]
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/${{ matrix.service }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix={{branch}}-
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: packages/${{ matrix.service }}/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64,linux/arm64

  deploy-staging:
    runs-on: ubuntu-24.04
    needs: build-and-push
    if: github.event.inputs.environment == 'staging' || startsWith(github.ref, 'refs/tags/v')
    environment:
      name: staging
      url: https://staging.webmail6.local
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to staging server
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.STAGING_HOST }}
          username: ${{ secrets.STAGING_USER }}
          key: ${{ secrets.STAGING_SSH_KEY }}
          script: |
            cd /opt/webmail6
            docker compose pull
            docker compose up -d --remove-orphans
            docker system prune -f

  deploy-production:
    runs-on: ubuntu-24.04
    needs: [build-and-push, deploy-staging]
    if: github.event.inputs.environment == 'production'
    environment:
      name: production
      url: https://webmail6.local
    steps:
      - name: Deploy to production
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.PROD_HOST }}
          username: ${{ secrets.PROD_USER }}
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /opt/webmail6
            docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
            docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans
            docker system prune -f
```

## 13.2 Docker Configuration

### 13.2.1 Multi-stage Dockerfile Frontend

El frontend sigue el patrón estándar: build con Node.js, servir con Nginx Alpine. Esta aproximación reduce drásticamente el tamaño de la imagen final al eliminar herramientas de build [^212^] [^219^].

```dockerfile
# packages/web/Dockerfile
# ────────────────────────────────
# Stage 1: Build
# ────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Instalar pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copiar archivos de workspace
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/web/package.json packages/web/tsconfig.json packages/web/vite.config.ts packages/web/tailwind.config.js packages/web/postcss.config.js ./packages/web/

# Instalar dependencias
RUN pnpm install --frozen-lockfile

# Copiar código fuente
COPY packages/shared/src ./packages/shared/src
COPY packages/web/src ./packages/web/src
COPY packages/web/index.html ./packages/web/

# Build de shared primero
RUN pnpm --filter @webmail6/shared build

# Build del frontend (Vite)
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @webmail6/web build

# ────────────────────────────────
# Stage 2: Serve con Nginx
# ────────────────────────────────
FROM nginx:1.27-alpine AS production

# Eliminar configuración por defecto
RUN rm -f /etc/nginx/conf.d/default.conf

# Configuración de Nginx para SPA
COPY packages/web/nginx.conf /etc/nginx/conf.d/webmail.conf

# Archivos estáticos del build
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:80/health || exit 1

EXPOSE 80

# Non-root user
USER nginx

CMD ["nginx", "-g", "daemon off;"]
```

### 13.2.2 Multi-stage Dockerfile Backend

```dockerfile
# packages/api/Dockerfile
# ────────────────────────────────
# Stage 1: Dependencies
# ────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/

RUN pnpm install --frozen-lockfile --prod

# ────────────────────────────────
# Stage 2: Builder
# ────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/

RUN pnpm install --frozen-lockfile

COPY packages/shared/src ./packages/shared/src
COPY packages/api/src ./packages/api/src

RUN pnpm --filter @webmail6/shared build
RUN pnpm --filter @webmail6/api build

# ────────────────────────────────
# Stage 3: Production
# ────────────────────────────────
FROM node:22-slim AS production
WORKDIR /app

# Security hardening
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r webmail && useradd -r -g webmail webmail

# Copiar solo lo necesario
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/package.json ./packages/api/
COPY package.json pnpm-workspace.yaml ./

# Scripts de seed y migración
COPY packages/api/scripts ./packages/api/scripts

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health/live || exit 1

EXPOSE 3000

USER webmail

CMD ["node", "packages/api/dist/index.js"]
```

### 13.2.3 Docker Compose Dev vs Prod

```yaml
# docker-compose.override.yml (desarrollo local)
services:
  api:
    build:
      target: builder
    command: pnpm --filter @webmail6/api dev
    environment:
      NODE_ENV: development
      LOG_LEVEL: debug
      MONGODB_URI: mongodb://admin:devpass@mongo:27017/webmail6?authSource=admin
      REDIS_URL: redis://redis:6379
      JWT_SECRET: dev-jwt-secret-change-in-production
      ENCRYPTION_KEY: 0000000000000000000000000000000000000000000000000000000000000000
      SEAWEEDFS_ENDPOINT: http://seaweedfs:8333
      FRONTEND_URL: http://localhost:5173
    ports:
      - "3000:3000"
    volumes:
      - ./packages/api/src:/app/packages/api/src:ro
      - ./packages/shared/src:/app/packages/shared/src:ro

  web:
    build:
      context: .
      dockerfile: packages/web/Dockerfile
      target: builder
    command: pnpm --filter @webmail6/web dev --host
    environment:
      NODE_ENV: development
    ports:
      - "5173:5173"
    volumes:
      - ./packages/web/src:/app/packages/web/src:ro
      - ./packages/shared/src:/app/packages/shared/src:ro

  nginx:
    profiles: [prod]  # No levantar nginx en dev
```

```yaml
# docker-compose.prod.yml (producción)
services:
  api:
    restart: unless-stopped
    deploy:
      replicas: 2
      resources:
        limits: { cpus: '1.0', memory: 512M }
        reservations: { cpus: '0.25', memory: 128M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }

  web:
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 64M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  nginx:
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    deploy:
      resources:
        limits: { cpus: '0.25', memory: 128M }

  mongo:
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: '2.0', memory: 2G }
        reservations: { memory: 512M }

  redis:
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 512M }

  seaweedfs:
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: '1.0', memory: 2G }

  # Prometheus para métricas
  prometheus:
    image: prom/prometheus:v3.0.1
    container_name: webmail6_prometheus
    restart: unless-stopped
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    ports:
      - "9090:9090"
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=15d'
    networks:
      - webmail6_net

  # Grafana para visualización
  grafana:
    image: grafana/grafana:11.4.0
    container_name: webmail6_grafana
    restart: unless-stopped
    volumes:
      - grafana_data:/var/lib/grafana
      - ./monitoring/grafana-dashboards:/etc/grafana/provisioning/dashboards:ro
      - ./monitoring/grafana-datasources.yml:/etc/grafana/provisioning/datasources/datasources.yml:ro
    ports:
      - "3001:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD__FILE: /run/secrets/grafana_admin_password
    secrets:
      - grafana_admin_password
    networks:
      - webmail6_net

  # Node Exporter para métricas del host
  node-exporter:
    image: prom/node-exporter:v1.8.2
    container_name: webmail6_node_exporter
    restart: unless-stopped
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.rootfs=/rootfs'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    networks:
      - webmail6_net

volumes:
  prometheus_data:
  grafana_data:

secrets:
  grafana_admin_password:
    environment: GRAFANA_ADMIN_PASSWORD
```

```yaml
# docker-compose.test.yml (E2E testing)
services:
  api:
    build:
      dockerfile: packages/api/Dockerfile
      target: production
    environment:
      NODE_ENV: test
      MONGODB_URI: mongodb://admin:testpass@mongo:27017/webmail6_test?authSource=admin
      JWT_SECRET: test-jwt-secret-32-bytes-long!!!
      ENCRYPTION_KEY: 0000000000000000000000000000000000000000000000000000000000000000

  mongo:
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: testpass

  # MailSlurp mock server para E2E
  mailslurp-mock:
    image: mailslurp/mailslurp:latest
    container_name: webmail6_mailslurp
    ports:
      - "1080:1080"
      - "2587:2587"
      - "2045:2045"
      - "4025:4025"
      - "1143:1143"
      - "3002:3002"
    networks:
      - webmail6_net
    profiles: [e2e]
```

## 13.3 Nginx Configuration

### 13.3.1 Reverse Proxy: /api → Fastify, /ws → Socket.IO, SPA Fallback

Nginx actúa como reverse proxy, terminador SSL y punto único de entrada. Su arquitectura event-driven soporta 10,000+ conexiones simultáneas con ~2.5MB de memoria por 10k conexiones inactivas [^149^].

```nginx
# nginx/conf.d/webmail.conf
upstream api_backend {
    server api:3000;
    keepalive 32;
}

upstream ws_backend {
    server api:3001;
    keepalive 32;
}

# Rate limiting zones
limit_req_zone $binary_remote_addr zone=login:10m rate=1r/s;
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=addr:10m;

# Map para WebSocket upgrade
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name _;

    # Redirect HTTP to HTTPS in production
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name webmail6.local;

    # SSL certificates (Let's Encrypt or self-signed)
    ssl_certificate /etc/letsencrypt/live/webmail6.local/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webmail6.local/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' wss: https:; font-src 'self';" always;

    # Rate limiting general
    limit_req zone=general burst=20 nodelay;
    limit_conn addr 20;

    # API proxy (Fastify)
    location /api/ {
        limit_req zone=api burst=50 delay=30;
        limit_req_status 429;

        proxy_pass http://api_backend/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }

    # Login endpoint (rate limit estricto)
    location /api/v1/auth/login {
        limit_req zone=login burst=3 nodelay;
        limit_req_status 429;

        proxy_pass http://api_backend/api/v1/auth/login;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket proxy (Socket.IO)
    location /ws/ {
        proxy_pass http://ws_backend/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Métricas Prometheus (protegidas, solo red interna)
    location /metrics {
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 127.0.0.1;
        deny all;

        proxy_pass http://api_backend/metrics;
        proxy_http_version 1.1;
    }

    # Static files (SPA)
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;

        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    # Error pages
    error_page 429 @rate_limit;
    location @rate_limit {
        return 429 '{"error":"Rate limit exceeded","retryAfter":"60"}';
        add_header Content-Type application/json;
    }
}
```

### 13.3.2 Rate Limiting Configuración

| Endpoint | Zone | Rate | Burst | Propósito |
|----------|------|------|-------|-----------|
| `/api/v1/auth/login` | login | 1 r/s | 3 | Protección contra fuerza bruta |
| `/api/v1/auth/*` | general | 10 r/s | 20 | Autenticación general |
| `/api/v1/emails/*` | api | 30 r/s | 50 | Operaciones de email |
| `/ws/*` | - | - | - | WebSocket sin rate limit |
| `/` (SPA) | general | 10 r/s | 20 | Assets estáticos |

La configuración retorna HTTP 429 para rate limits excedidos, con cabecera `Retry-After` [^167^].

### 13.3.3 SSL Let's Encrypt

```bash
# Certbot para Let's Encrypt (primera vez)
docker run -it --rm \
  -v certbot_data:/etc/letsencrypt \
  -v /var/www/certbot:/var/www/certbot \
  certbot/certbot certonly \
  --standalone \
  -d webmail6.local \
  --agree-tos \
  --email admin@webmail6.local \
  --non-interactive

# Renovación automática (cron cada 12 horas)
# En docker-compose.prod.yml añadir:
  certbot:
    image: certbot/certbot:v3.0.1
    container_name: webmail6_certbot
    volumes:
      - certbot_data:/etc/letsencrypt
      - /var/www/certbot:/var/www/certbot
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew; sleep 12h; done'"
    networks:
      - webmail6_net
```

## 13.4 Monitoreo

### 13.4.1 prom-client y Métricas Custom

`prom-client` es el cliente oficial de Prometheus para Node.js. Incluye métricas por defecto (CPU, memoria, GC, event loop lag) y permite definir métricas custom para el dominio de email [^155^] [^163^].

```typescript
// packages/api/src/config/metrics.ts
import client from 'prom-client';

// Métricas por defecto (heap, CPU, event loop)
client.collectDefaultMetrics({
  register: client.register,
  prefix: 'webmail6_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// Histograma de latencia HTTP
export const httpDuration = new client.Histogram({
  name: 'webmail6_http_request_duration_seconds',
  help: 'Duración de requests HTTP en segundos',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [client.register],
});

// Contador de requests
export const httpRequests = new client.Counter({
  name: 'webmail6_http_requests_total',
  help: 'Total de requests HTTP',
  labelNames: ['method', 'route', 'status_code'],
  registers: [client.register],
});

// Gauge de conexiones WebSocket activas
export const wsConnections = new client.Gauge({
  name: 'webmail6_websocket_connections_active',
  help: 'Conexiones WebSocket activas',
  labelNames: ['user'],
  registers: [client.register],
});

// Gauge de cuentas IMAP conectadas
export const imapConnections = new client.Gauge({
  name: 'webmail6_imap_connections_active',
  help: 'Conexiones IMAP activas por cuenta',
  labelNames: ['account_id'],
  registers: [client.register],
});

// Contador de emails enviados
export const emailsSent = new client.Counter({
  name: 'webmail6_emails_sent_total',
  help: 'Total de emails enviados',
  labelNames: ['account_id', 'status'],
  registers: [client.register],
});

// Contador de emails sincronizados
export const emailsSynced = new client.Counter({
  name: 'webmail6_emails_synced_total',
  help: 'Emails sincronizados desde IMAP',
  labelNames: ['account_id', 'folder'],
  registers: [client.register],
});

// Histograma de tamaño de adjuntos
export const attachmentSize = new client.Histogram({
  name: 'webmail6_attachment_size_bytes',
  help: 'Tamaño de adjuntos procesados',
  buckets: [1024, 1048576, 10485760, 52428800, 104857600], // 1KB, 1MB, 10MB, 50MB, 100MB
  registers: [client.register],
});

export { client };
```

```typescript
// packages/api/src/plugins/metrics.ts
import type { FastifyInstance } from 'fastify';
import { client, httpDuration, httpRequests } from '../config/metrics.js';

export async function metricsPlugin(app: FastifyInstance) {
  // Hook para medir latencia de cada request
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routerPath || 'unknown';
    const labels = {
      method: request.method,
      route,
      status_code: reply.statusCode.toString(),
    };

    httpDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequests.inc(labels);
  });

  // Endpoint /metrics (solo accesible internamente via Nginx)
  app.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', client.register.contentType);
    return client.register.metrics();
  });
}
```

### 13.4.2 Grafana Dashboard

```yaml
# monitoring/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: webmail6
    replica: '{{.ExternalURL}}'

scrape_configs:
  - job_name: 'webmail6-api'
    static_configs:
      - targets: ['api:3000']
    metrics_path: /metrics
    scrape_interval: 15s

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'nginx'
    static_configs:
      - targets: ['nginx:9113']

  - job_name: 'mongodb'
    static_configs:
      - targets: ['mongo:9216']

  - job_name: 'redis'
    static_configs:
      - targets: ['redis:9121']
```

```yaml
# monitoring/grafana-datasources.yml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
```

| Panel | Query | Umbral de Alerta |
|-------|-------|-----------------|
| RPS (requests/seg) | `rate(webmail6_http_requests_total[5m])` | - |
| Latencia P95 | `histogram_quantile(0.95, rate(webmail6_http_request_duration_seconds_bucket[5m]))` | > 2s |
| Error Rate | `rate(webmail6_http_requests_total{status_code=~"5.."}[5m])` | > 1% |
| Conexiones IMAP activas | `webmail6_imap_connections_active` | > 200 |
| Conexiones WebSocket | `webmail6_websocket_connections_active` | - |
| Emails sincronizados/min | `rate(webmail6_emails_synced_total[5m])` | < 0.1 en 10 min |
| Memoria Node.js | `nodejs_heap_size_used_bytes / 1024 / 1024` | > 400MB |
| Event Loop Lag | `nodejs_eventloop_lag_seconds` | > 0.5s |

El dashboard base de Grafana ID 11159 (Node.js Application Dashboard) proporciona paneles pre-configurados para memoria, CPU, request rate, error rate y pausas de GC [^155^]. ID 11074 cubre métricas del sistema vía node-exporter.

### 13.4.3 Health Checks /health/live y /health/ready

```typescript
// packages/api/src/routes/health.ts
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { redis } from '../config/redis.js';

interface HealthStatus {
  status: 'ok' | 'error';
  checks: Record<string, { status: 'ok' | 'error'; responseTime?: number; message?: string }>;
}

export async function healthRoutes(app: FastifyInstance) {
  // Liveness: ¿El proceso está vivo?
  app.get('/live', async () => ({ status: 'ok' }));

  // Readiness: ¿Puede aceptar tráfico?
  app.get('/ready', async (request, reply) => {
    const status: HealthStatus = {
      status: 'ok',
      checks: {},
    };

    // Check MongoDB
    const dbStart = Date.now();
    try {
      if (mongoose.connection.readyState !== 1) {
        throw new Error('MongoDB not connected');
      }
      await mongoose.connection.db!.admin().command({ ping: 1 });
      status.checks.mongodb = { status: 'ok', responseTime: Date.now() - dbStart };
    } catch (err: any) {
      status.checks.mongodb = { status: 'error', message: err.message };
      status.status = 'error';
    }

    // Check Redis
    const redisStart = Date.now();
    try {
      await redis.ping();
      status.checks.redis = { status: 'ok', responseTime: Date.now() - redisStart };
    } catch (err: any) {
      status.checks.redis = { status: 'error', message: err.message };
      status.status = 'error';
    }

    // Check SeaweedFS
    const s3Start = Date.now();
    try {
      // HEAD request al bucket
      const response = await fetch(`${process.env.SEAWEEDFS_ENDPOINT}/webmail-attachments`, {
        method: 'HEAD',
        timeout: 5000,
      } as any);
      status.checks.seaweedfs = {
        status: response.ok || response.status === 404 ? 'ok' : 'error',
        responseTime: Date.now() - s3Start,
      };
    } catch (err: any) {
      status.checks.seaweedfs = { status: 'error', message: err.message };
      status.status = 'error';
    }

    reply.status(status.status === 'ok' ? 200 : 503);
    return status;
  });

  // Startup probe: ¿La aplicación ha terminado de inicializar?
  app.get('/startup', async () => {
    // Verificar que todos los plugins estén cargados
    if (!app.hasPlugin('@fastify/jwt')) {
      return { status: 'starting' };
    }
    return { status: 'ok' };
  });
}
```

**Respuestas de health check:**

```json
// GET /health/live
{ "status": "ok" }

// GET /health/ready (todo saludable)
{
  "status": "ok",
  "checks": {
    "mongodb": { "status": "ok", "responseTime": 12 },
    "redis": { "status": "ok", "responseTime": 3 },
    "seaweedfs": { "status": "ok", "responseTime": 45 }
  }
}

// GET /health/ready (Redis caído)
{
  "status": "error",
  "checks": {
    "mongodb": { "status": "ok", "responseTime": 8 },
    "redis": { "status": "error", "message": "ECONNREFUSED" },
    "seaweedfs": { "status": "ok", "responseTime": 32 }
  }
}
```

**Configuración de Docker Compose:** `depends_on` con `condition: service_healthy` asegura que Nginx no redirija tráfico al API hasta que todos los health checks pasen. El `start_period: 30s` permite que el servicio de API tenga tiempo suficiente para inicializar Mongoose, conectarse a Redis y verificar SeaweedFS antes de reportarse como saludable.

| Probe | Endpoint | ¿Qué verifica? | Fallo → |
|-------|----------|---------------|---------|
| Liveness | `/health/live` | ¿El proceso responde? | Restart del container |
| Readiness | `/health/ready` | ¿DB, cache, storage accesibles? | Eliminación del LB |
| Startup | `/health/startup` | ¿Plugins cargados? | Retraso de liveness/readiness |

El endpoint `/metrics` nunca debe exponerse a Internet pública — revela internals de la aplicación. Se protege mediante restricción de red en Nginx y acceso solo desde Prometheus en la misma red Docker [^155^].
