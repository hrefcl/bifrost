import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  loginOrRegister,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  toLoginResponse,
} from '../services/auth.js';
import { User } from '../models/User.js';
import { Account } from '../models/Account.js';
import { env, jwtAccessTtlSeconds } from '../config/env.js';
import { randomToken } from '../config/crypto.js';
import type { LoginRequest, LoginResponse, RefreshResponse } from '@webmail6/shared';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  displayName: z.string().optional(),
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
});

// `.default({})`: el cliente web refresca SÓLO con la cookie httpOnly (sin body) →
// request.body llega `undefined` en runtime (aunque el tipo Body de Fastify diga lo
// contrario). Sin el default, z.object().parse(undefined) tiraría 400 y rompería
// restore() en cada reload (sesión válida → /login). `refreshToken` sigue opcional.
const refreshBodySchema = z
  .object({
    // Normaliza "" → undefined: un refreshToken vacío del body debe caer a la cookie
    // (no quedarse en string vacío e ignorar una cookie válida → 401).
    refreshToken: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
  })
  .strict()
  .default({});

function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: 7 * 24 * 60 * 60,
  };
}

export default function authRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: LoginRequest; Reply: LoginResponse }>(
    '/login',
    // Rate limit estricto: login verifica credenciales IMAP reales (anti fuerza bruta).
    { config: { requiresAuth: false, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const { user, account } = await loginOrRegister(body);
      const accessToken = fastify.jwt.sign({ userId: user._id.toString() });
      const familyId = randomToken(16);
      const refreshToken = await createRefreshToken(
        user._id.toString(),
        familyId,
        request.headers['user-agent'],
        request.ip
      );

      void reply.setCookie('refresh_token', refreshToken, cookieOptions());
      return toLoginResponse(user, account, accessToken);
    }
  );

  // Logout no requiere access token válido: alcanza con la cookie de refresh (un
  // access token vencido no debe impedir cerrar sesión).
  fastify.post('/logout', { config: { requiresAuth: false } }, async (request, reply) => {
    const refreshToken = request.cookies.refresh_token;
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    void reply.clearCookie('refresh_token', { path: '/' });
    return { ok: true };
  });

  fastify.post<{ Body: { refreshToken?: string }; Reply: RefreshResponse }>(
    '/refresh',
    { config: { requiresAuth: false, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = refreshBodySchema.parse(request.body);
      const refreshToken = parsed.refreshToken ?? request.cookies.refresh_token;
      if (!refreshToken) {
        return reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Missing refresh token',
        } as unknown as RefreshResponse);
      }

      const rotated = await rotateRefreshToken(refreshToken);
      if (!rotated) {
        return reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid refresh token',
        } as unknown as RefreshResponse);
      }

      const accessToken = fastify.jwt.sign({ userId: rotated.userId });
      void reply.setCookie('refresh_token', rotated.token, cookieOptions());
      return { accessToken, expiresIn: jwtAccessTtlSeconds };
    }
  );

  fastify.get('/me', async (request) => {
    const user = await User.findById(request.user.userId).lean();
    if (!user) {
      throw new Error('User not found');
    }
    const accounts = await Account.find({ userId: user._id })
      .select('email name isPrimary status')
      .lean();

    return {
      id: user._id.toString(),
      primaryEmail: user.primaryEmail,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      preferences: user.preferences,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString(),
      accounts: accounts.map((a) => ({
        id: a._id.toString(),
        email: a.email,
        name: a.name,
        isPrimary: a.isPrimary,
        status: a.status,
      })),
    };
  });
}
