/**
 * Modo "LiveKit EXTERNO": apuntar Bifrost a un servidor LiveKit que el operador YA tiene (p.ej. su
 * instancia en Cleverty), en vez de instalar uno en el mismo EC2 (modo bundled). El app-box NO corre
 * media → sin 2º SG, sin DNS meet./turn., sin node_ip, sin piso de RAM: sólo firma tokens contra el
 * LiveKit externo y el navegador conecta directo a su WSS.
 *
 * SEGURIDAD (review B/D): el `apiSecret` externo NUNCA viaja en user-data/CFN en claro (sería
 * recuperable con ec2:DescribeInstanceAttribute y quedaría en la plantilla). Se REUSA el patrón SES:
 * el CLI lo escribe a un SSM SecureString (KMS) y el box lo lee al boot con el rol. El `wsUrl` se valida
 * fuerte (sólo `wss://`, sin userinfo/path/query, sin hosts internos/metadata) para no habilitar un
 * canal inseguro ni un SSRF; la validación se repite en el backend (defensa en profundidad).
 */
import { randomBytes } from 'node:crypto';
import { domainSlug } from '../ses/naming.js';

/** Parámetro SSM SecureString con el `apiSecret` de LiveKit (lo comparten CFN/orquestador/box).
 *  Se usa tanto en modo EXTERNO (el operador lo ingresa) como en modo TWOBOX (el CLI lo genera). */
export function livekitSecretParamName(domain: string): string {
  return `/bifrost/${domainSlug(domain)}/livekit-secret`;
}

/** Genera un par apiKey/apiSecret para LiveKit con el mismo formato que el user-data usa con openssl.
 *  apiKey: "LK" + 24 hex chars; apiSecret: 64 hex chars (32 bytes). */
export function generateLivekitCredentials(): { apiKey: string; apiSecret: string } {
  return {
    apiKey: `LK${randomBytes(12).toString('hex')}`,
    apiSecret: randomBytes(32).toString('hex'),
  };
}

/** Hosts de metadata cloud — un wsUrl apuntando ahí sería SSRF; se rechazan siempre. */
const METADATA_HOSTS = new Set(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal']);

/** Normaliza el host para el chequeo: minúsculas, sin brackets IPv6 y sin punto(s) final(es) de FQDN
 *  (si no, `box.local.` o `metadata.google.internal.` esquivaban las reglas de sufijo — bypass real B/D). */
function normalizeHostForCheck(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
}

/** ¿Una IPv4 (dotted) cae en un rango interno/no-ruteable? */
function isInternalV4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true; // loopback / RFC1918 10/8 / this-host
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a === 169 && b === 254) return true; // link-local (incluye metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/** ¿El host (hostname literal, ya normalizado) cae en un rango interno/no-ruteable? Bloquea loopback,
 *  RFC1918, link-local, CGNAT, IPv6 local Y las IPv4 mapeadas en IPv6 (::ffff:… en forma hex o dotted,
 *  que Node normaliza a hex → bypass real si no se desenvuelven). */
function isInternalHost(hostname: string): boolean {
  const h = normalizeHostForCheck(hostname);
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  )
    return true;
  if (METADATA_HOSTS.has(h)) return true;
  // IPv4 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return isInternalV4(Number(v4[1]), Number(v4[2]));
  // IPv4-mapped-IPv6 dotted (::ffff:127.0.0.1) — por si alguna versión no lo comprime a hex.
  const mappedDot = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(h);
  if (mappedDot) return isInternalV4(Number(mappedDot[1]), Number(mappedDot[2]));
  // IPv4-mapped-IPv6 hex (::ffff:7f00:1 = 127.0.0.1) — la forma a la que Node normaliza.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    return isInternalV4((hi >> 8) & 0xff, hi & 0xff);
  }
  // IPv4-COMPATIBLE-IPv6 (deprecado, SIN ffff): ::127.0.0.1 → Node lo comprime a ::7f00:1. Mismo riesgo de
  // apuntar a un rango interno → se desenvuelve igual que el mapped. [review D3]
  const compatDot = /^::(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(h);
  if (compatDot) return isInternalV4(Number(compatDot[1]), Number(compatDot[2]));
  const compatHex = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (compatHex) {
    const hi = parseInt(compatHex[1], 16);
    return isInternalV4((hi >> 8) & 0xff, hi & 0xff);
  }
  // Checks de IPv6 LITERAL: sólo aplican a literales (contienen ':'). Sin este guard, un FQDN público que
  // empiece con 'fc'/'fd'/'fe8'… (p.ej. feature.example.com, fd-cdn.example.com) caería por error. [B-LOW]
  if (h.includes(':')) {
    // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) — embebe una IPv4 que un traductor NAT64 en la ruta
    // podría llevar a un rango interno. Se rechaza el prefijo entero (un LiveKit real jamás usa tal literal).
    if (h.startsWith('64:ff9b:')) return true;
    // loopback ::1 / ::, link-local fe80::/10, unique-local fc00::/7 (fc/fd)
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'))
      return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
  }
  return false;
}

export type ExternalLivekitValidation =
  | { ok: true; wsUrl: string; apiUrl: string }
  | { ok: false; error: string };

/**
 * Valida la URL WSS de un LiveKit externo y deriva la API URL (Twirp) como `https://host[:port]`.
 * Fail-closed: exige `wss://` (TLS), rechaza `ws://`/http(s)/userinfo/path/query/fragment y hosts
 * internos o de metadata. Devuelve las URLs NORMALIZADAS (sin path/slash sobrante) listas para el .env.
 */
export function validateExternalLivekitWsUrl(raw: string): ExternalLivekitValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'la URL es obligatoria' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, error: `URL malformada: ${trimmed}` };
  }
  if (u.protocol !== 'wss:')
    return {
      ok: false,
      error: `debe ser wss:// (TLS); recibí "${u.protocol}//" — ws:// deja audio/video y el secret sin cifrar`,
    };
  if (u.username || u.password) return { ok: false, error: 'la URL no debe llevar usuario:clave' };
  if (u.search || u.hash)
    return { ok: false, error: 'la URL no debe llevar query (?) ni fragment (#)' };
  if (u.pathname !== '/' && u.pathname !== '')
    return { ok: false, error: `la URL no debe llevar path ("${u.pathname}"); sólo el host` };
  if (!u.hostname) return { ok: false, error: 'la URL no tiene host' };
  if (isInternalHost(u.hostname))
    return { ok: false, error: `host interno/no-ruteable no permitido: ${u.hostname}` };
  // `u.host` conserva el puerto si es explícito. La API Twirp de LiveKit vive en el MISMO host sobre HTTPS.
  // Se quitan los puntos finales de FQDN (antes del `:puerto` o al final) para no arrastrar `host.` al .env.
  const host = u.host.replace(/\.+(?=:|$)/, '');
  return { ok: true, wsUrl: `wss://${host}`, apiUrl: `https://${host}` };
}
