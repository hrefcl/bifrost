import { createImapClient } from './mail-transport.js';
import { User, type IUser } from '../models/User.js';
import { Account, type IAccount } from '../models/Account.js';
import { redis } from '../config/redis.js';
import { jwtAccessTtlSeconds } from '../config/env.js';
import { randomToken, hashToken, hmacToken, verifyHmac } from '../config/crypto.js';
import type { LoginResponse } from '@webmail6/shared';

const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface LoginInput {
  email: string;
  password: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface TokenPayload {
  userId: string;
  accountId?: string;
}

export async function verifyImapCredentials(input: LoginInput): Promise<boolean> {
  const client = createImapClient({
    host: input.imapHost,
    port: input.imapPort,
    secure: input.imapSecure,
    auth: { user: input.email, pass: input.password },
    logger: false,
    emitLogs: false,
  });

  try {
    await client.connect();
    await client.logout();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
}

export async function loginOrRegister(input: LoginInput): Promise<{
  user: IUser;
  account: IAccount;
  isNew: boolean;
}> {
  const isValid = await verifyImapCredentials(input);
  if (!isValid) {
    throw new Error('Invalid IMAP credentials');
  }

  // Upsert atómico del usuario (evita E11000 por findOne→create concurrente).
  // El filtro coincide con el índice único ({primaryEmail}); retry ante carrera.
  const before = await User.findOne({ primaryEmail: input.email }).lean();
  const isNew = !before;
  // `??` sólo cubría undefined: el form de login manda displayName:'' → quedaba vacío y el
  // usuario violaba `required` (rompía cualquier user.save() posterior). Normalizamos: vacío/
  // sólo-espacios cae al prefijo del email.
  const trimmedName = input.displayName?.trim();
  const displayName =
    trimmedName && trimmedName.length > 0 ? trimmedName : input.email.split('@')[0];
  const user = await withDupRetry(() =>
    User.findOneAndUpdate(
      { primaryEmail: input.email },
      {
        $setOnInsert: {
          primaryEmail: input.email,
          displayName,
        },
        $set: { lastLoginAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
  );

  // Upsert atómico de la cuenta. FILTRO {email} para coincidir con el índice único
  // global de Account.email (si fuera {userId,email} chocaría con el índice → E11000).
  const account = await withDupRetry(() =>
    Account.findOneAndUpdate(
      { email: input.email },
      {
        $setOnInsert: {
          userId: user._id,
          name: input.email,
          email: input.email,
          isPrimary: true,
          imap: {
            host: input.imapHost,
            port: input.imapPort,
            secure: input.imapSecure,
            authMethod: 'password',
            authUser: input.email,
            authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
            compress: false,
            preferredProtocol: 'imap',
          },
          smtp: {
            host: input.smtpHost,
            port: input.smtpPort,
            secure: input.smtpSecure,
            authMethod: 'password',
            authUser: input.email,
            authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
  );

  account.setImapCredentials(input.password);
  account.setSmtpCredentials(input.password);
  account.status = 'active';
  account.lastError = undefined;
  await account.save();

  return { user, account, isNew };
}

/** Reintenta una operación una vez si choca con índice único (E11000) por carrera. */
async function withDupRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return fn();
    throw err;
  }
}

// El token entregado al cliente embebe `${userId}.${familyId}.${rawId}`: así el
// servidor resuelve userId/familyId sin escanear Redis (no más redis.keys()), y la
// key en Redis guarda sólo el HASH del rawId (token en reposo no recuperable).
function refreshKey(userId: string, rawId: string): string {
  return `refresh:${userId}:${hashToken(rawId)}`;
}
function familyKey(familyId: string): string {
  return `refreshfamily:${familyId}`;
}
interface ParsedToken {
  userId: string;
  familyId: string;
  rawId: string;
}
function parseRefreshToken(token: string): ParsedToken | null {
  const parts = token.split('.');
  if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[2] || !parts[3]) return null;
  const [userId, familyId, rawId, mac] = parts;
  // Verificar el HMAC del envelope: sin esto, un atacante podría forjar
  // `userId.familyId.cualquierCosa` y disparar la revocación de la familia (DoS de
  // sesión). Un token forjado se rechaza ANTES de tocar Redis (sin revocar nada).
  if (!verifyHmac(`${userId}.${familyId}.${rawId}`, mac)) return null;
  return { userId, familyId, rawId };
}

export function getUserIdFromRefreshToken(token: string): string | null {
  return parseRefreshToken(token)?.userId ?? null;
}

export async function createRefreshToken(
  userId: string,
  familyId: string,
  userAgent?: string,
  ipAddress?: string
): Promise<string> {
  const rawId = randomToken(32);
  const key = refreshKey(userId, rawId);
  const fkey = familyKey(familyId);
  // Pipeline atómico: el token y su pertenencia al family set se escriben juntos. Antes
  // eran 3 comandos sueltos → si Redis caía entre medio, el token quedaba fuera del set
  // y revokeTokenFamily no lo alcanzaba (activo hasta el TTL).
  await redis
    .multi()
    .setex(
      key,
      REFRESH_TTL_SECONDS,
      JSON.stringify({ familyId, issuedAt: Date.now(), userAgent, ipAddress })
    )
    .sadd(fkey, key)
    .expire(fkey, REFRESH_TTL_SECONDS)
    .exec();
  const envelope = `${userId}.${familyId}.${rawId}`;
  return `${envelope}.${hmacToken(envelope)}`;
}

export async function rotateRefreshToken(
  token: string
): Promise<{ token: string; userId: string } | null> {
  const p = parseRefreshToken(token);
  if (!p) return null;
  const key = refreshKey(p.userId, p.rawId);
  // GETDEL atómico: sólo UNA rotación consume el token activo (sella la race).
  const data = await redis.getdel(key);
  if (!data) {
    // Ya consumido/inexistente → posible reuse/robo → revocar TODA la familia.
    await revokeTokenFamily(p.familyId);
    return null;
  }
  await redis.srem(familyKey(p.familyId), key);
  const newToken = await createRefreshToken(p.userId, p.familyId);
  return { token: newToken, userId: p.userId };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const p = parseRefreshToken(token);
  if (!p) return;
  await revokeTokenFamily(p.familyId);
}

async function revokeTokenFamily(familyId: string): Promise<void> {
  const fkey = familyKey(familyId);
  const keys = await redis.smembers(fkey);
  if (keys.length > 0) await redis.del(...keys);
  await redis.del(fkey);
}

export function toLoginResponse(
  user: IUser,
  account: IAccount,
  accessToken: string
): LoginResponse {
  return {
    accessToken,
    expiresIn: jwtAccessTtlSeconds,
    user: {
      id: user._id.toString(),
      primaryEmail: user.primaryEmail,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      preferences: user.preferences,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString(),
    },
    accounts: [
      {
        id: account._id.toString(),
        email: account.email,
        name: account.name,
        isPrimary: account.isPrimary,
        status: account.status,
      },
    ],
  };
}
