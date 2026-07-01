import { describe, it, expect } from 'vitest';
import {
  generateLivekitCredentials,
  livekitSecretParamName,
  validateExternalLivekitWsUrl,
} from '../meet/livekit-external.js';

describe('livekitSecretParamName', () => {
  it('deriva un nombre SSM determinístico y DNS-safe del dominio', () => {
    expect(livekitSecretParamName('acme.com')).toBe('/bifrost/acme-com/livekit-secret');
    expect(livekitSecretParamName('Sub.Empresa.CL')).toBe('/bifrost/sub-empresa-cl/livekit-secret');
  });
});

describe('generateLivekitCredentials', () => {
  it('genera apiKey con prefijo LK + 24 hex y apiSecret de 64 hex', () => {
    const creds = generateLivekitCredentials();
    expect(creds.apiKey).toMatch(/^LK[0-9a-f]{24}$/i);
    expect(creds.apiSecret).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('genera credenciales distintas en cada llamada', () => {
    const a = generateLivekitCredentials();
    const b = generateLivekitCredentials();
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(a.apiSecret).not.toBe(b.apiSecret);
  });
});

describe('validateExternalLivekitWsUrl', () => {
  it('acepta un wss:// válido y deriva la API URL https en el mismo host', () => {
    const r = validateExternalLivekitWsUrl('wss://livekit.cleverty.com');
    expect(r).toEqual({
      ok: true,
      wsUrl: 'wss://livekit.cleverty.com',
      apiUrl: 'https://livekit.cleverty.com',
    });
  });

  it('conserva un puerto explícito en ambas URLs', () => {
    const r = validateExternalLivekitWsUrl('wss://meet.example.org:8443');
    expect(r).toEqual({
      ok: true,
      wsUrl: 'wss://meet.example.org:8443',
      apiUrl: 'https://meet.example.org:8443',
    });
  });

  it('normaliza quitando el path/slash sobrante', () => {
    const r = validateExternalLivekitWsUrl('wss://lk.example.com/');
    expect(r.ok && r.wsUrl).toBe('wss://lk.example.com');
  });

  it('recorta espacios', () => {
    expect(validateExternalLivekitWsUrl('  wss://lk.example.com  ').ok).toBe(true);
  });

  // --- fail-closed: protocolo ---
  it('rechaza ws:// (sin TLS) — dejaría media y secret sin cifrar', () => {
    const r = validateExternalLivekitWsUrl('ws://lk.example.com');
    expect(r.ok).toBe(false);
  });

  it('rechaza http:// y https://', () => {
    expect(validateExternalLivekitWsUrl('http://lk.example.com').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('https://lk.example.com').ok).toBe(false);
  });

  // --- fail-closed: forma ---
  it('rechaza vacío', () => {
    expect(validateExternalLivekitWsUrl('').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('   ').ok).toBe(false);
  });

  it('rechaza URL malformada', () => {
    expect(validateExternalLivekitWsUrl('no-es-una-url').ok).toBe(false);
  });

  it('rechaza userinfo (usuario:clave@)', () => {
    expect(validateExternalLivekitWsUrl('wss://user:pass@lk.example.com').ok).toBe(false);
  });

  it('rechaza query y fragment', () => {
    expect(validateExternalLivekitWsUrl('wss://lk.example.com?a=1').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://lk.example.com#x').ok).toBe(false);
  });

  it('rechaza path no vacío', () => {
    expect(validateExternalLivekitWsUrl('wss://lk.example.com/rtc').ok).toBe(false);
  });

  // --- fail-closed: SSRF / hosts internos ---
  it('rechaza la IP de metadata de la nube', () => {
    expect(validateExternalLivekitWsUrl('wss://169.254.169.254').ok).toBe(false);
  });

  it('rechaza loopback y localhost', () => {
    expect(validateExternalLivekitWsUrl('wss://127.0.0.1').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://localhost').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://[::1]').ok).toBe(false);
  });

  it('rechaza rangos privados RFC1918', () => {
    expect(validateExternalLivekitWsUrl('wss://10.0.0.5').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://172.16.0.9').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://172.31.255.1').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://192.168.1.1').ok).toBe(false);
  });

  it('acepta una IP pública 172.x que NO cae en 172.16/12', () => {
    expect(validateExternalLivekitWsUrl('wss://172.15.0.1').ok).toBe(true);
    expect(validateExternalLivekitWsUrl('wss://172.32.0.1').ok).toBe(true);
  });

  it('rechaza link-local, CGNAT y unique-local IPv6', () => {
    expect(validateExternalLivekitWsUrl('wss://169.254.1.1').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://100.64.0.1').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://[fd00::1]').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://[fe80::1]').ok).toBe(false);
  });

  it('rechaza hostnames internos (.local/.internal/localhost)', () => {
    expect(validateExternalLivekitWsUrl('wss://box.local').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://metadata.google.internal').ok).toBe(false);
  });

  // --- bypasses cerrados (review B/D de implementación) ---
  it('rechaza trailing-dot que esquivaba las reglas de sufijo (box.local. / …internal.)', () => {
    expect(validateExternalLivekitWsUrl('wss://box.local.').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://metadata.google.internal.').ok).toBe(false);
  });

  it('rechaza IPv4 interna MAPEADA en IPv6 (::ffff:… hex o dotted, como la normaliza Node)', () => {
    expect(validateExternalLivekitWsUrl('wss://[::ffff:127.0.0.1]').ok).toBe(false); // → ::ffff:7f00:1
    expect(validateExternalLivekitWsUrl('wss://[::ffff:169.254.169.254]').ok).toBe(false); // metadata
    expect(validateExternalLivekitWsUrl('wss://[::ffff:10.0.0.1]').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://[::ffff:192.168.0.1]').ok).toBe(false);
  });

  it('rechaza IPv4-COMPATIBLE-IPv6 interna (::127.0.0.1 → ::7f00:1, sin ffff) [review D3]', () => {
    expect(validateExternalLivekitWsUrl('wss://[::7f00:1]').ok).toBe(false); // 127.0.0.1
    expect(validateExternalLivekitWsUrl('wss://[::127.0.0.1]').ok).toBe(false);
    expect(validateExternalLivekitWsUrl('wss://[::a9fe:a9fe]').ok).toBe(false); // 169.254.169.254
    expect(validateExternalLivekitWsUrl('wss://[::0a00:1]').ok).toBe(false); // 10.0.0.1
  });

  it('rechaza el prefijo NAT64 well-known (64:ff9b::/96), aun con IPv4 pública embebida', () => {
    expect(validateExternalLivekitWsUrl('wss://[64:ff9b::7f00:1]').ok).toBe(false); // 127.0.0.1 vía NAT64
    expect(validateExternalLivekitWsUrl('wss://[64:ff9b::102:304]').ok).toBe(false);
  });

  it('acepta IPv6 global unicast legítima (LiveKit Cloud podría publicar AAAA)', () => {
    expect(validateExternalLivekitWsUrl('wss://[2001:4860:4860::8888]').ok).toBe(true);
  });

  it('NO rechaza FQDN públicos que casualmente empiecen como una IPv6 interna (fc/fd/fe8…) [B-LOW]', () => {
    for (const host of [
      'feature.example.com',
      'fd-cdn.example.com',
      'fcbarcelona.com',
      'fe80-host.example.com',
    ]) {
      expect(validateExternalLivekitWsUrl(`wss://${host}`).ok, host).toBe(true);
    }
  });

  it('un host público con punto final de FQDN se acepta y se normaliza sin el punto', () => {
    const r = validateExternalLivekitWsUrl('wss://livekit.cleverty.com.');
    expect(r).toEqual({
      ok: true,
      wsUrl: 'wss://livekit.cleverty.com',
      apiUrl: 'https://livekit.cleverty.com',
    });
  });
});
