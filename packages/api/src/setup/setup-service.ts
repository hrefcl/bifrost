import mongoose from 'mongoose';
import { randomToken } from '../config/crypto.js';
import { writeEnvFile, readEnvFile } from './env-writer.js';
import { validateMongoDb, validateRedis } from './validators.js';

function isValidHexKey(v: string | undefined): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
}

export interface SetupPayload {
  db: {
    mongodbUri: string;
    redisUrl: string;
  };
  admin: {
    email: string;
    password: string;
    displayName: string;
  };
  email: {
    name: string;
    email: string;
    password: string;
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
  };
  app?: {
    frontendUrl?: string;
    corsOrigin?: string;
  };
}

export interface SetupResult {
  ok: boolean;
  error?: string;
  requiresRestart: boolean;
}

export async function performSetup(payload: SetupPayload): Promise<SetupResult> {
  const dbOk = await validateMongoDb(payload.db.mongodbUri);
  if (!dbOk.ok) return { ok: false, error: dbOk.error, requiresRestart: false };

  const redisOk = await validateRedis(payload.db.redisUrl);
  if (!redisOk.ok) return { ok: false, error: redisOk.error, requiresRestart: false };

  // Reusar secretos ya presentes en .env en vez de regenerarlos. Esto hace el
  // setup IDEMPOTENTE ante reintentos/fallos parciales: la clave de cifrado no
  // rota entre intentos, así una cuenta ya creada sigue siendo descifrable.
  const existingEnv = await readEnvFile();
  const encryptionKey = isValidHexKey(existingEnv.ENCRYPTION_KEY)
    ? existingEnv.ENCRYPTION_KEY
    : randomToken(32);
  const jwtSecret =
    existingEnv.JWT_SECRET && existingEnv.JWT_SECRET.length >= 32
      ? existingEnv.JWT_SECRET
      : randomToken(32);

  await mongoose.connect(payload.db.mongodbUri);

  // Disponibilizar la clave en este proceso para que crypto.getKey() cifre con la
  // clave definitiva. Si algo falla antes de persistir el .env, se hace ROLLBACK de
  // process.env: así isSetupMode() vuelve a true y el usuario puede reintentar SIN
  // reiniciar (evita el half-state bloqueante). El .env se persiste al FINAL.
  const prevJwt = process.env.JWT_SECRET;
  const prevEnc = process.env.ENCRYPTION_KEY;
  const restoreEnv = (key: 'JWT_SECRET' | 'ENCRYPTION_KEY', val: string | undefined) => {
    if (val === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = val;
  };

  try {
    process.env.JWT_SECRET = jwtSecret;
    process.env.ENCRYPTION_KEY = encryptionKey;

    const { User } = await import('../models/User.js');
    const { Account } = await import('../models/Account.js');
    const { SystemConfig } = await import('../models/SystemConfig.js');

    // Upsert idempotente del usuario admin. role:'admin' se fija acá (en el setup inicial,
    // cuando el sistema aún no tiene config) — NUNCA en el auto-registro por login.
    const user = await User.findOneAndUpdate(
      { primaryEmail: payload.admin.email },
      {
        $setOnInsert: { primaryEmail: payload.admin.email },
        $set: { displayName: payload.admin.displayName, role: 'admin' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Upsert idempotente de la cuenta; SIEMPRE re-cifra la credencial del buzón
    // con la clave actual (si la clave rotó en un intento previo, queda consistente).
    const account =
      (await Account.findOne({ userId: user._id, email: payload.email.email })) ??
      new Account({ userId: user._id, email: payload.email.email, isPrimary: true });
    account.name = payload.email.email;
    account.isPrimary = true;
    account.imap = {
      host: payload.email.imapHost,
      port: payload.email.imapPort,
      secure: payload.email.imapSecure,
      authMethod: 'password',
      authUser: payload.email.email,
      authCredentials: '',
      authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
      compress: false,
      preferredProtocol: 'imap',
    };
    account.smtp = {
      host: payload.email.smtpHost,
      port: payload.email.smtpPort,
      secure: payload.email.smtpSecure,
      authMethod: 'password',
      authUser: payload.email.email,
      authCredentials: '',
      authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
    };
    account.status = 'active';
    // Credencial del BUZÓN (no la del admin): es la que usan IMAP/SMTP.
    account.setImapCredentials(payload.email.password);
    account.setSmtpCredentials(payload.email.password);
    await account.save();

    // Persistir .env (escritura atómica) ANTES de marcar SystemConfig. Orden clave
    // para auto-curación: si el proceso muere antes del writeEnvFile, no quedó ni
    // .env ni SystemConfig → el reintento regenera/reusa y se completa; si muere
    // entre writeEnvFile y SystemConfig, la cuenta ya es descifrable con la clave
    // persistida y el reintento reusa esa misma clave (sin rotación).
    await writeEnvFile({
      mongodbUri: payload.db.mongodbUri,
      redisUrl: payload.db.redisUrl,
      jwtSecret,
      encryptionKey,
      frontendUrl: payload.app?.frontendUrl,
      corsOrigin: payload.app?.corsOrigin,
    });

    // NOTA: el marcador SystemConfig 'setup' es write-only — NADIE lo lee. El gate
    // real de "ya configurado" es isSetupMode() (presencia de secretos en env). Se
    // conserva como registro/auditoría, no controla el flujo.
    await SystemConfig.findOneAndUpdate(
      { key: 'setup' },
      { key: 'setup', value: { completedAt: new Date().toISOString(), version: '0.1.0' } },
      { upsert: true }
    );
  } catch (err) {
    // Rollback de process.env: si fallamos antes de persistir el .env, isSetupMode()
    // vuelve a true y el usuario puede reintentar sin reiniciar (no half-state).
    restoreEnv('JWT_SECRET', prevJwt);
    restoreEnv('ENCRYPTION_KEY', prevEnc);
    throw err;
  } finally {
    await mongoose.disconnect();
  }

  return { ok: true, requiresRestart: true };
}

export function generateSecrets(): { jwtSecret: string; encryptionKey: string } {
  return {
    jwtSecret: randomToken(32),
    encryptionKey: randomToken(32),
  };
}
