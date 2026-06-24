# 14. Roadmap y Notas para el Agent Swarm

Este capítulo final proporciona la hoja de ruta temporal, la división de responsabilidades entre agentes y las reglas de oro que rigen todas las decisiones técnicas del proyecto. Su propósito es permitir que un conjunto de agentes de IA trabajen de forma coordinada sobre el codebase sin inconsistencias arquitectónicas.

## 14.1 Roadmap

El desarrollo de Webmail 6.0 se estructura en tres fases principales, con una duración total estimada de 16 semanas. La Fase 1 construye el MVP funcional; la Fase 2 añade refinamiento de UX y características avanzadas; la Fase 3 introduce capacidades enterprise.

### 14.1.1 Fase 1: MVP (Semanas 1-7)

| Semana | Foco | Tareas Específicas | Entregable | Criterio de Aceptación |
|--------|------|-------------------|------------|----------------------|
| **1** | Setup inicial | Monorepo pnpm, Docker Compose (MongoDB, Redis, SeaweedFS, Nginx), TypeScript strict, ESLint, Prettier | Infraestructura levantada | `docker compose up` levanta todos los servicios healthy; `pnpm lint` pasa |
| **2** | Backend core - Parte 1 | Fastify setup (plugins, CORS, JWT, rate limiting, helmet), Mongoose schemas (User, Account, Email, Folder), Auth (registro/login, JWT, refresh tokens) | API base funcional | Endpoints `/auth/register`, `/auth/login`, `/auth/refresh` responden correctamente; JWT valida requests |
| **3** | Backend core - Parte 2 | IMAP Bridge (imapflow, sync headers, fetch body con cache Redis), SMTP Service (Nodemailer pooling), encriptación AES-256-GCM de credenciales | Pipeline de correo completo | Sync de INBOX descarga headers; envío de email vía SMTP funciona; credenciales encriptadas en MongoDB |
| **4** | Compose y drafts | Tiptap 2 con toolbar, auto-save cada 10s a MongoDB, adjuntos drag-drop a SeaweedFS, Reply/Forward con cita JWZ | Sistema de redacción completo | Usuario puede redactar, auto-save funciona, adjuntar archivos, responder con cita |
| **5** | Calendario | tsdav auto-discovery, CRUD eventos CalDAV, FullCalendar (día/semana/mes), parseo de .ics | Calendario integrado | Eventos se crean/leen/actualizan vía CalDAV; invitaciones .ics se muestran en emails |
| **6** | Frontend polish | Dark mode (Tailwind dark:), atajos de teclado (Gmail-style), threading JWZ, búsqueda MongoDB Atlas Search | UX refinada | Dark mode toggle funciona; atajos `g+i`, `c`, `r`, `e` operan; búsqueda full-text < 500ms |
| **7** | Integración y QA | Testing E2E con Playwright (flujos críticos), performance audit Lighthouse, bug fixes | Release candidato | Lighthouse > 90 en performance; tests E2E pasan; 0 bugs críticos |

### 14.1.2 Fase 2: Polish (Semanas 8-11)

| Semana | Foco | Tareas | Entregable |
|--------|------|--------|------------|
| **8** | Búsqueda avanzada | Filtros por fecha, remitente, adjuntos, búsqueda salvada, sugerencias autocomplete | Búsqueda con faceting |
| **9** | Contactos | CardDAV sync vía tsdav, importación/exportación vCard, foto de contacto, grupos | Libreta de direcciones integrada |
| **10** | Notificaciones push | WebSocket (Socket.IO) para notificaciones en tiempo real, Service Worker para notificaciones del sistema, badge de unread | Push notifications funcionales |
| **11** | Importación/exportación | Importación de .mbox/.eml, exportación de threads, backup de cuenta | Herramientas de migración |

### 14.1.3 Fase 3: Enterprise (Semanas 12-16)

| Semana | Foco | Tareas | Entregable |
|--------|------|--------|------------|
| **12** | OAuth2 | Integración Gmail OAuth2, Microsoft Graph API, autenticación SSO | Login con Google/Microsoft |
| **13** | JMAP | Implementar cliente JMAP (RFC 8620/8621) como alternativa a IMAP, auto-detección de soporte JMAP | Soporte dual IMAP/JMAP |
| **14** | Seguridad avanzada | S/MIME básico, verificación DKIM en headers, audit log, 2FA TOTP | Capas de seguridad enterprise |
| **15** | Escalabilidad | Sharding MongoDB por userId, clustering del API (PM2/Node.js cluster mode), CDN para adjuntos | Soporte 10k+ usuarios |
| **16** | Documentación y release | API docs (OpenAPI/Swagger), guía de administración, guía de contribución, release v1.0 | Documentación completa |

## 14.2 División de Agentes

El swarm se organiza en 7 agentes especializados, cada uno con responsabilidad sobre un dominio técnico específico. Esta división minimiza conflictos de merge y permite paralelización máxima.

| Agente | Responsabilidad | Stack | Archivos Principales |
|--------|----------------|-------|---------------------|
| **Frontend** | UI/UX, componentes Vue 3, estado Pinia, layout tres paneles | Vue 3, Vite, Tailwind, Pinia | `packages/web/src/components/**/*.vue`, `packages/web/src/stores/*.ts`, `packages/web/src/views/*.vue` |
| **Backend API** | Endpoints REST, schemas Mongoose, auth, validación | Fastify 5, Mongoose 8, Zod | `packages/api/src/routes/*.ts`, `packages/api/src/models/*.ts`, `packages/api/src/schemas/*.ts` |
| **IMAP Bridge** | Conexión IMAP, sincronización, parsing MIME, caché | imapflow, PostalMime, Redis | `packages/api/src/services/imap-bridge.ts`, `packages/api/src/services/sync-engine.ts`, `packages/api/src/queues/*.ts` |
| **CalDAV** | Integración CalDAV/CardDAV, parseo .ics, UI calendario | tsdav, ical.js, FullCalendar | `packages/api/src/services/caldav.ts`, `packages/api/src/routes/calendar.ts`, `packages/web/src/views/CalendarView.vue` |
| **Data** | Schemas, migraciones, índices MongoDB, seeders | Mongoose, MongoDB | `packages/shared/src/types.ts`, `packages/api/src/models/*.ts`, `packages/api/migrations/*.ts` |
| **DevOps** | Docker, CI/CD, Nginx, monitoreo, secrets | Docker, GitHub Actions, Nginx, Prometheus | `docker-compose*.yml`, `packages/*/Dockerfile`, `.github/workflows/*.yml`, `nginx/*.conf`, `monitoring/` |
| **QA** | Tests unitarios, integración, E2E, cobertura | Vitest, Playwright, Testcontainers | `**/*.spec.ts`, `**/*.test.ts`, `packages/web/e2e/*.spec.ts`, `packages/api/test/**/*.ts` |

### Protocolo de Coordinación entre Agentes

1. **Shared es la fuente de verdad.** El agente Data tiene autoridad exclusiva sobre `packages/shared`. Cualquier cambio en tipos o interfaces requiere PR separado que los demás agentes consumen.

2. **Contratos API primero.** Cuando Frontend y Backend API necesitan un nuevo endpoint, el agente Backend API define el schema Zod de request/response en `packages/shared/src/schemas/`. Frontend consume el tipo inferido.

3. **Branches por feature.** Cada agente trabaja en `feature/<agente>-<descripcion>`. Los merges a `develop` requieren CI verde + review del agente líder del dominio afectado.

4. **Daily sync automatizado.** Un job de CI ejecuta `pnpm build` y `pnpm test` sobre la rama `develop` cada 6 horas. Si falla, se notifica al agente responsable del último merge.

5. **Conflictos de merge:** El agente que creó el archivo tiene prioridad. En archivos compartidos (ej: `packages/shared/src/types.ts`), gana el agente Data.

## 14.3 Reglas de Oro

Estas reglas son no negociables. Todo código mergeado a `main` debe cumplirlas.

### 14.3.1 Composition API y `<script setup>`

Todo componente Vue usa Composition API con `<script setup>`. Options API está prohibido. Los composables son la unidad de reutilización de lógica, no mixins.

```typescript
// ✅ CORRECTO
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useEmailStore } from '@/stores/email';

const store = useEmailStore();
const selected = computed(() => store.selectedEmails);
const toggle = (id: string) => store.toggleSelect(id);
</script>
```

```typescript
// ❌ INCORRECTO
<script lang="ts">
export default {
  data() { return { count: 0 }; },
  methods: { increment() { this.count++; } }
}
</script>
```

### 14.3.2 TypeScript Strict

El `tsconfig.json` base habilita `strict: true` en todo el monorepo. No se permite `any` implícito. Los tipos de Mongoose se definen explícitamente; no se usa `as any` para silenciar errores.

```typescript
// ✅ CORRECTO
interface EmailDoc {
  _id: Types.ObjectId;
  subject: string;
  from: Array<{ name: string; address: string }>;
}
const email = await Email.findById(id).lean<EmailDoc>();
```

```typescript
// ❌ INCORRECTO
const email = await Email.findById(id) as any;
```

### 14.3.3 Sanitización Server-Side Obligatoria

Ningún contenido HTML de email llega al frontend sin pasar por `sanitize-html` en el backend. El iframe de visualización usa `sandbox="allow-same-origin"` sin `allow-scripts`. CSP headers bloquean inline scripts.

```typescript
// ✅ CORRECTO: Sanitizar antes de almacenar
email.bodyHtmlSanitized = sanitizeHtml(parsed.html, SANITIZE_CONFIG);
```

### 14.3.4 Credenciales Encriptadas

Las credenciales IMAP/SMTP se almacenan exclusivamente con AES-256-GCM. La clave de encriptación (`ENCRYPTION_KEY`) nunca se commitea — se inyecta vía Docker secrets o variable de entorno en runtime. La clave JWT (`JWT_SECRET`) tiene requisito mínimo de 32 bytes.

```typescript
// ✅ CORRECTO: Verificar longitud de clave en startup
if (!process.env.ENCRYPTION_KEY || Buffer.from(process.env.ENCRYPTION_KEY, 'hex').length !== 32) {
  throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
}
```

### 14.3.5 Cobertura de Tests >= 85%

| Tipo de archivo | Cobertura mínima |
|----------------|-----------------|
| Services (lógica de negocio) | 90% |
| Routes (handlers) | 85% |
| Models / Schemas | 80% |
| Composables Vue | 85% |
| Components | 70% |
| Config / Types / Main | Excluido |

Los PRs que bajan la cobertura global por debajo del 85% son bloqueados por branch protection rules.

### 14.3.6 Schemas Documentados

Todo schema Mongoose incluye comentarios JSDoc y tipos TypeScript exportados. Los endpoints de la API usan Zod para validación y generación automática de tipos.

```typescript
// ✅ CORRECTO
/**
 * Schema de usuario principal. Almacena credenciales locales
 * y cuentas de correo conectadas (IMAP/OAuth2).
 */
const UserSchema = new Schema<UserDoc>({
  username: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true }, // bcrypt(12)
  accounts: [AccountSchema],
  // ...
});
```

### 14.3.7 Resumen de Convenciones

| Aspecto | Convención | Ejemplo |
|---------|-----------|---------|
| **Nombres de archivos** | kebab-case | `email-list.vue`, `use-auth.ts` |
| **Nombres de componentes** | PascalCase | `VirtualEmailList.vue` |
| **Composables** | Prefijo `use` | `useEmailStore.ts` |
| **Stores Pinia** | Sufijo `Store` | `emailStore`, `authStore` |
| **API routes** | kebab-case plural | `/api/v1/emails`, `/api/v1/folders` |
| **Variables env** | UPPER_SNAKE_CASE | `MONGODB_URI`, `JWT_SECRET` |
| **Commits** | Conventional Commits | `feat(imap): add CONDSTORE support` |
| **Branches** | `feature/<agent>-<desc>` | `feature/imap-bridge-condstore` |

### 14.3.8 Checklist Pre-Merge

Antes de mergear cualquier PR, el agente autor debe verificar:

- [ ] CI pasa: lint, typecheck, unit tests, integration tests
- [ ] Cobertura de tests >= 85% para archivos modificados
- [ ] No hay secretos hardcodeados (verificado con `git grep -i "password\|secret\|token"`)
- [ ] Sanitización aplicada a cualquier input HTML
- [ ] Credenciales encriptadas antes de persistir
- [ ] Migrations incluidas si hay cambios en schemas
- [ ] Documentación actualizada si hay cambios en API
- [ ] E2E tests pasan para flujos afectados

### 14.3.9 Decisiones Arquitectónicas Inmutables

Las siguientes decisiones no se revisan sin RFC explícito y aprobación del swarm completo:

1. **IMAP como protocolo principal, JMAP como complemento.** IMAP es obligatorio para compatibilidad universal. JMAP se añade en Fase 3.
2. **MongoDB para metadata, SeaweedFS para adjuntos.** No se almacenan archivos binarios en MongoDB.
3. **Redis para cache y sesiones, no para persistencia.** Los datos críticos siempre tienen copia en MongoDB.
4. **BFF auth pattern.** Access token en memoria del frontend, refresh token en HttpOnly cookie.
5. **Headers-first, body-on-demand.** El sync IMAP nunca descarga cuerpos completos para listados.
6. **Server-side sanitization.** DOMPurify/sanitize-html corre en el API, no solo en el cliente.

### 14.3.10 Métricas de Éxito del Swarm

| Métrica | Objetivo | Cómo Medir |
|---------|---------|------------|
| Tiempo de build CI | < 10 min | GitHub Actions elapsed time |
| Tiempo de deploy | < 5 min | Desde tag push a healthy en prod |
| Cobertura de tests | >= 85% | `@vitest/coverage-v8` output |
| Bugs en producción | < 2 críticos/semana | Issue tracker |
| Lighthouse Performance | > 90 | PageSpeed Insights |
| Lighthouse Accessibility | > 95 | PageSpeed Insights |
| Latencia P95 API | < 200ms | Prometheus histogram |
| Disponibilidad | > 99.9% | Uptime monitoring |
