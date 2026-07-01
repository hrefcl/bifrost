import type { FastifyInstance } from 'fastify';
import { getStoredMeetSettings } from '../services/meet/settings.js';
import { meetEnabled } from '../services/meet/token-service.js';

/**
 * Config PÚBLICA del cliente (sin auth): la lee el login en el boot. Expone si el box trae un
 * mailserver BASE (turnkey). Cuando `mailServer` no es null, el webmail defaultea a ese servidor y
 * oculta "Configuración del servidor" (modo NATIVO del dominio); si es null, la instalación es
 * genérica y el usuario configura su propio IMAP/SMTP (modo reemplazo de Roundcube).
 */
export default function configRoutes(fastify: FastifyInstance) {
  // Config pública de la SPA (imagen estática genérica → runtime, no `import.meta.env`; review D-M4).
  // Expone si Meet está activo y a qué wsUrl/base conectarse. Sin secretos.
  fastify.get('/public', { config: { requiresAuth: false } }, async () => {
    const settings = await getStoredMeetSettings();
    const on = meetEnabled(settings);
    return {
      meetEnabled: on,
      livekitWsUrl: on ? settings.wsUrl : '',
      meetPublicBaseUrl: on ? settings.publicBaseUrl : '',
    };
  });

  fastify.get('/mail-server', { config: { requiresAuth: false } }, () => {
    // Se lee de process.env en el request (no del `env` congelado al boot) para que sea testeable y
    // re-configurable sin reiniciar. El schema en config/env.ts lo documenta/valida.
    const host = (process.env.MAIL_SERVER_HOST ?? '').trim();
    if (!host) return { mailServer: null };
    // Mailserver propio (docker-mailserver): IMAPS 993 + SMTPS 465, ambos TLS directo con su cert.
    return {
      mailServer: {
        imapHost: host,
        imapPort: 993,
        imapSecure: true,
        smtpHost: host,
        smtpPort: 465,
        smtpSecure: true,
      },
    };
  });
}
