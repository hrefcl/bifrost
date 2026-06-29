import type { FastifyInstance } from 'fastify';

/**
 * Config PÚBLICA del cliente (sin auth): la lee el login en el boot. Expone si el box trae un
 * mailserver BASE (turnkey). Cuando `mailServer` no es null, el webmail defaultea a ese servidor y
 * oculta "Configuración del servidor" (modo NATIVO del dominio); si es null, la instalación es
 * genérica y el usuario configura su propio IMAP/SMTP (modo reemplazo de Roundcube).
 */
export default function configRoutes(fastify: FastifyInstance) {
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
