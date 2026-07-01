import { describe, it, expect } from 'vitest';
import { buildLivekitUserData, LIVEKIT_EIP_MARKER } from '../meet/livekit-media-user-data.js';

describe('buildLivekitUserData (cloud-init media-box)', () => {
  const base = {
    domain: 'acme.com',
    apiKey: 'APIabc123',
    secretParamName: '/bifrost/acme-com/livekit-secret',
    stackName: 'bifrost-acme-com',
    region: 'us-east-1',
  };

  it('instala Docker, Caddy y awscli; lee el secret de SSM con retry', () => {
    const s = buildLivekitUserData(base);
    expect(s).toContain('apt_retry install -y docker-ce');
    expect(s).toContain('caddy:2-alpine');
    expect(s).toContain('apt_retry install -y awscli');
    expect(s).toContain('/bifrost/acme-com/livekit-secret');
    expect(s).toMatch(/aws ssm get-parameter .*--with-decryption/);
    expect(s).toMatch(/for _ in \$\(seq 1 12\)/);
  });

  it('escribe livekit.yaml con node_ip marcador y Caddyfile para meet.<dom>', () => {
    const s = buildLivekitUserData(base);
    expect(s).toContain(LIVEKIT_EIP_MARKER);
    expect(s).toContain('node_ip:');
    expect(s).toContain('meet.__DOMAIN__'); // se reemplaza por sed en runtime
    expect(s).toContain('reverse_proxy livekit:7880');
    expect(s).toContain('livekit/livekit-server:v1.13.2');
  });

  it('configura LiveKit por .env con LIVEKIT_KEYS ("clave: secreto"), NO vars separadas [fix HIGH]', () => {
    const s = buildLivekitUserData(base);
    expect(s).toContain('API_KEY="APIabc123"');
    // livekit-server lee LIVEKIT_KEYS; las vars separadas NO las lee (arrancaría sin keys → nada valida).
    expect(s).toContain('printf \'LIVEKIT_KEYS=%s: %s\\n\' "$API_KEY" "$LK_SECRET"');
    expect(s).not.toContain('LIVEKIT_API_KEY=$API_KEY');
    expect(s).toContain('chmod 600 /opt/livekit/.env');
  });

  it('publica los puertos media; 7880 SÓLO por loopback (no público) [B-HIGH]', () => {
    const s = buildLivekitUserData(base);
    expect(s).toContain("'7881:7881/tcp'");
    expect(s).toContain("'7882:7882/udp'");
    expect(s).toContain("'3478:3478/udp'");
    expect(s).toContain("'30000-40000:30000-40000/udp'");
    // 7880 se bindea a 127.0.0.1 (para el healthcheck local), NUNCA público.
    expect(s).toContain("'127.0.0.1:7880:7880'");
    expect(s).not.toContain("'7880:7880'"); // sin binding público bare
    expect(s).not.toContain('0.0.0.0:7880');
  });

  it('readiness contra LIVEKIT DIRECTO (7880 loopback, http), NO Caddy/HTTPS público [B-HIGH]', () => {
    const s = buildLivekitUserData(base);
    // No debe gatear el cfn-signal en el HTTPS público (ACME depende del EIPAssociation post-signal → deadlock).
    expect(s).toContain('http://127.0.0.1:7880/');
    expect(s).not.toContain('https://127.0.0.1/');
    expect(s).toContain('cfn-signal -e 0 --stack "$STACK" --resource LivekitInstance');
  });

  it('NO excede el límite de 16384 bytes de EC2', () => {
    const s = buildLivekitUserData(base);
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThan(16384);
  });
});
