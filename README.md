# Webmail 6.0

Cliente de correo moderno (reemplazo de Roundcube) construido con Vue 3, Fastify, MongoDB,
Redis e imapflow. Corre sobre cualquier servidor IMAP/SMTP.

## Estado del proyecto

**Funcional y hardened.** `main` verde · 0 CVEs (`pnpm audit` gate en CI) · 146 tests API + 9 E2E.

- ✅ Core webmail: auth, IMAP sync, leer (con adjuntos inbound), componer, enviar, drafts,
  reply/forward, firmas (verificado E2E en navegador real).
- ✅ Adjuntos end-to-end + admin con **storage configurable** (local/S3) — wizard, credenciales
  cifradas, GC de huérfanos, cuota anti-DoS, test de conexión.
- ✅ Seguridad auditada (5 rondas): authz multi-tenant, XSS (regression-tested) + CSP, JWT
  hardening, rate-limit, cifrado AES-GCM, deps sin CVEs.
- ⏳ Pendiente: provisioning de buzones (PR-E, feature-gated).

➡️ **Estado completo y nivel de avance: [`docs/estado-final.md`](docs/estado-final.md)** ·
deuda: [`docs/deuda-tecnica.md`](docs/deuda-tecnica.md) · self-hosted: `deploy/example-mailserver/`.

## Requisitos

- Node.js 22+
- pnpm 9.15.0
- MongoDB 7+
- Redis 7+

## Instalación rápida

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
```

## Modo desarrollo

Levanta MongoDB y Redis:

```bash
docker compose up -d
```

Al iniciar por primera vez sin un archivo `.env`, la aplicación entra en modo **setup wizard**. Abre `http://localhost:5173`, configura la base de datos, Redis, cuenta admin y cuenta de correo. Luego reinicia el servidor.

```bash
# Backend
pnpm --filter @webmail6/api dev

# Frontend
pnpm --filter @webmail6/web dev
```

## Scripts

| Comando              | Descripción                            |
| -------------------- | -------------------------------------- |
| `pnpm typecheck`     | Chequeo de tipos en todos los paquetes |
| `pnpm lint`          | ESLint en todos los paquetes           |
| `pnpm test:unit`     | Tests unitarios e integración          |
| `pnpm test:coverage` | Reportes de cobertura                  |
| `pnpm test:e2e`      | Tests E2E con Playwright               |
| `pnpm build`         | Build de producción                    |

## Estructura

```
packages/
  shared/   Tipos compartidos entre frontend y backend
  api/      Backend Fastify 5 + Mongoose
  web/      Frontend Vue 3 + Vite + Tailwind
```

## Docker

```bash
# Desarrollo
docker compose up -d

# Producción
docker compose -f docker-compose.prod.yml up -d
```

## Documentación

- [Auditoría](docs/auditoria-estado-actual.md)
- [Backlog](docs/backlog.md)
- [Roadmap](docs/roadmap.md)
- [Continuación](docs/continuar.md)

## Licencia

MIT
