import { readFileSync } from 'node:fs';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const CRITICAL_VARS = ['MONGODB_URI', 'REDIS_URL', 'JWT_SECRET', 'ENCRYPTION_KEY'] as const;

/**
 * Soporte de docker-secrets (`<VAR>_FILE`): si está seteado `<VAR>_FILE` y `<VAR>` está vacío, lee
 * el secreto del archivo y lo carga en `<VAR>`. Es la convención estándar de Docker Compose secrets
 * (el compose monta el secreto y pasa `JWT_SECRET_FILE`/`ENCRYPTION_KEY_FILE`, NO el valor en claro).
 * Debe correr ANTES de evaluar setup-mode / parsear el schema. Exportada para poder testearla.
 */
export function resolveFileSecrets(): void {
  for (const key of CRITICAL_VARS) {
    const filePath = process.env[`${key}_FILE`];
    const current = process.env[key];
    if (filePath && (!current || current.trim() === '')) {
      try {
        process.env[key] = readFileSync(filePath, 'utf8').trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`No se pudo leer ${key}_FILE=${filePath}: ${msg}`);
      }
    }
  }
}

resolveFileSecrets();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  SEAWEEDFS_ENDPOINT: z.string().url().default('http://localhost:8333'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // TTL del access token. Se EXIGE unidad (s/m/h/d) para evitar la trampa de `ms`: un '900'
  // pelado lo interpretaría como 900ms, no 900s. Configurable (E2E usa '3s'); default 15m.
  JWT_ACCESS_TTL: z
    .string()
    .regex(/^\d+(ms|s|m|h|d)$/, "JWT_ACCESS_TTL debe llevar unidad: '15m', '3s', '2h'…")
    .default('15m'),
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
    // Fail-fast en el boot: exigir HEX acá (no recién al usarse en crypto.ts) — un valor de 64
    // chars no-hex pasaría el length y fallaría tarde, en la primera operación de cifrado.
    .regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY debe ser hex (0-9a-f)'),

  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Si el box trae su PROPIO mailserver (turnkey), su hostname (p.ej. mail.empresa.com). Cuando está
  // seteado, el login del webmail defaultea a este servidor y OCULTA "Configuración del servidor" → se
  // comporta como webmail NATIVO del dominio. Vacío = instalación genérica (modo "traé tu IMAP").
  MAIL_SERVER_HOST: z.string().optional(),
});

const partialSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

export type Env = z.infer<typeof envSchema>;
export type PartialEnv = z.infer<typeof partialSchema>;

function missingCriticalVars(): string[] {
  return CRITICAL_VARS.filter((key) => {
    const value = process.env[key];
    return !value || value.trim() === '';
  });
}

export function isSetupMode(): boolean {
  return missingCriticalVars().length > 0;
}

export function getMissingCriticalVars(): string[] {
  return missingCriticalVars();
}

export function validateEnv(): Env {
  return envSchema.parse(process.env);
}

export function getPartialEnv(): PartialEnv {
  return partialSchema.parse(process.env);
}

export const env = isSetupMode() ? (getPartialEnv() as Env) : validateEnv();

/**
 * TTL del access token en segundos, derivado de JWT_ACCESS_TTL (formato '15m'/'3s'/'2h'…),
 * para que el `expiresIn` que devuelven /auth/login y /auth/refresh sea COHERENTE con la
 * expiración real firmada por el plugin (antes era 900 hardcodeado).
 */
function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(ttl.trim());
  if (!m) return 900;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms':
      return Math.max(1, Math.floor(n / 1000));
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      return n; // 's' o sin unidad → segundos
  }
}

export const jwtAccessTtlSeconds = ttlToSeconds(env.JWT_ACCESS_TTL);

export function validateEncryptionKey(): void {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  }
}
