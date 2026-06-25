import { env } from './env.js';

/**
 * Config de logger compartida por buildApp y buildSetupApp. En 'test' se silencia;
 * en cualquier otro entorno (incl. production) loguea estructurado y REDACTA headers
 * sensibles (auth/cookies/api-keys) para no filtrar credenciales — crítico en el app
 * de setup, que maneja passwords de admin/IMAP/SMTP.
 */
export const loggerOptions =
  env.NODE_ENV === 'test'
    ? false
    : {
        level: env.LOG_LEVEL,
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.headers["proxy-authorization"]',
            'res.headers["set-cookie"]',
          ],
          remove: true,
        },
      };
