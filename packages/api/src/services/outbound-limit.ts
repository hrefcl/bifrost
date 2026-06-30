import { redis } from '../config/redis.js';

/**
 * Rate-limit de ENVÍO SALIENTE por buzón (anti spam-cannon). Vive en el box, sobre el Redis que ya
 * está en el stack — cero infra extra. Objetivo: que el webmail NO se use de cañón de spam (cuenta
 * comprometida, empleado malicioso, script suelto). Acota cuántos DESTINATARIOS puede mandar una cuenta
 * por ventana (minuto/hora/día). NO protege la reputación AWS del operador (eso es asunto suyo); protege
 * que un abuso puntual no escale a miles de envíos. Ver memoria bifrost-self-hosted-no-babysitting.
 *
 * Cuenta DESTINATARIOS, no mensajes: spam = muchos destinatarios. Atómico vía Lua (check-and-incr en una
 * sola llamada) → sin race entre envíos concurrentes. FAIL-OPEN: si Redis falla, se permite el envío
 * (no romper el correo legítimo por un blip de Redis); el cap es un guardrail, no una frontera dura.
 */

export interface OutboundLimits {
  /** Máx destinatarios por minuto (corta ráfagas). */
  perMinute: number;
  /** Máx destinatarios por hora. */
  perHour: number;
  /** Máx destinatarios por día (cap duro anti-blast). */
  perDay: number;
}

function envNum(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Defaults generosos para uso legítimo de negocio, pero que acotan un abuso. Override por env. */
export function outboundLimits(): OutboundLimits {
  return {
    // INVARIANTE: perMinute >= maxRecipientsPerMessage, si no un mensaje del tamaño máximo NUNCA pasa la
    // ventana de minuto (429 eterno, esperar Retry-After no ayuda). [B2-LOW] El cap diario (1000) es el
    // bound real anti-abuso; perMinute sólo suaviza ráfagas, así que subirlo a 100 no afloja la defensa.
    perMinute: envNum('OUTBOUND_MAX_RCPT_PER_MIN', 100),
    perHour: envNum('OUTBOUND_MAX_RCPT_PER_HOUR', 300),
    perDay: envNum('OUTBOUND_MAX_RCPT_PER_DAY', 1000),
  };
}

/**
 * Tope de destinatarios en UN SOLO mensaje. Complementa el rate-limit por ventana: sin esto, un único
 * draft con miles de destinatarios pasa el schema (que sólo valida adjuntos) y agota/amplifica el abuso
 * en un envío. [D-MED] Default 100 (== perMinute para que un anuncio a toda la PYME pase); override por
 * env. Mantené `OUTBOUND_MAX_RCPT_PER_MESSAGE <= OUTBOUND_MAX_RCPT_PER_MIN`. 0/negativo en env → default.
 */
export function maxRecipientsPerMessage(): number {
  return envNum('OUTBOUND_MAX_RCPT_PER_MESSAGE', 100);
}

export interface LimitDecision {
  allowed: boolean;
  /** Ventana que se excedió (sólo si !allowed). */
  scope?: 'minute' | 'hour' | 'day';
  /** Segundos hasta que la ventana excedida se libera (para el header Retry-After). */
  retryAfterSec?: number;
  /** El límite de esa ventana (para el mensaje). */
  limit?: number;
  /** true si se permitió por FAIL-OPEN (Redis caído) — el control está degradado; el caller lo loguea. */
  degraded?: boolean;
  /** El mensaje del error que causó el fail-open (para la causa raíz en el log). [B2-MED] */
  degradedReason?: string;
}

// Check-and-increment ATÓMICO de las 3 ventanas. Si ALGUNA se excedería, NO incrementa ninguna y
// devuelve el rechazo (así un rechazo en 'day' no consume la cuota de 'minute'). El EXPIRE se setea
// sólo en el primer incremento de cada ventana (v == recipients) → ventana anclada al primer envío.
const LUA = `
local r = tonumber(ARGV[1])
local wins = {
  { KEYS[1], tonumber(ARGV[2]), tonumber(ARGV[3]), 'minute' },
  { KEYS[2], tonumber(ARGV[4]), tonumber(ARGV[5]), 'hour' },
  { KEYS[3], tonumber(ARGV[6]), tonumber(ARGV[7]), 'day' },
}
for _, w in ipairs(wins) do
  local cur = tonumber(redis.call('GET', w[1]) or '0')
  if cur + r > w[2] then
    local ttl = redis.call('TTL', w[1])
    -- Si la key quedó SIN TTL (failover/replicación) y ya está sobre el límite, el path de rechazo
    -- también debe REPARARLA: si no, ese buzón queda bloqueado para siempre (el path permitido nunca
    -- corre porque siempre rechaza). [B2-LOW/MED] Reparar acá garantiza recuperación.
    if ttl < 0 then redis.call('EXPIRE', w[1], w[3]); ttl = w[3] end
    return { 0, w[4], ttl, w[2] }
  end
end
for _, w in ipairs(wins) do
  redis.call('INCRBY', w[1], r)
  -- EXPIRE defensivo: setea el TTL en el primer incremento Y re-arma si alguna vez quedó sin TTL
  -- (failover/replicación) → evita que una clave eterna bloquee el buzón para siempre. [D-LOW/MED]
  if redis.call('TTL', w[1]) < 0 then redis.call('EXPIRE', w[1], w[3]) end
end
return { 1, '', 0, 0 }
`;

/**
 * Chequea (y reserva) cuota para enviar a `recipients` destinatarios desde `accountKey`. Devuelve si se
 * permite; si no, qué ventana y en cuánto se libera. FAIL-OPEN ante error de Redis.
 */
export async function checkOutboundLimit(
  accountKey: string,
  recipients: number,
  limits: OutboundLimits = outboundLimits()
): Promise<LimitDecision> {
  if (recipients <= 0) return { allowed: true };
  // Hash tag `{...}` alrededor del accountKey → las 3 claves caen en el MISMO slot de Redis Cluster, así
  // el EVAL multi-key no falla si algún día se migra a Cluster. En instancia única es inocuo. [D-MED]
  const base = `obl:{${accountKey}}`;
  try {
    const res = (await redis.eval(
      LUA,
      3,
      `${base}:min`,
      `${base}:hour`,
      `${base}:day`,
      String(recipients),
      String(limits.perMinute),
      '60',
      String(limits.perHour),
      '3600',
      String(limits.perDay),
      '86400'
    )) as [number, string, number, number];

    if (res[0] === 1) return { allowed: true };
    return {
      allowed: false,
      scope: res[1] as 'minute' | 'hour' | 'day',
      retryAfterSec: Math.max(1, res[2]),
      limit: res[3],
    };
  } catch (err) {
    // FAIL-OPEN: no bloquear correo legítimo si Redis está caído. El guardrail se reactiva al volver.
    // Se marca `degraded` + la causa para que el caller LO LOGUEE con root-cause (incidente 3AM). [B2-MED]
    return {
      allowed: true,
      degraded: true,
      degradedReason: err instanceof Error ? err.message : String(err),
    };
  }
}
