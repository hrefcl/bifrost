import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: string };
  }
}

declare module 'fastify' {
  interface FastifyContextConfig {
    requiresAuth?: boolean;
  }
}

export default fp(async function authPlugin(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
) {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    cookie: { cookieName: 'refresh_token', signed: false },
    sign: { expiresIn: env.JWT_ACCESS_TTL },
  });

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const config = request.routeOptions.config as { requiresAuth?: boolean } | undefined;
    const requiresAuth = config?.requiresAuth ?? true;
    if (!requiresAuth) {
      return;
    }

    try {
      await request.jwtVerify();
    } catch {
      void reply
        .code(401)
        .send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or missing token' });
      return;
    }

    // Defensa en profundidad: un token válido pero sin userId no debe pasar.
    // (find({ userId: undefined }) en Mongoose ignoraría el filtro y matchearía todo.)
    // El tipo declara user.userId como string siempre, pero en runtime el payload
    // del JWT es arbitrario; se castea a laxo para validarlo de verdad.
    const payload = request.user as { userId?: unknown };
    if (typeof payload.userId !== 'string' || payload.userId.length === 0) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid token payload' });
      return;
    }
  });
});
