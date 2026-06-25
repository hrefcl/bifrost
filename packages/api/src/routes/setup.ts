import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSetupMode, getMissingCriticalVars } from '../config/env.js';
import { validateMongoDb, validateRedis } from '../setup/validators.js';
import { performSetup, generateSecrets } from '../setup/setup-service.js';

const validateDbSchema = z.object({
  mongodbUri: z.string().min(1),
  redisUrl: z.string().min(1),
});

const setupSchema = z.object({
  db: validateDbSchema,
  admin: z.object({
    email: z.string().email(),
    password: z.string().min(8),
    displayName: z.string().min(1),
  }),
  email: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(1),
    imapHost: z.string().min(1),
    imapPort: z.number().int().min(1).max(65535),
    imapSecure: z.boolean(),
    smtpHost: z.string().min(1),
    smtpPort: z.number().int().min(1).max(65535),
    smtpSecure: z.boolean(),
  }),
  app: z
    .object({
      frontendUrl: z.string().url().optional(),
      corsOrigin: z.string().optional(),
    })
    .optional(),
});

export default function setupRoutes(fastify: FastifyInstance) {
  const publicConfig = { config: { requiresAuth: false } };

  fastify.get('/status', publicConfig, () => {
    return {
      setupRequired: isSetupMode(),
      missing: getMissingCriticalVars(),
    };
  });

  fastify.post('/validate-db', publicConfig, async (request, reply) => {
    if (!isSetupMode()) {
      return reply
        .code(403)
        .send({ statusCode: 403, error: 'Forbidden', message: 'Setup already completed' });
    }
    const body = validateDbSchema.parse(request.body);
    const mongo = await validateMongoDb(body.mongodbUri);
    const redis = await validateRedis(body.redisUrl);
    return { mongo, redis };
  });

  fastify.get('/secrets', publicConfig, (_request, reply) => {
    if (!isSetupMode()) {
      return reply
        .code(403)
        .send({ statusCode: 403, error: 'Forbidden', message: 'Setup already completed' });
    }
    return generateSecrets();
  });

  fastify.post('/', publicConfig, async (request, reply) => {
    if (!isSetupMode()) {
      return reply
        .code(403)
        .send({ statusCode: 403, error: 'Forbidden', message: 'Setup already completed' });
    }
    const body = setupSchema.parse(request.body);
    const result = await performSetup(body);
    if (!result.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: result.error });
    }
    return result;
  });
}
