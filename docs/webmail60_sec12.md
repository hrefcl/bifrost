# 12. Testing Estratégico

El testing de una aplicación de correo presenta desafíos únicos: parsing MIME, sanitización HTML contra XSS, comunicación con servidores IMAP/SMTP y flujos E2E que atraviesan desde el frontend hasta servidores de correo reales. Este capítulo define la estrategia de testing completa para Webmail 6.0, basada en la pirámide de testing con proporción 70/20/10 [^295^].

## 12.1 Testing Unitario (Vitest)

Vitest es el framework de testing nativo para el ecosistema Vite/Vue 3, ofreciendo soporte integrado de TypeScript, hot module replacement para tests y compatibilidad con la API de Jest [^287^] [^303^]. La configuración base del monorepo ejecuta Vitest en cada package con `@vitest/coverage-v8` para reportes de cobertura.

```typescript
// packages/web/vitest.config.ts
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
      exclude: [
        'node_modules/',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/main.ts',
        'src/router.ts',
        'coverage/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
```

```typescript
// packages/api/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks', // Requerido para Testcontainers [^301^]
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
    setupFiles: ['./test/setup.ts'],
  },
});
```

### 12.1.1 Frontend: mount() y withSetup para Composables

Los componentes Vue 3 que usan `<script setup>` y la Composition API se testean mediante `@vue/test-utils` y su función `mount()`. Para composables que dependen de hooks del ciclo de vida como `onMounted` o `onBeforeMount`, se requiere un helper `withSetup` que los ejecute dentro de un contexto de componente [^298^] [^296^].

```typescript
// packages/web/test/utils.ts
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Helper para testear composables que usan hooks de ciclo de vida.
 * Crea una app Vue temporal, monta el composable y retorna el resultado
 * junto con la instancia de app para limpieza.
 */
export function withSetup<T>(hook: () => T): [T, ReturnType<typeof createApp>] {
  let result!: T;
  const app = createApp({
    setup() {
      result = hook();
      return () => {};
    },
  });
  setActivePinia(createPinia());
  app.mount(document.createElement('div'));
  return [result, app];
}
```

**Ejemplo de test para un componente de lista de emails:**

```typescript
// packages/web/src/components/__tests__/VirtualEmailList.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import VirtualEmailList from '../VirtualEmailList.vue';

describe('VirtualEmailList', () => {
  const mockEmails = Array.from({ length: 20 }, (_, i) => ({
    id: `email-${i}`,
    subject: `Asunto ${i}`,
    from: [{ name: `Remitente ${i}`, address: `user${i}@test.com` }],
    date: new Date(2026, 0, i + 1).toISOString(),
    isRead: i % 2 === 0,
    isStarred: i === 0,
    preview: `Vista previa del correo número ${i}...`,
  }));

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renderiza el contenedor con altura virtual correcta', () => {
    const wrapper = mount(VirtualEmailList, {
      props: {
        emails: mockEmails,
        selected: new Set(),
        total: 100,
      },
    });

    const inner = wrapper.find('[style*="position: relative"]');
    expect(inner.exists()).toBe(true);
    // 100 items * 80px por item = 8000px
    expect(inner.attributes('style')).toContain('height: 8000px');
  });

  it('emite evento select-one al hacer click en un email', async () => {
    const wrapper = mount(VirtualEmailList, {
      props: {
        emails: mockEmails,
        selected: new Set(),
        total: 20,
      },
      attachTo: document.body,
    });

    const firstEmail = wrapper.findAll('[class*="cursor-pointer"]').at(0);
    await firstEmail?.trigger('click');

    expect(wrapper.emitted('select-one')).toBeTruthy();
    expect(wrapper.emitted('select-one')![0]).toEqual(['email-0']);
  });

  it('renderiza solo los emails visibles en el viewport', () => {
    const wrapper = mount(VirtualEmailList, {
      props: {
        emails: mockEmails,
        selected: new Set(),
        total: 100,
      },
      attachTo: document.body,
    });

    // El container simula 800px de alto, con overscan de 5
    // Debería renderizar ~15 items (10 visibles + 5 overscan)
    const items = wrapper.findAll('[class*="cursor-pointer"]');
    expect(items.length).toBeLessThanOrEqual(16);
    expect(items.length).toBeGreaterThan(0);
  });

  it('muestra estado de no leído con font-semibold', () => {
    const wrapper = mount(VirtualEmailList, {
      props: {
        emails: mockEmails,
        selected: new Set(),
        total: 20,
      },
    });

    const items = wrapper.findAll('[class*="cursor-pointer"]');
    // El primer email (index 0) es isRead=true
    expect(items[0].classes()).not.toContain('font-semibold');
    // El segundo email (index 1) es isRead=false
    expect(items[1].classes()).toContain('font-semibold');
  });
});
```

**Ejemplo de test para composable de autenticación:**

```typescript
// packages/web/src/composables/__tests__/useAuth.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { withSetup } from '../../../test/utils';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../lib/api';

// Mock del módulo API
vi.mock('../../lib/api', () => ({
  api: {
    post: vi.fn(),
    defaults: { headers: { common: {} } },
  },
}));

describe('useAuthStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inicia con estado no autenticado', () => {
    const [store, app] = withSetup(() => useAuthStore());
    expect(store.isAuthenticated).toBe(false);
    expect(store.user).toBeNull();
    app.unmount();
  });

  it('login almacena accessToken y configura header', async () => {
    const mockResponse = {
      data: {
        accessToken: 'test-token-123',
        user: { id: '1', username: 'testuser' },
      },
    };
    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const [store, app] = withSetup(() => useAuthStore());
    await store.login('testuser', 'password123');

    expect(store.accessToken).toBe('test-token-123');
    expect(store.isAuthenticated).toBe(true);
    expect(store.user?.username).toBe('testuser');
    expect(api.defaults.headers.common['Authorization']).toBe('Bearer test-token-123');
    app.unmount();
  });

  it('logout limpia estado y headers', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({});

    const [store, app] = withSetup(() => useAuthStore());
    store.accessToken.value = 'existing-token';
    await store.logout();

    expect(store.accessToken).toBeNull();
    expect(store.isAuthenticated).toBe(false);
    expect(api.defaults.headers.common['Authorization']).toBeUndefined();
    app.unmount();
  });

  it('refresh automático se programa al hacer login', async () => {
    const loginResponse = {
      data: { accessToken: 'token-v1', user: { id: '1', username: 'u' } },
    };
    const refreshResponse = {
      data: { accessToken: 'token-v2' },
    };
    vi.mocked(api.post)
      .mockResolvedValueOnce(loginResponse)
      .mockResolvedValueOnce(refreshResponse);

    const [store, app] = withSetup(() => useAuthStore());
    await store.login('user', 'pass');

    // Avanzar 10 minutos para disparar el refresh
    vi.advanceTimersByTime(10 * 60 * 1000);
    await nextTick();

    expect(api.post).toHaveBeenCalledWith(
      '/auth/refresh',
      {},
      { withCredentials: true }
    );
    expect(store.accessToken).toBe('token-v2');
    app.unmount();
  });
});
```

### 12.1.2 Backend: Inyección de Dependencias y Mocks

Los tests unitarios del backend siguen el principio de inyección de dependencias, permitiendo sustituir implementaciones reales por mocks controlados. Para librerías externas como imapflow y Nodemailer, se utilizan mocks de módulo de Vitest [^297^].

```typescript
// packages/api/src/services/__tests__/auth.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { AuthService } from '../auth';

// Mock de redis
vi.mock('../../config/redis', () => ({
  redis: {
    setex: vi.fn().mockResolvedValue('OK'),
    get: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
  },
}));

describe('AuthService', () => {
  describe('encryptCredentials', () => {
    it('encripta y puede desencriptar credenciales correctamente', () => {
      const plain = 'password123!@#';
      const encrypted = AuthService.encryptCredentials(plain);

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.tag).toBeDefined();
      expect(encrypted.ciphertext).not.toBe(plain);

      const decrypted = AuthService.decryptCredentials(
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag
      );
      expect(decrypted).toBe(plain);
    });

    it('produce diferentes ciphertexts para la misma entrada (IV aleatorio)', () => {
      const plain = 'same-password';
      const e1 = AuthService.encryptCredentials(plain);
      const e2 = AuthService.encryptCredentials(plain);

      expect(e1.ciphertext).not.toBe(e2.ciphertext);
      expect(e1.iv).not.toBe(e2.iv);
    });
  });

  describe('createRefreshToken', () => {
    it('almacena token en Redis con TTL de 7 días', async () => {
      const { redis } = await import('../../config/redis');
      const token = await AuthService.createRefreshToken('user-123');

      expect(token).toHaveLength(64); // 32 bytes hex = 64 chars
      expect(redis.setex).toHaveBeenCalledWith(
        expect.stringMatching(/^refresh:[a-f0-9]{64}$/),
        604800, // 7 * 24 * 3600
        expect.stringContaining('"userId":"user-123"')
      );
    });
  });

  describe('validateRefreshToken', () => {
    it('retorna datos y elimina token (one-time use)', async () => {
      const { redis } = await import('../../config/redis');
      const mockData = JSON.stringify({ userId: 'user-123', family: 'fam-abc' });
      vi.mocked(redis.get).mockResolvedValue(mockData);

      const result = await AuthService.validateRefreshToken('token-id-456');

      expect(result).toEqual({ userId: 'user-123', family: 'fam-abc' });
      expect(redis.del).toHaveBeenCalledWith('refresh:token-id-456');
    });

    it('retorna null para token inexistente', async () => {
      const { redis } = await import('../../config/redis');
      vi.mocked(redis.get).mockResolvedValue(null);

      const result = await AuthService.validateRefreshToken('nonexistent');
      expect(result).toBeNull();
    });
  });
});
```

```typescript
// packages/api/src/services/__tests__/smtp.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmtpService } from '../smtp';
import nodemailer from 'nodemailer';

vi.mock('nodemailer', async () => {
  const actual = await vi.importActual<typeof import('nodemailer')>('nodemailer');
  return {
    ...actual,
    default: {
      createTransport: vi.fn().mockReturnValue({
        sendMail: vi.fn().mockResolvedValue({ messageId: '<test-msg-id>' }),
      }),
    },
  };
});

describe('SmtpService', () => {
  const mockAccount = {
    _id: { toString: () => 'acc-1' } as any,
    email: 'user@example.com',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    displayName: 'Test User',
    credentialsEncrypted: 'cipher',
    credentialsIv: 'iv123',
    credentialsTag: 'tag123',
    get: vi.fn(),
  } as unknown as AccountDoc;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('crea transporter con configuración correcta', async () => {
    const service = new SmtpService();
    // Mock decryptCredentials para retornar JSON de credenciales
    vi.spyOn(AuthService, 'decryptCredentials').mockReturnValue('{"password":"secret"}');

    await service.getTransporter(mockAccount);

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: true,
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        maxConnections: 3,
        maxMessages: 100,
      })
    );
  });

  it('envía email y retorna messageId', async () => {
    const service = new SmtpService();
    vi.spyOn(AuthService, 'decryptCredentials').mockReturnValue('{"password":"secret"}');

    const msgId = await service.sendEmail(mockAccount, {
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    });

    expect(msgId).toBe('<test-msg-id>');
  });
});
```

### 12.1.3 Sanitización: Regresión XSS con Payloads Conocidos

La sanitización HTML es la línea de defensa crítica contra ataques XSS vía correo electrónico. Dado el historial de vulnerabilidades en DOMPurify, incluyendo CVE-2025-15599 [^281^] [^282^], se mantiene una suite de regresión con payloads conocidos.

```typescript
// packages/api/src/services/__tests__/sanitize.spec.ts
import { describe, it, expect } from 'vitest';
import sanitizeHtml from 'sanitize-html';

// Payloads de ataque XSS conocidos
const XSS_PAYLOADS = [
  {
    name: 'script tag básico',
    input: '<script>alert("xss")</script><p>legitimo</p>',
    allowedTags: ['p'],
  },
  {
    name: 'img onerror',
    input: '<img src=x onerror="alert(\'xss\')">',
    allowedTags: ['img'],
  },
  {
    name: 'javascript: protocol',
    input: '<a href="javascript:alert(\'xss\')">click</a>',
    allowedTags: ['a'],
  },
  {
    name: 'SVG onload',
    input: '<svg onload="alert(\'xss\')">',
    allowedTags: ['svg'],
  },
  {
    name: 'CVE-2025-15599 textarea bypass',
    input: '<textarea><img src=x onerror=alert(1)>',
    allowedTags: ['textarea', 'img'],
  },
  {
    name: 'nested event handlers',
    input: '<div onclick="alert(1)" onmouseover="alert(2)">text</div>',
    allowedTags: ['div'],
  },
  {
    name: 'data: URI execution',
    input: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgnWFNTJyk8L3NjcmlwdD4=">click</a>',
    allowedTags: ['a'],
  },
  {
    name: 'style expression (legacy IE)',
    input: '<div style="background-image: url(javascript:alert(1))">text</div>',
    allowedTags: ['div'],
  },
  {
    name: 'HTML entities en event handlers',
    input: '<img src=x onerror="&#97;&#108;&#101;&#114;&#116;(1)">',
    allowedTags: ['img'],
  },
  {
    name: 'template injection',
    input: '<template><script>alert(1)</script></template>',
    allowedTags: ['template'],
  },
];

describe('Sanitización HTML - Regresión XSS', () => {
  XSS_PAYLOADS.forEach(({ name, input }) => {
    it(`elimina vectores XSS: ${name}`, () => {
      const result = sanitizeHtml(input, {
        allowedTags: [
          'p', 'br', 'strong', 'em', 'u', 'a', 'img', 'table', 'tr', 'td', 'th',
          'thead', 'tbody', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'blockquote', 'pre', 'code', 'span', 'div',
        ],
        allowedAttributes: {
          a: ['href', 'title'],
          img: ['src', 'alt', 'width', 'height'],
          '*': ['style'],
        },
        allowedSchemes: ['http', 'https', 'mailto'],
      });

      expect(result).not.toMatch(/<script\b[^>]*>/i);
      expect(result).not.toMatch(/on\w+\s*=/i);
      expect(result).not.toMatch(/javascript:/i);
      expect(result).not.toMatch(/data:text\/html/i);
    });
  });

  it('preserva contenido legítimo después de sanitizar', () => {
    const input = '<p>Hola <strong>mundo</strong></p><script>alert(1)</script>';
    const result = sanitizeHtml(input, {
      allowedTags: ['p', 'strong'],
      allowedAttributes: {},
    });
    expect(result).toBe('<p>Hola <strong>mundo</strong></p>');
  });

  it('permite links https válidos', () => {
    const input = '<a href="https://example.com">Link</a>';
    const result = sanitizeHtml(input, {
      allowedTags: ['a'],
      allowedAttributes: { a: ['href'] },
      allowedSchemes: ['https'],
    });
    expect(result).toContain('href="https://example.com"');
  });
});
```

## 12.2 Testing de Integración (Fastify.inject + Testcontainers)

Los tests de integración validan que los componentes del backend funcionen correctamente en conjunto, incluyendo acceso a bases de datos reales y endpoints HTTP. `fastify.inject` es la herramienta nativa de Fastify que bypassa la capa HTTP/TCP, ofreciendo 2-5x más velocidad que supertest [^321^].

### 12.2.1 fastify.inject para API

```typescript
// packages/api/test/setup.ts
import { beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { RedisContainer } from '@testcontainers/redis';
import { buildApp } from '../src/app';

let mongoContainer: MongoDBContainer;
let redisContainer: RedisContainer;

export const setupTestEnv = async () => {
  mongoContainer = await new MongoDBContainer('mongo:7.0.16').start();
  redisContainer = await new RedisContainer('redis:7.4-alpine').start();

  process.env.MONGODB_URI = mongoContainer.getConnectionString();
  process.env.REDIS_URL = redisContainer.getConnectionUrl();
  process.env.JWT_SECRET = 'test-secret-key-32-bytes-long!!';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);

  const app = await buildApp();
  return { app, mongoContainer, redisContainer };
};
```

```typescript
// packages/api/src/routes/__tests__/auth.integration.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnv } from '../../../test/setup';
import type { FastifyInstance } from 'fastify';

describe('Auth API Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = await setupTestEnv();
    app = env.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/register crea un nuevo usuario', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username: 'testuser',
        password: 'SecurePass123!',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.user.username).toBe('testuser');
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('POST /auth/login retorna tokens válidos', async () => {
    // Primero registrar
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 'logintest', password: 'SecurePass123!' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'logintest', password: 'SecurePass123!' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.accessToken).toBeDefined();
    expect(typeof body.accessToken).toBe('string');
    expect(body.user.username).toBe('logintest');
  });

  it('POST /auth/login rechaza credenciales incorrectas', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'nope', password: 'wrong' },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('Invalid');
  });

  it('POST /auth/refresh rota el refresh token (one-time use)', async () => {
    // Login para obtener cookie de refresh
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 'refreshuser', password: 'SecurePass123!' },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'refreshuser', password: 'SecurePass123!' },
    });

    const setCookie = loginRes.headers['set-cookie'] as string;
    expect(setCookie).toBeDefined();

    // Primer refresh exitoso
    const refresh1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: setCookie },
    });
    expect(refresh1.statusCode).toBe(200);

    // Segundo refresh con mismo token debe fallar
    const refresh2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: setCookie },
    });
    expect(refresh2.statusCode).toBe(401);
  });

  it('POST /auth/logout invalida el refresh token', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'refreshuser', password: 'SecurePass123!' },
    });

    const setCookie = loginRes.headers['set-cookie'] as string;

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: setCookie },
    });
    expect(logoutRes.statusCode).toBe(200);

    // Intentar refresh después de logout
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: setCookie },
    });
    expect(refreshRes.statusCode).toBe(401);
  });
});
```

### 12.2.2 Testcontainers para MongoDB y Redis

Testcontainers proporciona instancias reales de MongoDB y Redis en contenedores Docker durante los tests, eliminando las limitaciones de mongodb-memory-server con respecto a transacciones y change streams [^301^] [^267^].

```typescript
// packages/api/src/routes/__tests__/emails.integration.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnv } from '../../../test/setup';
import { User } from '../../models/User';
import { Email } from '../../models/Email';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';

describe('Emails API Integration', () => {
  let app: FastifyInstance;
  let authToken: string;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    const env = await setupTestEnv();
    app = env.app;

    // Crear usuario y autenticar
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 'emailtest', password: 'SecurePass123!' },
    });
    const regBody = JSON.parse(regRes.payload);
    authToken = regBody.accessToken;
    userId = regBody.user.id;

    // Crear cuenta de correo
    const accountRes = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        email: 'test@example.com',
        provider: 'imap',
        imapHost: 'imap.example.com',
        imapPort: 993,
        password: 'app-password',
        displayName: 'Test Account',
      },
    });
    accountId = JSON.parse(accountRes.payload).account.id;

    // Seed de emails de prueba
    const folderId = new mongoose.Types.ObjectId();
    await Email.insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        userId: new mongoose.Types.ObjectId(userId),
        accountId: new mongoose.Types.ObjectId(accountId),
        folderId,
        uid: i + 1,
        messageId: `<msg-${i}@example.com>`,
        threadId: i < 10 ? 'thread-1' : `thread-${i}`,
        subject: `Email de prueba ${i}`,
        from: [{ name: 'Sender', address: `sender${i}@test.com` }],
        to: [{ name: 'Test', address: 'test@example.com' }],
        date: new Date(2026, 0, i + 1),
        bodyText: `Contenido del email número ${i}`,
        isRead: i % 3 === 0,
        isStarred: i === 0,
        size: 1024 + i * 100,
      }))
    );
  });

  it('GET /api/v1/emails lista emails con paginación', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/emails?accountId=${accountId}&limit=20`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.emails).toHaveLength(20);
    expect(body.total).toBe(50);
    expect(body.emails[0]).toHaveProperty('subject');
    expect(body.emails[0]).toHaveProperty('from');
  });

  it('GET /api/v1/emails filtra por folder', async () => {
    const folderId = new mongoose.Types.ObjectId();
    await Email.create({
      userId: new mongoose.Types.ObjectId(userId),
      accountId: new mongoose.Types.ObjectId(accountId),
      folderId,
      uid: 999,
      messageId: '<other-folder-msg@example.com>',
      threadId: 'other-thread',
      subject: 'Email en otra carpeta',
      from: [{ name: 'Sender', address: 'sender@test.com' }],
      date: new Date(),
      bodyText: 'Contenido',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/emails?accountId=${accountId}&folderId=${folderId.toString()}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.emails).toHaveLength(1);
    expect(body.emails[0].subject).toBe('Email en otra carpeta');
  });

  it('GET /api/v1/emails ordena por fecha descendente', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/emails?accountId=${accountId}&limit=5`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    const body = JSON.parse(response.payload);
    const dates = body.emails.map((e: any) => new Date(e.date).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it('PATCH /api/v1/emails/:id marca como leído', async () => {
    const email = await Email.findOne({ accountId, isRead: false });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/emails/${email!._id}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { isRead: true },
    });

    expect(response.statusCode).toBe(200);
    const updated = await Email.findById(email!._id);
    expect(updated!.isRead).toBe(true);
  });

  it('DELETE /api/v1/emails/:id elimina un email', async () => {
    const email = await Email.findOne({ accountId });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/emails/${email!._id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(204);
    const deleted = await Email.findById(email!._id);
    expect(deleted).toBeNull();
  });

  afterAll(async () => {
    await app.close();
  });
});
```

### 12.2.3 Mock IMAP/SMTP con Ethereal.email

Para tests que requieren protocolos IMAP y SMTP reales sin riesgo de envío, Ethereal.email proporciona un servicio SMTP/IMAP falso donde los correos nunca se entregan pero pueden verificarse vía IMAP [^300^] [^276^].

```typescript
// packages/api/src/services/__tests__/imap.integration.spec.ts
import { describe, it, expect } from 'vitest';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';

describe('IMAP/SMTP Integration con Ethereal.email', () => {
  it('envía email vía SMTP y lo recupera vía IMAP', async () => {
    // 1. Crear cuenta Ethereal
    const testAccount = await nodemailer.createTestAccount();

    // 2. Enviar email vía SMTP
    const transporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });

    await transporter.sendMail({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test IMAP Integration',
      text: 'Este es el cuerpo en texto plano',
      html: '<p>Este es el cuerpo <strong>HTML</strong></p>',
    });

    // 3. Recuperar vía IMAP con imapflow
    const client = new ImapFlow({
      host: testAccount.imap.host,
      port: testAccount.imap.port,
      secure: testAccount.imap.secure,
      auth: { user: testAccount.user, pass: testAccount.pass },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const messages = [];
      for await (const msg of client.fetch('1:*', { envelope: true, source: true })) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThanOrEqual(1);

      // 4. Parsear con PostalMime
      const latest = messages[messages.length - 1];
      const parsed = await PostalMime.parse(latest.source);

      expect(parsed.subject).toBe('Test IMAP Integration');
      expect(parsed.text).toContain('texto plano');
      expect(parsed.html).toContain('<strong>HTML</strong>');
    } finally {
      lock.release();
      await client.logout();
    }
  }, 30000); // Timeout 30s para operaciones IMAP
});
```

## 12.3 Testing E2E (Playwright)

Playwright es el framework de E2E recomendado para aplicaciones Vue.js en 2026, superando a Cypress en descargas npm, estrellas GitHub y ofertas de empleo [^261^]. Soporta ejecución paralela cross-browser, espera automática para reducir flaky tests y `APIRequestContext` para tests híbridos API+UI [^260^].

### 12.3.1 Flujos Críticos: Login, Compose, Enviar, Recibir

```typescript
// packages/web/e2e/auth.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Flujo de Autenticación', () => {
  test('login exitoso redirige a inbox', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[data-testid="username"]', 'testuser');
    await page.fill('[data-testid="password"]', 'SecurePass123!');
    await page.click('[data-testid="login-button"]');

    await expect(page).toHaveURL('/inbox');
    await expect(page.locator('[data-testid="inbox-title"]')).toBeVisible();
  });

  test('login fallido muestra mensaje de error', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[data-testid="username"]', 'wrong');
    await page.fill('[data-testid="password"]', 'wrong');
    await page.click('[data-testid="login-button"]');

    await expect(page.locator('[data-testid="login-error"]')).toBeVisible();
    await expect(page).toHaveURL('/login');
  });

  test('token expirado redirige a login', async ({ page, context }) => {
    // Simular token expirado inyectando uno inválido
    await context.addInitScript(() => {
      localStorage.setItem('accessToken', 'expired-token-xxx');
    });

    await page.goto('/inbox');

    // Debería redirigir a login cuando el API rechaza el token
    await expect(page).toHaveURL('/login', { timeout: 10000 });
  });
});
```

```typescript
// packages/web/e2e/compose.spec.ts
import { test, expect } from '@playwright/test';
import { createInbox, waitForEmail } from './helpers/mailslurp';

test.describe('Flujo de Redacción y Envío', () => {
  test('redactar y enviar email a inbox real', async ({ page }) => {
    // Crear inbox desechable para recibir el email
    const inbox = await createInbox();

    await page.goto('/compose');

    // Llenar campos del email
    await page.fill('[data-testid="to-input"]', inbox.emailAddress);
    await page.fill('[data-testid="subject-input"]', 'E2E Test Subject');

    // Escribir en el editor Tiptap (contenteditable)
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await editor.fill('Este es un email enviado desde Playwright E2E.');

    // Enviar
    await page.click('[data-testid="send-button"]');

    // Verificar mensaje de éxito
    await expect(page.locator('[data-testid="send-success"]')).toBeVisible();

    // Verificar que llegó al inbox (via MailSlurp API)
    const receivedEmail = await waitForEmail(inbox.id, { subjectContains: 'E2E Test Subject' });
    expect(receivedEmail).toBeDefined();
    expect(receivedEmail.subject).toBe('E2E Test Subject');
  });

  test('auto-save de borrador cada 10 segundos', async ({ page }) => {
    await page.goto('/compose');

    await page.fill('[data-testid="to-input"]', 'draft@example.com');
    await page.fill('[data-testid="subject-input"]', 'Draft Auto-Save');

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await editor.fill('Contenido del borrador...');

    // Esperar auto-save (10 segundos)
    await page.waitForTimeout(11000);

    await expect(page.locator('[data-testid="last-saved"]')).toContainText('Guardado');

    // Recargar y verificar que se restauró
    await page.reload();
    await expect(page.locator('[data-testid="subject-input"]')).toHaveValue('Draft Auto-Save');
  });

  test('reply cita el email original', async ({ page }) => {
    // Seed: crear un email de prueba vía API
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid="email-list-item"]');

    // Seleccionar primer email
    await page.click('[data-testid="email-list-item"]:first-child');

    // Click en responder
    await page.click('[data-testid="reply-button"]');

    await expect(page).toHaveURL(/\/compose\?replyTo=/);

    // Verificar que el asunto tiene "Re:"
    const subject = await page.inputValue('[data-testid="subject-input"]');
    expect(subject).toMatch(/^Re: /);

    // Verificar que el editor contiene la cita
    const editorHtml = await page.locator('.ProseMirror').innerHTML();
    expect(editorHtml).toContain('blockquote');
  });
});
```

### 12.3.2 MailSlurp para Email Real en E2E

MailSlurp proporciona inboxes desechables programáticos con SMTP y API REST, ideal para testing de flujos de correo en CI/CD [^324^].

```typescript
// packages/web/e2e/helpers/mailslurp.ts
import { MailSlurp } from 'mailslurp-client';

const mailslurp = new MailSlurp({ apiKey: process.env.MAILSLURP_API_KEY! });

export async function createInbox() {
  return mailslurp.createInbox();
}

export async function waitForEmail(
  inboxId: string,
  options: { subjectContains?: string; timeout?: number } = {}
) {
  const { subjectContains, timeout = 60000 } = options;

  const emails = await mailslurp.waitForLatestEmail(inboxId, timeout);

  if (subjectContains && !emails.subject?.includes(subjectContains)) {
    throw new Error(`Subject mismatch: expected "${subjectContains}", got "${emails.subject}"`);
  }

  return emails;
}

export async function deleteInbox(inboxId: string) {
  await mailslurp.deleteInbox(inboxId);
}
```

### 12.3.3 Calendario: Sync CalDAV E2E

```typescript
// packages/web/e2e/calendar.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Calendario E2E', () => {
  test('navegación entre vistas día/semana/mes', async ({ page }) => {
    await page.goto('/calendar');

    // Verificar vista semanal por defecto
    await expect(page.locator('.fc-timeGridWeek-view')).toBeVisible();

    // Cambiar a vista mensual
    await page.click('text=Mes');
    await expect(page.locator('.fc-dayGridMonth-view')).toBeVisible();

    // Cambiar a vista diaria
    await page.click('text=Día');
    await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  });

  test('crear evento y visualizarlo', async ({ page }) => {
    await page.goto('/calendar');

    // Click en slot horario
    await page.click('.fc-time-grid .fc-slats tr[data-time="10:00:00"]');

    // Llenar formulario
    await page.fill('[data-testid="event-title"]', 'Reunión E2E');
    await page.fill('[data-testid="event-location"]', 'Sala Virtual');
    await page.click('[data-testid="event-save"]');

    // Verificar que aparece en el calendario
    await expect(page.locator('text=Reunión E2E')).toBeVisible();
  });
});
```

## 12.4 Cobertura y CI

### 12.4.1 Thresholds de Cobertura

| Métrica | Threshold | Justificación |
|---------|-----------|---------------|
| Líneas | 85% | Cobertura completa de lógica de negocio |
| Funciones | 85% | Todas las funciones públicas testeadas |
| Ramas | 80% | Casos de error y paths alternativos |
| Statements | 85% | Sentencias ejecutables |

### 12.4.2 Pirámide de Testing: 70/20/10

| Nivel | Proporción | Framework | Ejemplos |
|-------|------------|-----------|----------|
| Unitario | 70% | Vitest | Composables, servicios, sanitización, utilidades |
| Integración | 20% | Vitest + Testcontainers | API endpoints, DB queries, auth flows |
| E2E | 10% | Playwright | Login→compose→send, calendario, drag-drop |

### 12.4.3 Reporte de Cobertura en PRs

La acción `davelosert/vitest-coverage-report-action@v2` publica reportes de cobertura como comentarios en pull requests, con comparación contra la rama base [^216^] [^272^].

```yaml
# Fragmento del workflow CI (completo en capítulo 13)
- name: Run tests with coverage
  run: pnpm -r test:unit --coverage

- name: Upload coverage report
  uses: actions/upload-artifact@v4
  with:
    name: coverage-report
    path: '**/coverage/*.json'

- name: Post coverage comment
  uses: davelosert/vitest-coverage-report-action@v2
  with:
    json-summary-path: ./packages/api/coverage/coverage-summary.json
    json-final-path: ./packages/api/coverage/coverage-final.json
    file-coverage-mode: changes
    reportOnFailure: true
```

**Comandos de ejecución local:**

```bash
# Tests unitarios con watch mode
pnpm test:unit

# Tests unitarios con cobertura
pnpm test:unit --coverage

# Tests de integración
pnpm test:integration

# Tests E2E
pnpm test:e2e

# Todos los tests (CI)
pnpm test
```

**Criterios de aceptación del capítulo de testing:**
- Suite unitaria completa con >85% cobertura
- Tests de integración para todos los endpoints de la API
- Tests E2E para flujos críticos (login, compose, envío, lectura)
- Suite de regresión XSS con 10+ payloads conocidos
- Reporte de cobertura automático en cada PR
