# Webmail 6.0

Cliente de correo moderno construido con Vue 3, Fastify, MongoDB, Redis e imapflow.

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
