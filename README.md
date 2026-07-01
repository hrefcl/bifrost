# Bifrost (Webmail 6.0)

Webmail moderno **open-source y white-label** — reemplazo de Roundcube. Cliente Gmail-like construido
con **Vue 3 + Fastify + MongoDB + Redis + imapflow**, sobre **cualquier servidor IMAP/SMTP**.

Pensado para que una PYME tenga correo propio casi-gratis (un EC2 modesto + S3 para adjuntos), turnkey
y con buena entregabilidad.

## Estado

`main` verde · CI con lint + typecheck + tests + build Docker multi-arch (arm64/amd64) + smoke.
Desplegado y verificado en producción. Lo que funciona hoy (correo + threading de conversaciones +
admin white-label + auto-update + provisioning AWS turnkey) está detallado en
[`docs/estado-actual.md`](docs/estado-actual.md).

## Arquitectura

Monorepo pnpm:

```
packages/
  shared/       Tipos TypeScript compartidos
  api/          Backend Fastify + Mongoose + Redis + imapflow/nodemailer
  web/          Frontend Vue 3 + Vite + Tailwind
  provisioner/  CLI bifrost-provision: stack completo en AWS (CloudFormation + Graviton +
                docker-mailserver + Traefik/Let's Encrypt + SES)
```

Despliegue: imágenes `ghcr.io/hrefcl/bifrost/{web,api}` (multi-arch) + docker-compose junto a
docker-mailserver, mongo, redis y traefik.

## Requisitos

- Node.js 22+ · pnpm 9.15.0 · MongoDB 7+ · Redis 7+

## Desarrollo

```bash
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
docker compose up -d            # MongoDB + Redis

pnpm --filter @webmail6/api dev  # backend
pnpm --filter @webmail6/web dev  # frontend → http://localhost:5173
```

Sin `.env`, la app arranca en **setup wizard** (`http://localhost:5173`): configurás DB, Redis, cuenta
admin y cuenta de correo. (En un deploy ya provisionado, el primer usuario que se autentica queda admin.)

## Scripts

| Comando          | Descripción                            |
| ---------------- | -------------------------------------- |
| `pnpm typecheck` | Chequeo de tipos en todos los paquetes |
| `pnpm lint`      | ESLint en todos los paquetes           |
| `pnpm test:unit` | Tests unitarios e integración          |
| `pnpm test:e2e`  | E2E con Playwright                     |
| `pnpm build`     | Build de producción                    |

## Bifrost Meet (videollamadas, opcional)

Videollamadas self-hosted con **LiveKit**, integradas a la agenda y el correo, en el **mismo** servidor
(sin SaaS, sin 2º EC2). **Opcional y modular**: la instalación funciona igual con Meet apagado. El
provisioner (`bifrost-provision --enable-meet`) levanta la infra (LiveKit, puertos, DNS) y luego se
enciende el interruptor maestro una vez (`PATCH /api/admin/meet/settings {"enabled":true}`; toggle visual
= F3.7-frontend). También podés apuntar a un LiveKit externo / **Cloud** por la API del admin. UI estilo
Google Meet, compartir pantalla, links en las reservas. Guía completa:
[`docs/meet/INSTALL.md`](docs/meet/INSTALL.md).

## Despliegue

- **Self-hosted (Docker):** `docker-compose.prod.yml` (o `deploy/example-mailserver/` para el stack
  completo con docker-mailserver).
- **AWS turnkey:** el CLI `bifrost-provision` levanta todo de cero — ver
  [`docs/cli-provisioning-aws.md`](docs/cli-provisioning-aws.md).

## Documentación

- [Estado actual](docs/estado-actual.md) — qué hay y qué funciona
- [Documento funcional](docs/documento-funcional.md) — la especificación del producto
- [Deuda técnica](docs/deuda-tecnica.md) — pendientes priorizados
- [Provisioning AWS](docs/cli-provisioning-aws.md) · [Admin/providers](docs/admin-config-y-providers.md)
- [Bifrost Meet](docs/meet/INSTALL.md) — instalación/operación de videollamadas · [diseño](docs/meet/DESIGN.md)

## Licencia

MIT
