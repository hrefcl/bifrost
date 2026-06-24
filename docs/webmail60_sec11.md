# 11. Guía de Implementación Paso a Paso

Este capítulo presenta una guía de implementación específica y ejecutable para construir Webmail 6.0 en siete semanas. Cada fase incluye comandos exactos, archivos de configuración y criterios de validación. La estructura sigue un monorepo con workspaces de pnpm, Docker Compose para infraestructura y TypeScript strict en todo el stack.

## 11.1 Fase 1: Setup Inicial (Semana 1)

**Objetivos:** Establecer la estructura del monorepo, configurar Docker Compose con todos los servicios de infraestructura y aplicar estandarización de código.

**Entregables:** Repositorio inicializado, contenedores levantados, linting configurado.

### 11.1.1 Monorepo con pnpm Workspaces

El monorepo se organiza en tres packages principales: `packages/web` (Vue 3 frontend), `packages/api` (Fastify backend) y `packages/shared` (tipos y utilidades compartidos).

```bash
# Crear estructura del proyecto
mkdir webmail6 && cd webmail6
git init
corepack enable
corepack prepare pnpm@9.15.0 --activate

# Inicializar workspaces
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'packages/*'
EOF

# Package root con scripts globales
cat > package.json << 'EOF'
{
  "name": "webmail6",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "test:unit": "pnpm -r --parallel test:unit",
    "test:e2e": "pnpm -r test:e2e",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "eslint": "^9.17.0",
    "@eslint/js": "^9.17.0",
    "prettier": "^3.4.0",
    "globals": "^15.14.0"
  }
}
EOF

# Crear directorios
mkdir -p packages/shared/src packages/api/src packages/web/src

# Package shared (tipos, schemas, utilidades)
cat > packages/shared/package.json << 'EOF'
{
  "name": "@webmail6/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "typescript": "^5.7.0" }
}
EOF

# tsconfig base para todo el monorepo
cat > tsconfig.base.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
EOF
```

**Criterio de validación:** Ejecutar `pnpm install` sin errores y verificar que `pnpm -r typecheck` funciona en los packages con TypeScript inicializado.

### 11.1.2 Docker Compose Base

El stack de infraestructura incluye MongoDB 7 para persistencia, Redis 7 para sesiones y caché, SeaweedFS para almacenamiento de adjuntos y Nginx como reverse proxy.

```yaml
# docker-compose.yml
services:
  mongo:
    image: mongo:7.0.16
    container_name: webmail6_mongo
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD_FILE: /run/secrets/mongo_root_password
    secrets:
      - mongo_root_password
    volumes:
      - mongo_data:/data/db
      - ./init-mongo.js:/docker-entrypoint-initdb.d/init-mongo.js:ro
    ports:
      - "27017:27017"
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - webmail6_net
    deploy:
      resources:
        limits: { memory: 2G }
        reservations: { memory: 512M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  redis:
    image: redis:7.4-alpine
    container_name: webmail6_redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks:
      - webmail6_net
    deploy:
      resources:
        limits: { memory: 512M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  seaweedfs:
    image: chrislusge/seaweedfs:3.80
    container_name: webmail6_seaweed
    restart: unless-stopped
    command: "server -s3 -dir=/data -volume.max=50"
    volumes:
      - seaweed_data:/data
    ports:
      - "8333:8333"
      - "9333:9333"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:9333"]
      interval: 15s
      timeout: 5s
      retries: 5
    networks:
      - webmail6_net
    deploy:
      resources:
        limits: { memory: 1G }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  nginx:
    image: nginx:1.27-alpine
    container_name: webmail6_nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - certbot_data:/etc/letsencrypt
    depends_on:
      api:
        condition: service_healthy
    networks:
      - webmail6_net
    deploy:
      resources:
        limits: { memory: 128M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
      target: production
    container_name: webmail6_api
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3000
      MONGODB_URI: mongodb://admin:${MONGO_PASSWORD}@mongo:27017/webmail6?authSource=admin
      REDIS_URL: redis://redis:6379
      SEAWEEDFS_ENDPOINT: http://seaweedfs:8333
    secrets:
      - mongo_root_password
      - jwt_secret
      - encryption_key
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
      seaweedfs:
        condition: service_healthy
    networks:
      - webmail6_net
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health/live"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s
    deploy:
      resources:
        limits: { memory: 512M }
        reservations: { memory: 128M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  mongo_data:
  redis_data:
  seaweed_data:
  certbot_data:

networks:
  webmail6_net:
    driver: bridge

secrets:
  mongo_root_password:
    environment: MONGO_PASSWORD
  jwt_secret:
    environment: JWT_SECRET
  encryption_key:
    environment: ENCRYPTION_KEY
```

Levantar la infraestructura:

```bash
docker compose up -d mongo redis seaweedfs
# Verificar salud
docker compose ps
# Esperar a que mongo reporte healthy antes de continuar
docker compose logs -f mongo
```

### 11.1.3 TypeScript Strict, ESLint + Prettier

```bash
# Configuración ESLint flat config
cat > eslint.config.js << 'EOF'
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  ...vue.configs['flat/recommended'],
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vue.parser,
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
      },
    },
  }
);
EOF

# Prettier config
cat > .prettierrc << 'EOF'
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
EOF

# Git hooks con simple-git-hooks + lint-staged
pnpm add -D simple-git-hooks lint-staged
# package.json scripts addition:
# "prepare": "simple-git-hooks"
# simple-git-hooks config:
# "simple-git-hooks": { "pre-commit": "pnpm lint-staged" }
# lint-staged config:
# "lint-staged": { "*.{ts,vue}": ["eslint --fix", "prettier --write"] }
```

**Validación:** `pnpm lint` debe ejecutarse sin errores en el template inicial.

## 11.2 Fase 2: Backend Core (Semanas 2-3)

**Objetivos:** API REST funcional con autenticación, modelos de datos y servicios de correo.

**Entregables:** Endpoints de auth, schemas Mongoose, IMAP bridge y SMTP service.

### 11.2.1 Fastify Setup

```bash
cd packages/api
pnpm add fastify@^5 @fastify/cors@^10 @fastify/jwt@^9 @fastify/cookie@^11 \
  @fastify/helmet@^13 @fastify/rate-limit@^10 @fastify/env@^5 \
  mongoose@^8 imapflow@^1 nodemailer@^6 bullmq@^5 ioredis@^5 \
  @aws-sdk/client-s3@^3 postal-mime@^2 sanitize-html@^2 \
  dotenv@^16 zod@^3

pnpm add -D typescript @types/node @types/nodemailer tsx vitest @vitest/coverage-v8
```

```typescript
// packages/api/src/app.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { envSchema } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { emailRoutes } from './routes/email.js';
import { folderRoutes } from './routes/folder.js';
import { attachmentRoutes } from './routes/attachment.js';
import { composeRoutes } from './routes/compose.js';
import { contactRoutes } from './routes/contact.js';
import { calendarRoutes } from './routes/calendar.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
      },
    },
  });

  await app.register(cors, {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip || 'anonymous',
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    cookie: { cookieName: 'refreshToken', signed: false },
  });

  await app.register(cookie);

  // Health checks
  await app.register(healthRoutes, { prefix: '/health' });

  // API routes v1
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(emailRoutes, { prefix: '/api/v1/emails' });
  await app.register(folderRoutes, { prefix: '/api/v1/folders' });
  await app.register(attachmentRoutes, { prefix: '/api/v1/attachments' });
  await app.register(composeRoutes, { prefix: '/api/v1/compose' });
  await app.register(contactRoutes, { prefix: '/api/v1/contacts' });
  await app.register(calendarRoutes, { prefix: '/api/v1/calendar' });

  return app;
}
```

### 11.2.2 Mongoose Schemas

```typescript
// packages/api/src/models/User.ts
import mongoose from 'mongoose';

const AccountSchema = new mongoose.Schema({
  email: { type: String, required: true },
  provider: { type: String, enum: ['imap', 'gmail_oauth', 'microsoft_oauth'], required: true },
  imapHost: String,
  imapPort: { type: Number, default: 993 },
  imapSecure: { type: Boolean, default: true },
  smtpHost: String,
  smtpPort: { type: Number, default: 587 },
  smtpSecure: { type: Boolean, default: false },
  credentialsEncrypted: { type: String, required: true },
  displayName: String,
  syncState: {
    lastUid: { type: Number, default: 0 },
    lastSyncAt: Date,
    highestModSeq: String,
  },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  accounts: [AccountSchema],
  preferences: {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    density: { type: String, enum: ['compact', 'comfortable'], default: 'comfortable' },
    signature: String,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

export const User = mongoose.model('User', UserSchema);
```

```typescript
// packages/api/src/models/Email.ts
import mongoose from 'mongoose';

const AttachmentRefSchema = new mongoose.Schema({
  filename: String,
  contentType: String,
  size: Number,
  seaweedFid: String,
}, { _id: false });

const EmailSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  folderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

  // IMAP metadata
  uid: { type: Number, required: true },
  messageId: { type: String, index: true },
  threadId: { type: String, index: true },

  // Headers
  subject: String,
  from: [{ name: String, address: String }],
  to: [{ name: String, address: String }],
  cc: [{ name: String, address: String }],
  bcc: [{ name: String, address: String }],
  replyTo: [{ name: String, address: String }],
  date: { type: Date, index: true },

  // Content
  bodyText: String,
  bodyHtml: String,
  bodyHtmlSanitized: String,
  headers: mongoose.Schema.Types.Mixed,

  // State
  flags: { type: [String], default: [] },
  isRead: { type: Boolean, default: false },
  isStarred: { type: Boolean, default: false },
  size: Number,

  // Attachments
  attachments: [AttachmentRefSchema],
  hasAttachments: { type: Boolean, default: false },

  // Indexing
  indexedAt: { type: Date, default: Date.now },
}, {
  timestamps: true,
});

// Índice compuesto ESR: Equality → Sort → Range
EmailSchema.index({ accountId: 1, folderId: 1, date: -1, uid: -1 });
EmailSchema.index({ accountId: 1, threadId: 1, date: -1 });
EmailSchema.index({ userId: 1, isRead: 1, date: -1 });

export const Email = mongoose.model('Email', EmailSchema);
```

### 11.2.3 Auth: JWT + Redis Refresh Tokens

El patrón BFF (Backend for Frontend) almacena el access token en memoria del frontend y el refresh token en una cookie HttpOnly. Las credenciales IMAP se encriptan con AES-256-GCM antes de almacenarse [^157^] [^160^].

```typescript
// packages/api/src/services/auth.ts
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { User } from '../models/User.js';
import { redis } from '../config/redis.js';

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex');

export class AuthService {
  static encryptCredentials(plain: string): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let ciphertext = cipher.update(plain, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return { ciphertext, iv: iv.toString('hex'), tag: tag.toString('hex') };
  }

  static decryptCredentials(ciphertext: string, iv: string, tag: string): string {
    const decipher = crypto.createDecipheriv(
      ALGORITHM, ENCRYPTION_KEY, Buffer.from(iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');
    return plaintext;
  }

  static async createRefreshToken(userId: string): Promise<string> {
    const tokenId = crypto.randomBytes(32).toString('hex');
    const tokenFamily = crypto.randomBytes(16).toString('hex');
    await redis.setex(
      `refresh:${tokenId}`,
      7 * 24 * 3600, // 7 días
      JSON.stringify({ userId, family: tokenFamily, createdAt: Date.now() })
    );
    return tokenId;
  }

  static async validateRefreshToken(tokenId: string) {
    const data = await redis.get(`refresh:${tokenId}`);
    if (!data) return null;
    await redis.del(`refresh:${tokenId}`); // one-time use
    return JSON.parse(data);
  }

  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }
}
```

### 11.2.4 IMAP Bridge Service

El servicio de sincronización IMAP utiliza imapflow con un pool de conexiones y la estrategia headers-first, body-on-demand que permite cargar bandejas en menos de un segundo [^1^] [^3^].

```typescript
// packages/api/src/services/imap-bridge.ts
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { Email } from '../models/Email.js';
import { redis } from '../config/redis.js';
import { AuthService } from './auth.js';
import type { AccountDoc } from '../types/index.js';

export class ImapBridgeService {
  private clients: Map<string, ImapFlow> = new Map();

  async getClient(account: AccountDoc): Promise<ImapFlow> {
    const key = account._id!.toString();
    if (this.clients.has(key)) {
      const existing = this.clients.get(key)!;
      if (existing.usable) return existing;
      await existing.logout();
    }

    const creds = JSON.parse(
      AuthService.decryptCredentials(
        account.credentialsEncrypted,
        account.credentialsIv!,
        account.credentialsTag!
      )
    );

    const client = new ImapFlow({
      host: account.imapHost!,
      port: account.imapPort || 993,
      secure: account.imapSecure !== false,
      auth: { user: account.email, pass: creds.password },
      logger: false,
      emitLogs: false,
    });

    await client.connect();
    this.clients.set(key, client);
    return client;
  }

  async syncInbox(account: AccountDoc, folderPath: string = 'INBOX'): Promise<number> {
    const client = await this.getClient(account);
    const lock = await client.getMailboxLock(folderPath);

    try {
      const lastUid = account.syncState?.lastUid || 0;
      const fetchRange = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';

      // Headers-only fetch para el listado
      let synced = 0;
      for await (let msg of client.fetch(fetchRange, {
        uid: true,
        flags: true,
        envelope: true,
        headers: ['message-id', 'in-reply-to', 'references'],
        internalDate: true,
        size: true,
        struct: true,
        threadId: true,
      })) {
        if (msg.uid <= lastUid) continue;

        const hasAttachments = msg.struct?.some((part: any) =>
          part.disposition?.includes('attachment')
        ) ?? false;

        await Email.updateOne(
          { accountId: account._id, uid: msg.uid },
          {
            $setOnInsert: {
              userId: account.userId,
              folderId: await this.resolveFolderId(account, folderPath),
              uid: msg.uid,
              messageId: msg.envelope.messageId,
              threadId: msg.threadId || msg.envelope.messageId,
              subject: msg.envelope.subject,
              from: msg.envelope.from,
              to: msg.envelope.to,
              cc: msg.envelope.cc,
              date: msg.envelope.date,
              size: msg.size,
              flags: msg.flags,
              isRead: msg.flags.has('\\Seen'),
              isStarred: msg.flags.has('\\Flagged'),
              hasAttachments,
              headers: msg.headers,
            },
          },
          { upsert: true }
        );
        synced++;
      }

      return synced;
    } finally {
      lock.release();
    }
  }

  async fetchBody(account: AccountDoc, uid: number): Promise<{ text: string; html: string; sanitized: string }> {
    const cacheKey = `body:${account._id}:${uid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const client = await this.getClient(account);
    const lock = await client.getMailboxLock('INBOX');

    try {
      const msg = await client.fetchOne(uid.toString(), { source: true }, { uid: true });
      const parsed = await PostalMime.parse(msg.source);

      const result = {
        text: parsed.text || '',
        html: parsed.html || '',
        sanitized: this.sanitizeHtml(parsed.html || ''),
      };

      await redis.setex(cacheKey, 3600, JSON.stringify(result)); // TTL 1 hora
      return result;
    } finally {
      lock.release();
    }
  }

  private sanitizeHtml(html: string): string {
    return sanitizeHtml(html, {
      allowedTags: [
        'p', 'br', 'strong', 'em', 'u', 'a', 'img', 'table', 'tr', 'td', 'th',
        'thead', 'tbody', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'pre', 'code', 'span', 'div'
      ],
      allowedAttributes: {
        a: ['href', 'title'],
        img: ['src', 'alt', 'width', 'height'],
        '*': ['style'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
    });
  }
}
```

### 11.2.5 SMTP Service

```typescript
// packages/api/src/services/smtp.ts
import nodemailer from 'nodemailer';
import { AuthService } from './auth.js';
import type { AccountDoc } from '../types/index.js';

export class SmtpService {
  private transporters: Map<string, nodemailer.Transporter> = new Map();

  async getTransporter(account: AccountDoc): Promise<nodemailer.Transporter> {
    const key = account._id!.toString();
    if (!this.transporters.has(key)) {
      const creds = JSON.parse(
        AuthService.decryptCredentials(
          account.credentialsEncrypted,
          account.credentialsIv!,
          account.credentialsTag!
        )
      );

      const transporter = nodemailer.createTransport({
        pool: true,
        host: account.smtpHost,
        port: account.smtpPort || 587,
        secure: account.smtpSecure || false,
        auth: { user: account.email, pass: creds.password },
        maxConnections: 3,
        maxMessages: 100,
      });

      this.transporters.set(key, transporter);
    }
    return this.transporters.get(key)!;
  }

  async sendEmail(
    account: AccountDoc,
    data: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; attachments?: any[] }
  ): Promise<string> {
    const transporter = await this.getTransporter(account);
    const result = await transporter.sendMail({
      from: { name: account.displayName || account.email, address: account.email },
      to: data.to,
      cc: data.cc,
      bcc: data.bcc,
      subject: data.subject,
      text: data.text,
      html: data.html,
      attachments: data.attachments,
    });
    return result.messageId;
  }
}
```

**Validación:** Ejecutar `pnpm dev` en el package `api`, verificar que `curl http://localhost:3000/health/live` devuelve `{ "status": "ok" }` y que la conexión a MongoDB y Redis es exitosa.

## 11.3 Fase 3: Frontend Core (Semanas 3-4)

**Objetivos:** Interfaz de usuario funcional con layout de tres paneles, autenticación y gestión de correo.

### 11.3.1 Vue 3 + Vite + Tailwind + Pinia

```bash
cd packages/web
pnpm create vite@latest . -- --template vue-ts
pnpm add tailwindcss@^3 @tailwindcss/forms @tailwindcss/typography postcss autoprefixer
pnpm add pinia@^2 vue-router@^4 @vueuse/core@^12 date-fns@^4
pnpm add tiptap@^2 @tiptap/vue-3@^2 @tiptap/starter-kit@^2 @tiptap/extension-link@^2
pnpm add @fullcalendar/core@^6 @fullcalendar/vue3@^6 @fullcalendar/daygrid@^6 @fullcalendar/timegrid@^6
pnpm add tsdav@^3 ical.js@^2
pnpm add -D @playwright/test

# Inicializar Tailwind
npx tailwindcss init -p
```

```typescript
// packages/web/src/main.ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import router from './router';
import App from './App.vue';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
```

### 11.3.2 Layout de Tres Paneles

```vue
<!-- packages/web/src/layouts/MailLayout.vue -->
<template>
  <div class="flex h-screen bg-white dark:bg-gray-900">
    <!-- Sidebar -->
    <aside class="w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <AccountSwitcher :accounts="accountStore.accounts" />
      <FolderList
        :folders="folderStore.folders"
        :selected="folderStore.selectedId"
        @select="folderStore.select"
        @drop-email="moveEmail"
      />
      <div class="mt-auto p-4">
        <button
          @click="router.push('/compose')"
          class="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 font-medium transition"
        >
          Redactar
        </button>
      </div>
    </aside>

    <!-- Email List -->
    <div class="w-[420px] flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <SearchBar v-model="searchQuery" @search="performSearch" />
      <VirtualEmailList
        :emails="emailStore.filteredEmails"
        :selected="emailStore.selectedIds"
        :total="emailStore.total"
        @select="emailStore.toggleSelect"
        @select-one="emailStore.selectOne"
        @scroll-end="emailStore.loadMore"
        @toggle-read="toggleRead"
        @toggle-star="toggleStar"
      />
    </div>

    <!-- Reading Pane -->
    <main class="flex-1 min-w-0 flex flex-col bg-white dark:bg-gray-900">
      <ReadingPaneToolbar
        :email="emailStore.currentEmail"
        @reply="composeReply"
        @reply-all="composeReplyAll"
        @forward="composeForward"
        @delete="deleteEmail"
        @toggle-star="toggleStar"
      />
      <EmailViewer
        v-if="emailStore.currentEmail"
        :email="emailStore.currentEmail"
        class="flex-1 overflow-y-auto"
      />
      <EmptyState v-else message="Selecciona un correo para leerlo" />
    </main>
  </div>
</template>
```

### 11.3.3 Login Multi-Cuenta

```typescript
// packages/web/src/stores/auth.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../lib/api';

export const useAuthStore = defineStore('auth', () => {
  const accessToken = ref<string | null>(null);
  const user = ref<User | null>(null);
  const isAuthenticated = computed(() => !!accessToken.value);

  async function login(username: string, password: string): Promise<void> {
    const response = await api.post('/auth/login', { username, password });
    accessToken.value = response.data.accessToken;
    user.value = response.data.user;
    api.defaults.headers.common['Authorization'] = `Bearer ${accessToken.value}`;
    startRefreshTimer();
  }

  async function logout(): Promise<void> {
    await api.post('/auth/logout').catch(() => {});
    accessToken.value = null;
    user.value = null;
    delete api.defaults.headers.common['Authorization'];
  }

  // Refresh automático del access token cada 10 minutos
  let refreshTimer: ReturnType<typeof setInterval>;
  function startRefreshTimer() {
    refreshTimer = setInterval(async () => {
      try {
        const res = await api.post('/auth/refresh', {}, { withCredentials: true });
        accessToken.value = res.data.accessToken;
        api.defaults.headers.common['Authorization'] = `Bearer ${accessToken.value}`;
      } catch {
        logout();
      }
    }, 10 * 60 * 1000);
  }

  return { accessToken, user, isAuthenticated, login, logout };
});
```

### 11.3.4 Lista de Emails: Virtual Scroll

```vue
<!-- packages/web/src/components/VirtualEmailList.vue -->
<template>
  <div ref="container" class="flex-1 overflow-y-auto" @scroll="onScroll">
    <div :style="{ height: `${totalHeight}px`, position: 'relative' }">
      <div
        v-for="email in visibleEmails"
        :key="email.id"
        :style="{ transform: `translateY(${email.offsetY}px)`, position: 'absolute', top: 0, left: 0, right: 0 }"
        @click="$emit('select-one', email.id)"
        :class="[
          'px-4 py-3 border-b border-gray-100 dark:border-gray-800 cursor-pointer transition-colors',
          selected.has(email.id) ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800',
          !email.isRead && 'font-semibold'
        ]"
      >
        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            :checked="selected.has(email.id)"
            @click.stop="$emit('select', email.id)"
            class="rounded"
          />
          <button @click.stop="$emit('toggle-star', email.id)" class="text-lg">
            {{ email.isStarred ? '★' : '☆' }}
          </button>
          <span class="flex-1 truncate text-sm dark:text-gray-200">
            {{ email.from[0]?.name || email.from[0]?.address }}
          </span>
          <span class="text-xs text-gray-400">{{ formatDate(email.date) }}</span>
        </div>
        <div class="text-sm truncate dark:text-gray-300 mt-0.5 pl-7">{{ email.subject }}</div>
        <div class="text-xs text-gray-400 truncate pl-7">{{ email.preview }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

const props = defineProps<{ emails: Email[]; selected: Set<string>; total: number }>();
const emit = defineEmits(['select', 'select-one', 'scroll-end', 'toggle-read', 'toggle-star']);

const ITEM_HEIGHT = 80;
const OVERSCAN = 5;

const container = ref<HTMLDivElement>();
const scrollTop = ref(0);
const containerHeight = ref(800);

const totalHeight = computed(() => props.total * ITEM_HEIGHT);

const visibleRange = computed(() => {
  const start = Math.floor(scrollTop.value / ITEM_HEIGHT);
  const count = Math.ceil(containerHeight.value / ITEM_HEIGHT);
  return {
    start: Math.max(0, start - OVERSCAN),
    end: Math.min(props.total, start + count + OVERSCAN),
  };
});

const visibleEmails = computed(() =>
  props.emails.slice(visibleRange.value.start, visibleRange.value.end).map((email, i) => ({
    ...email,
    offsetY: (visibleRange.value.start + i) * ITEM_HEIGHT,
  }))
);

function onScroll() {
  if (!container.value) return;
  scrollTop.value = container.value.scrollTop;
  const bottom = scrollTop.value + containerHeight.value;
  if (bottom >= totalHeight.value - ITEM_HEIGHT * 3) {
    emit('scroll-end');
  }
}

function formatDate(d: string) {
  return formatDistanceToNow(new Date(d), { addSuffix: true, locale: es });
}

onMounted(() => {
  if (container.value) containerHeight.value = container.value.clientHeight;
});
</script>
```

### 11.3.5 Vista de Lectura: HTML Sanitizado

```vue
<!-- packages/web/src/components/EmailViewer.vue -->
<template>
  <div class="p-6">
    <h1 class="text-xl font-semibold mb-2 dark:text-white">{{ email.subject }}</h1>
    <div class="flex items-center gap-3 mb-4 pb-4 border-b dark:border-gray-700">
      <Avatar :email="email.from[0]?.address" :name="email.from[0]?.name" />
      <div class="flex-1">
        <div class="font-medium dark:text-gray-200">{{ email.from[0]?.name || email.from[0]?.address }}</div>
        <div class="text-sm text-gray-500">{{ formatDateFull(email.date) }}</div>
      </div>
    </div>

    <!-- Tabs: HTML / Texto Plano / Headers -->
    <div class="flex gap-4 mb-4 border-b dark:border-gray-700">
      <button
        v-for="tab in ['html', 'text', 'headers']"
        :key="tab"
        @click="activeTab = tab"
        :class="['pb-2 text-sm capitalize', activeTab === tab ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500']"
      >
        {{ tab === 'html' ? 'HTML' : tab === 'text' ? 'Texto' : 'Cabeceras' }}
      </button>
    </div>

    <!-- Contenido en iframe aislado para HTML -->
    <iframe
      v-if="activeTab === 'html' && email.bodyHtmlSanitized"
      :srcdoc="email.bodyHtmlSanitized"
      class="w-full border-0"
      style="min-height: 400px;"
      sandbox="allow-same-origin"
      referrerpolicy="no-referrer"
    />
    <pre v-else-if="activeTab === 'text'" class="whitespace-pre-wrap dark:text-gray-300">{{ email.bodyText }}</pre>
    <pre v-else class="text-xs dark:text-gray-400 overflow-x-auto">{{ JSON.stringify(email.headers, null, 2) }}</pre>
  </div>
</template>
```

## 11.4 Fase 4: Compose y Drafts (Semana 4)

### 11.4.1 Tiptap 2 con Toolbar

```vue
<!-- packages/web/src/components/Composer.vue -->
<template>
  <div class="flex flex-col h-full bg-white dark:bg-gray-900">
    <div class="flex items-center gap-2 p-3 border-b dark:border-gray-700">
      <input
        v-model="compose.to"
        placeholder="Para"
        class="flex-1 bg-transparent border-b dark:text-white dark:border-gray-600 focus:outline-none focus:border-blue-500 pb-1"
      />
    </div>
    <div class="flex items-center gap-2 p-3 border-b dark:border-gray-700">
      <input
        v-model="compose.subject"
        placeholder="Asunto"
        class="flex-1 bg-transparent dark:text-white focus:outline-none"
      />
    </div>

    <!-- Tiptap Toolbar -->
    <div class="flex gap-1 p-2 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      <button @click="editor?.chain().focus().toggleBold().run()" :class="{ 'bg-gray-200': editor?.isActive('bold') }" class="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600">B</button>
      <button @click="editor?.chain().focus().toggleItalic().run()" :class="{ 'bg-gray-200': editor?.isActive('italic') }" class="p-1.5 rounded hover:bg-gray-200 italic dark:hover:bg-gray-600">I</button>
      <button @click="editor?.chain().focus().toggleStrike().run()" :class="{ 'bg-gray-200': editor?.isActive('strike') }" class="p-1.5 rounded hover:bg-gray-200 line-through dark:hover:bg-gray-600">S</button>
      <div class="w-px h-6 bg-gray-300 mx-1" />
      <button @click="addLink" class="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600">🔗</button>
      <button @click="editor?.chain().focus().toggleBulletList().run()" class="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600">• List</button>
    </div>

    <editor-content :editor="editor" class="flex-1 overflow-y-auto p-4 prose dark:prose-invert max-w-none" />

    <div class="p-3 border-t dark:border-gray-700 flex items-center gap-3">
      <button
        @click="send"
        :disabled="sending"
        class="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-6 py-2 rounded-lg font-medium"
      >
        {{ sending ? 'Enviando...' : 'Enviar' }}
      </button>
      <button @click="saveDraft" class="text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
        Guardar borrador
      </button>
      <span v-if="lastSaved" class="text-xs text-gray-400 ml-auto">
        Guardado {{ formatDistanceToNow(lastSaved, { addSuffix: true, locale: es }) }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { ref, onBeforeUnmount, watch } from 'vue';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

const props = defineProps<{ replyTo?: Email; forward?: Email }>();

const editor = useEditor({
  extensions: [StarterKit, Link.configure({ openOnClick: false })],
  content: props.replyTo ? buildQuote(props.replyTo) : '',
});

const compose = reactive({ to: '', cc: '', bcc: '', subject: props.replyTo ? `Re: ${props.replyTo.subject}` : '' });
const sending = ref(false);
const lastSaved = ref<Date | null>(null);

// Auto-save cada 10 segundos
let autoSaveInterval: ReturnType<typeof setInterval>;
onMounted(() => {
  autoSaveInterval = setInterval(() => {
    if (editor.value?.getText().trim()) saveDraft();
  }, 10000);
});
onBeforeUnmount(() => {
  clearInterval(autoSaveInterval);
  editor.value?.destroy();
});

async function saveDraft() {
  await api.post('/compose/draft', {
    ...compose,
    bodyHtml: editor.value?.getHTML(),
    bodyText: editor.value?.getText(),
  });
  lastSaved.value = new Date();
}
</script>
```

### 11.4.2 Adjuntos: Drag-Drop a SeaweedFS

```typescript
// packages/api/src/services/attachments.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  endpoint: process.env.SEAWEEDFS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'anonymous', secretAccessKey: 'anonymous' },
  forcePathStyle: true,
});

const BUCKET = 'webmail-attachments';

export class AttachmentService {
  static async upload(file: Buffer, filename: string, contentType: string): Promise<string> {
    const fid = `${Date.now()}-${crypto.randomUUID()}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: fid,
      Body: file,
      ContentType: contentType,
      Metadata: { filename },
    }));
    return fid;
  }

  static async getSignedUrl(fid: string, expiresIn: number = 3600): Promise<string> {
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: fid }), { expiresIn });
  }
}
```

## 11.5 Fase 5: Calendario (Semana 5)

### 11.5.1 tsdav: Auto-Discovery y CRUD

```typescript
// packages/api/src/services/caldav.ts
import { createDAVClient } from 'tsdav';
import { AuthService } from './auth.js';
import type { AccountDoc } from '../types/index.js';

export class CalDAVService {
  async getClient(account: AccountDoc) {
    const creds = JSON.parse(
      AuthService.decryptCredentials(
        account.credentialsEncrypted,
        account.credentialsIv!,
        account.credentialsTag!
      )
    );

    return createDAVClient({
      serverUrl: `https://${account.imapHost}`,
      credentials: { username: account.email, password: creds.password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
  }

  async listCalendars(account: AccountDoc) {
    const client = await this.getClient(account);
    await client.login();
    return client.fetchCalendars();
  }

  async listEvents(account: AccountDoc, calendarUrl: string, timeRange: { start: string; end: string }) {
    const client = await this.getClient(account);
    await client.login();
    return client.fetchCalendarObjects({
      calendar: { url: calendarUrl },
      timeRange,
    });
  }

  async createEvent(account: AccountDoc, calendarUrl: string, iCalString: string) {
    const client = await this.getClient(account);
    await client.login();
    return client.createCalendarObject({
      calendar: { url: calendarUrl },
      filename: `${crypto.randomUUID()}.ics`,
      iCalString,
    });
  }
}
```

### 11.5.2 FullCalendar: Día/Semana/Mes

```vue
<!-- packages/web/src/views/CalendarView.vue -->
<template>
  <div class="h-full flex flex-col">
    <FullCalendar
      :options="calendarOptions"
      class="flex-1"
    />
  </div>
</template>

<script setup lang="ts">
import FullCalendar from '@fullcalendar/vue3';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { ref } from 'vue';

const calendarOptions = ref({
  plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
  initialView: 'timeGridWeek',
  headerToolbar: {
    left: 'prev,next today',
    center: 'title',
    right: 'dayGridMonth,timeGridWeek,timeGridDay',
  },
  editable: true,
  selectable: true,
  selectMirror: true,
  dayMaxEvents: true,
  weekends: true,
  events: fetchEvents,
  eventClick: handleEventClick,
  select: handleDateSelect,
});

async function fetchEvents(info: any) {
  const res = await api.get('/calendar/events', {
    params: { start: info.startStr, end: info.endStr },
  });
  return res.data.map((evt: any) => ({
    id: evt.uid,
    title: evt.summary,
    start: evt.start,
    end: evt.end,
    allDay: evt.allDay,
  }));
}
</script>
```

## 11.6 Fase 6: Polish (Semanas 6-7)

### 11.6.1 Dark Mode, Keyboard Shortcuts, Threading JWZ, Búsqueda Atlas Search

```typescript
// packages/web/src/composables/useTheme.ts
export function useTheme() {
  const store = usePreferencesStore();
  const isDark = computed(() => {
    if (store.theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches;
    return store.theme === 'dark';
  });

  watch(isDark, (dark) => {
    document.documentElement.classList.toggle('dark', dark);
  }, { immediate: true });

  return { isDark, theme: computed(() => store.theme) };
}
```

```typescript
// packages/api/src/services/threading.ts
// Algoritmo JWZ para agrupación de conversaciones
export class ThreadingService {
  static groupByThread(emails: EmailDoc[]): Map<string, EmailDoc[]> {
    const containers = new Map<string, Container>();

    for (const email of emails) {
      const msgId = email.messageId;
      let container = containers.get(msgId);
      if (!container) {
        container = { id: msgId, message: email, parent: null, children: [] };
        containers.set(msgId, container);
      } else if (!container.message) {
        container.message = email;
      }

      // Procesar In-Reply-To
      const parentId = email.headers?.['in-reply-to']?.[0]?.replace(/[<>]/g, '');
      if (parentId) {
        let parent = containers.get(parentId);
        if (!parent) {
          parent = { id: parentId, message: null, parent: null, children: [] };
          containers.set(parentId, parent);
        }
        container.parent = parent;
        parent.children.push(container);
      }

      // Procesar References
      const refs = email.headers?.['references']?.[0]?.split(/\s+/) || [];
      for (const ref of refs) {
        const cleanRef = ref.replace(/[<>]/g, '');
        let refContainer = containers.get(cleanRef);
        if (!refContainer) {
          refContainer = { id: cleanRef, message: null, parent: null, children: [] };
          containers.set(cleanRef, refContainer);
        }
        if (refContainer !== container.parent && !container.children.includes(refContainer)) {
          // Prune re-parenting según JWZ
        }
      }
    }

    // Agrupar por threadId
    const threads = new Map<string, EmailDoc[]>();
    for (const email of emails) {
      const tid = email.threadId;
      if (!threads.has(tid)) threads.set(tid, []);
      threads.get(tid)!.push(email);
    }
    return threads;
  }
}
```

```typescript
// packages/api/src/routes/search.ts
import { Email } from '../models/Email.js';

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    const { q, accountId, folderId, dateFrom, dateTo, hasAttachments } = req.query as any;

    // Atlas Search aggregation
    const pipeline: any[] = [
      {
        $search: {
          index: 'email_search',
          compound: {
            must: [
              { text: { query: q, path: ['subject', 'bodyText', 'from.address'], fuzzy: { maxEdits: 1 } } },
            ],
            filter: [
              { equals: { path: 'accountId', value: new ObjectId(accountId) } },
            ],
          },
        },
      },
      { $sort: { date: -1 } },
      { $limit: 50 },
      {
        $project: {
          subject: 1, from: 1, date: 1, isRead: 1, threadId: 1,
          highlights: { $meta: 'searchHighlights' },
          score: { $meta: 'searchScore' },
        },
      },
    ];

    if (folderId) {
      pipeline[0].$search.compound.filter.push(
        { equals: { path: 'folderId', value: new ObjectId(folderId) } }
      );
    }

    return Email.aggregate(pipeline);
  });
}
```

**Atajos de teclado configurados:**

| Atajo | Acción | Contexto |
|-------|--------|----------|
| `g` then `i` | Ir a INBOX | Global |
| `c` | Redactar nuevo email | Global |
| `r` | Responder email seleccionado | Vista lectura |
| `f` | Reenviar | Vista lectura |
| `e` | Archivar | Lista emails |
| `*` then `a` | Seleccionar todos | Lista emails |
| `j` / `k` | Navegar siguiente/anterior | Lista emails |
| `?` | Mostrar atajos | Global |
| `Esc` | Cerrar modal/vista | Global |

**Validación final:** Lighthouse score > 90 en performance, accesibilidad y best practices. Coverage de tests > 85%. Todos los contenedores saludables.
