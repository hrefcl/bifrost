import fs from 'fs/promises';
import path from 'path';
import { randomToken } from '../config/crypto.js';

export interface SetupConfig {
  mongodbUri: string;
  redisUrl: string;
  jwtSecret?: string;
  encryptionKey?: string;
  frontendUrl?: string;
  corsOrigin?: string;
  seaweedfsEndpoint?: string;
}

function getEnvPath(): string {
  // Configurable para tests; por defecto el .env del cwd.
  return process.env.SETUP_ENV_PATH ?? path.resolve(process.cwd(), '.env');
}

export async function readEnvFile(): Promise<Record<string, string | undefined>> {
  try {
    const content = await fs.readFile(getEnvPath(), 'utf8');
    const entries = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [key, rest.join('=')] as const;
      });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export async function writeEnvFile(config: SetupConfig): Promise<void> {
  const existing = await readEnvFile();
  const jwtSecret = config.jwtSecret ?? randomToken(32);
  const encryptionKey = config.encryptionKey ?? randomToken(32);
  const frontendUrl = config.frontendUrl ?? 'http://localhost:5173';
  const corsOrigin = config.corsOrigin ?? frontendUrl;

  const merged: Record<string, string> = {
    ...existing,
    NODE_ENV: existing.NODE_ENV ?? 'production',
    PORT: existing.PORT ?? '3000',
    HOST: existing.HOST ?? '0.0.0.0',
    LOG_LEVEL: existing.LOG_LEVEL ?? 'info',
    MONGODB_URI: config.mongodbUri,
    REDIS_URL: config.redisUrl,
    SEAWEEDFS_ENDPOINT:
      config.seaweedfsEndpoint ?? existing.SEAWEEDFS_ENDPOINT ?? 'http://localhost:8333',
    JWT_SECRET: jwtSecret,
    ENCRYPTION_KEY: encryptionKey,
    FRONTEND_URL: frontendUrl,
    CORS_ORIGIN: corsOrigin,
  };

  const lines = Object.entries(merged).map(([key, value]) => `${key}=${value}`);
  // Escritura atómica: escribir a un temporal y renombrar. Evita dejar un .env
  // truncado (sin ENCRYPTION_KEY) si el proceso muere a mitad de escritura, lo
  // que volvería ilegibles todas las credenciales cifradas.
  const envPath = getEnvPath();
  const tmpPath = `${envPath}.tmp`;
  await fs.writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
  await fs.rename(tmpPath, envPath);
}
