import { describe, it, expect } from 'vitest';
import { buildUserData, MEET_EIP_MARKER } from '../mailserver/user-data.js';

describe('buildUserData (cloud-init)', () => {
  const base = {
    domain: 'acme.com',
    mailHostname: 'mail.acme.com',
    adminEmail: 'admin@acme.com',
    stackName: 'bifrost-acme-com',
    region: 'us-east-1',
  };

  it('sin s3Bucket → storage LOCAL (sin claves ni S3 en el .env)', () => {
    const s = buildUserData(base);
    expect(s).toContain('STORAGE_PROVIDER=local');
    expect(s).not.toContain('STORAGE_PROVIDER=s3');
    expect(s).not.toContain('S3_BUCKET');
  });

  it('con s3Bucket → storage S3 con el ROL del EC2 (IMDS), SIN claves estáticas en el .env', () => {
    const s = buildUserData({ ...base, s3Bucket: 'bifrost-acme-com-data' });
    expect(s).toContain('STORAGE_PROVIDER=s3');
    expect(s).toContain('S3_BUCKET=bifrost-acme-com-data');
    expect(s).toContain('S3_REGION=us-east-1');
    expect(s).toContain('S3_USE_INSTANCE_ROLE=1');
    // Cero claves estáticas (el rol del EC2 las provee temporales vía IMDS).
    expect(s).not.toContain('S3_ACCESS_KEY_ID');
    expect(s).not.toContain('S3_SECRET');
  });

  it('sin enableMeet → NADA de Meet (base byte-idéntica: ni profile, ni flag, ni claves LiveKit)', () => {
    const s = buildUserData(base);
    expect(s).not.toContain('COMPOSE_PROFILES=meet');
    expect(s).not.toContain('MEET_PROVISIONED');
    expect(s).not.toContain('LIVEKIT_API_SECRET');
    expect(s).not.toContain(MEET_EIP_MARKER);
    expect(s).not.toContain('node_ip');
  });

  it('con enableMeet → profile + flag de provisión + claves LiveKit en el .env + node_ip por EIP', () => {
    const s = buildUserData({ ...base, enableMeet: true });
    // .env: profile (arranca livekit) + flag (afloja CSP / config runtime).
    expect(s).toContain('COMPOSE_PROFILES=meet');
    expect(s).toContain('MEET_PROVISIONED=1');
    // Origen único wsUrl + base pública + API interna.
    expect(s).toContain('LIVEKIT_WS_URL=wss://meet.${DOMAIN}');
    expect(s).toContain('LIVEKIT_API_URL=http://livekit:7880');
    expect(s).toContain('MEET_PUBLIC_BASE_URL=https://webmail.${DOMAIN}');
    // Claves generadas EN EL HOST (openssl), no embebidas en el user-data.
    expect(s).toContain('LIVEKIT_API_KEY=');
    expect(s).toContain('LIVEKIT_API_SECRET=');
    expect(s).toMatch(/openssl rand -hex 32/); // secret
    // node_ip determinista: sustituye el marcador (que CFN reemplaza por la EIP) + apaga STUN.
    expect(s).toContain(MEET_EIP_MARKER);
    expect(s).toContain('use_external_ip: false');
    expect(s).toContain('node_ip:');
    expect(s).toContain('livekit.yaml');
  });

  it('con meetExternal → LIVEKIT_* externo + lee el secret de SSM, SIN profile/container/openssl local', () => {
    const s = buildUserData({
      ...base,
      meetExternal: {
        wsUrl: 'wss://livekit.cleverty.com',
        apiUrl: 'https://livekit.cleverty.com',
        apiKey: 'APIabc123',
        secretParamName: '/bifrost/acme-com/livekit-secret',
      },
    });
    // Provisionado (afloja CSP a wss:) apuntando al WSS externo + API Twirp derivada.
    expect(s).toContain('MEET_PROVISIONED=1');
    expect(s).toContain('LIVEKIT_WS_URL=wss://livekit.cleverty.com');
    expect(s).toContain('LIVEKIT_API_URL=https://livekit.cleverty.com');
    expect(s).toContain('LIVEKIT_API_KEY=APIabc123');
    // El secret se LEE de SSM con el rol (nunca literal en el user-data) y NO se traza (set +x).
    expect(s).toContain('/bifrost/acme-com/livekit-secret');
    expect(s).toMatch(/aws ssm get-parameter .*--with-decryption/);
    // El secret se escribe con printf (no echo) para no interpretar/comromper comillas/backticks/$().
    expect(s).toContain('printf \'LIVEKIT_API_SECRET=%s\\n\' "$LK_SECRET"');
    expect(s).toContain('set +x');
    // Retry por propagación IAM antes de fallar (la policy del secret es un recurso aparte).
    expect(s).toMatch(/for _ in \$\(seq 1 12\)/);
    // Fail-closed si el secret está vacío/ausente.
    expect(s).toMatch(/Fail-closed/i);
    // El .env con secretos se asegura a 600.
    expect(s).toContain('chmod 600 .env');
    // NO monta media local: sin profile meet, sin generar la clave LiveKit con openssl (eso es bundled),
    // sin marcador de EIP.
    expect(s).not.toContain('COMPOSE_PROFILES=meet');
    expect(s).not.toContain('LIVEKIT_API_SECRET="$(openssl');
    expect(s).not.toContain(MEET_EIP_MARKER);
  });

  it('meetExternal y enableMeet son excluyentes: enableMeet tiene precedencia (bundled)', () => {
    // Defensa: si por error llegaran ambos, se toma el bundled (no se mezclan las dos ramas).
    const s = buildUserData({
      ...base,
      enableMeet: true,
      meetExternal: {
        wsUrl: 'wss://x.example.com',
        apiUrl: 'https://x.example.com',
        apiKey: 'k',
        secretParamName: '/bifrost/acme-com/livekit-secret',
      },
    });
    expect(s).toContain('COMPOSE_PROFILES=meet');
    expect(s).not.toContain('LIVEKIT_WS_URL=wss://x.example.com');
  });

  it('con adminMailbox → crea el buzón admin en docker-mailserver (login turnkey)', () => {
    const s = buildUserData({
      ...base,
      adminMailbox: 'admin@acme.com',
      adminMailboxPassword: 'super-clave-8+',
    });
    expect(s).toContain('setup email add');
    expect(s).toContain('admin@acme.com');
    expect(s).toContain('mailserver setup email list'); // espera a que el mailserver esté listo
  });

  it('sin adminMailbox → no toca docker-mailserver', () => {
    expect(buildUserData(base)).not.toContain('setup email add');
  });

  it('sin sesParamName → NO instala el relay SES (sin helper, sin cron, sin awscli)', () => {
    const s = buildUserData(base);
    expect(s).not.toContain('bifrost-ses-activate');
    expect(s).not.toContain('/etc/cron.d/bifrost-ses');
    expect(s).not.toContain('install -y awscli');
  });

  it('instala el host-updater de la Fase 2 (cron + systemd .path + dir del marker + BIFROST_DOMAIN)', () => {
    const s = buildUserData(base);
    expect(s).toContain('/etc/cron.d/bifrost-update');
    expect(s).toContain('./bifrost-update.sh'); // el script vive en el repo; el cron lo corre
    expect(s).toContain('install -d -m 0750 update-trigger'); // dir del marker
    expect(s).toContain('BIFROST_DOMAIN=');
    // Disparo INMEDIATO: systemd .path observa el marker → el botón no espera al tick del cron.
    expect(s).toContain('/etc/systemd/system/bifrost-update.path');
    expect(s).toContain('/etc/systemd/system/bifrost-update.service');
    expect(s).toContain(
      'PathExists=/opt/bifrost/deploy/example-mailserver/update-trigger/requested'
    );
    expect(s).toContain('systemctl enable --now bifrost-update.path');
  });

  it('whitelistea la red Docker en fail2ban (el API es proxy IMAP; sin esto un user banea a TODO el tenant)', () => {
    const s = buildUserData(base);
    // El archivo que docker-mailserver copia a jail.d/user-jail.local (gana a jail.local por orden de lectura).
    expect(s).toContain('config/fail2ban-jail.cf');
    expect(s).toContain('ignoreip = 127.0.0.1/8 ::1 172.16.0.0/12 192.168.0.0/16');
    // Se escribe SIEMPRE (no depende de SES): el lockout del tenant aplica a cualquier deploy.
    const withoutSes = buildUserData(base);
    expect(withoutSes).toContain('config/fail2ban-jail.cf');
  });

  it('con sesParamName → helper que lee SSM + cron + boot-run, con SEND-GATING (relay off al boot)', () => {
    const s = buildUserData({ ...base, sesParamName: '/bifrost/acme-com/ses-smtp' });
    // awscli para leer el SecureString con el rol del box.
    expect(s).toContain('install -y awscli');
    // El helper lee la credencial de SSM con --with-decryption.
    expect(s).toContain('/usr/local/bin/bifrost-ses-activate');
    expect(s).toContain('aws ssm get-parameter --name "$SES_PARAM" --with-decryption');
    expect(s).toContain('/bifrost/acme-com/ses-smtp');
    // PERSISTENCIA ROBUSTA: el relay se escribe en config/user-patches.sh (docker-mailserver lo re-corre
    // en CADA arranque) → sobrevive restart/reboot. NO depende de que 'compose up' recree por env_file
    // (frágil). Esto evita replicar el incidente del relay perdido a un nuevo usuario de la CLI.
    expect(s).toContain('config/user-patches.sh');
    expect(s).toContain("postconf -e 'relayhost = [$RELAY]:587'");
    // Aplica YA en el contenedor corriendo (sin esperar restart) y flushea la cola atascada.
    expect(s).toContain('user-patches.sh || true');
    expect(s).toContain('postqueue -f');
    // HEALTH PROBE: AUTH a SES:587 (sin mandar correo) en cada tick del cron → un corte deja de ser
    // SILENCIOSO. Loguea ALERTA con causa. Más alerta de cola atascada. (Cierra TD-OUTBOUND-MONITOR.)
    expect(s).toContain('smtplib');
    expect(s).toContain('.starttls()');
    expect(s).toContain('ALERTA');
    expect(s).toContain('/var/log/bifrost-ses.log');
    // La clave del relay NO va por argv (no aparece en 'ps') — se pasa por ENV al python.
    expect(s).toContain('RPWD="$RPASS" python3');
    expect(s).not.toContain('sys.argv');
    // SEND-GATING: graceful si la credencial no está (relay sigue apagado), no rompe el boot.
    expect(s).toContain('relay apagado');
    // Timer pull-based (auto-activa + sobrevive reboot) y corrida al boot.
    expect(s).toContain('/etc/cron.d/bifrost-ses');
    expect(s).toContain('/usr/local/bin/bifrost-ses-activate || true');
    // El SecretAccessKey de AWS jamás aparece; sólo se maneja el password ya derivado vía SSM.
    expect(s).not.toContain('SecretAccessKey');
  });

  it('instala deps + docker (repo APT firmado, NO curl|sh), clona el stack y levanta compose', () => {
    const s = buildUserData(base);
    // Espera a internet ANTES de bajar paquetes (race de la ruta de una VPC nueva).
    expect(s).toContain('aws.amazon.com');
    expect(s).toContain('seq 1 30');
    // Instala las herramientas que usa (git/openssl) — no las da por hechas en una AMI mínima.
    expect(s).toContain('install -y ca-certificates curl gnupg git openssl');
    // Docker desde el repo APT FIRMADO (no get.docker.com | sh sin checksum).
    expect(s).toContain('download.docker.com/linux/ubuntu/gpg');
    expect(s).toContain('docker-compose-plugin');
    expect(s).not.toContain('get.docker.com'); // ya no se usa el instalador sin checksum
    // Compat API 1.24 para Traefik v3 con Docker 29+ (si no, Traefik no lee labels → 404). [deploy real]
    expect(s).toContain('DOCKER_MIN_API_VERSION=1.24');
    // RESTART explícito (no 'enable --now') — sin esto el daemon ya corriendo no toma el drop-in y
    // Traefik queda en API 1.40 → 404 en todo. Bug real del 2º deploy.
    expect(s).toContain('systemctl restart docker');
    expect(s).toContain('MinAPIVersion'); // fail-fast si el min no quedó en 1.24
    expect(s).toContain('git clone');
    expect(s).toContain('deploy/example-mailserver'); // REUSA la plantilla existente
    expect(s).toContain('docker compose up -d');
    expect(s).toContain('mail.acme.com');
  });

  it('clona el ref pedido (release tag) y por defecto main — TD-PROVISION-CLONE-PIN', () => {
    const s = buildUserData(base);
    // Default: main (no behavior change cuando aún no hay releases).
    expect(s).toContain('REF="main"');
    // El clone usa la var validada; fast-fail de formato antes de clonar (mensaje claro vs git críptico).
    expect(s).toContain('git check-ref-format --allow-onelevel "$REF"');
    expect(s).toContain('git clone --depth 1 --branch "$REF"');
    // Un ref inválido debe avisar a CFN YA (signal_fail), no esperar al timeout del CreationPolicy: el
    // `|| { ... }` maneja el error y NO dispara el trap ERR, así que el signal va explícito. [B-MED]
    expect(s).toMatch(/check-ref-format[^\n]*\|\|[^\n]*signal_fail; exit 1/);
    // Rechaza la forma totalmente-calificada refs/... ANTES del clone (clone --branch sólo acepta
    // nombre corto); también señaliza a CFN. [B-MED v2]
    expect(s).toMatch(/case "\$REF" in refs\/\*\)[^\n]*signal_fail; exit 1/);
    // Override: un release tag conocido-bueno → provisión reproducible, no main HEAD.
    const pinned = buildUserData({ ...base, ref: 'v1.2.0' });
    expect(pinned).toContain('REF="v1.2.0"');
    expect(pinned).not.toContain('REF="main"');
    // El ref se escapa para bash (no inyección por comillas/backtick).
    const evil = buildUserData({ ...base, ref: 'x"; rm -rf /' });
    expect(evil).toContain('\\"'); // la comilla queda escapada dentro de "..."
    expect(evil).not.toContain('REF="x"; rm -rf /"');
  });

  it('genera los secretos con los NOMBRES EXACTOS del compose (.txt) y sin claves AWS', () => {
    const s = buildUserData(base);
    expect(s).toContain('secrets/jwt_secret.txt');
    expect(s).toContain('secrets/encryption_key.txt');
    // Secreto dedicado de la evidencia de compliance (lo exige la API en prod; nombre EXACTO del compose).
    expect(s).toContain('secrets/compliance_hmac_secret.txt');
    expect(s).toContain('openssl rand');
    // NUNCA debe haber access keys de AWS embebidas.
    expect(s).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(s).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('señaliza a CloudFormation éxito/fracaso (CreationPolicy) y arranca con storage local', () => {
    const s = buildUserData(base);
    // cfn-signal de éxito (0) y trap de fracaso (1) con el stack/region pasados.
    expect(s).toContain('cfn-signal -e 0 --stack "$STACK" --resource Instance --region "$REGION"');
    expect(s).toContain('cfn-signal -e 1');
    // Readiness FUNCIONAL: no basta "contenedor Up"; el webmail debe responder 200 por Traefik (si no,
    // un Traefik roto daba falso CREATE_COMPLETE). [hallazgo del primer deploy real]
    expect(s).toContain('/api/health');
    expect(s).toMatch(/code" = "200" \]|"\$\{?code\}?" = "200"/);
    expect(s).toContain('bifrost-acme-com');
    expect(s).toContain('STORAGE_PROVIDER=local');
    expect(s).not.toContain('STORAGE_PROVIDER=s3');
  });

  it('NO excede el límite de 16384 bytes de user-data de EC2 (con TODAS las features on)', () => {
    // Regresión: con Meet+SES+S3+admin el user-data verboso llegaba a ~18.4KB → EC2 rechaza el CREATE
    // ("User data is limited to 16384 bytes"). stripUserDataComments lo compacta. Margen de seguridad.
    const full = buildUserData({
      ...base,
      enableMeet: true,
      sesParamName: '/bifrost/acme-com/ses-smtp',
      s3Bucket: 'bifrost-acme-com-data',
      adminMailbox: 'admin@acme.com',
      adminMailboxPassword: 'clave-test-8+',
    });
    expect(Buffer.byteLength(full, 'utf8')).toBeLessThan(16384);
  });

  it('los exit explícitos (readiness, ref) señalizan a CFN — exit NO dispara el trap ERR', () => {
    const s = buildUserData(base);
    // El readiness check (contenedor muerto) hace signal_fail ANTES del exit 1 → CFN falla ya,
    // no por timeout de 15 min del CreationPolicy. [shellcheck re-audit]
    // (Los comentarios intermedios se eliminan por stripUserDataComments para no exceder los 16KB de EC2 →
    // el `#…` es opcional; lo que importa es signal_fail antes del exit 1.)
    expect(s).toMatch(/docker compose ps >&2\n(?:\s*#[^\n]*\n)*\s*signal_fail\n\s*exit 1/);
  });
});
