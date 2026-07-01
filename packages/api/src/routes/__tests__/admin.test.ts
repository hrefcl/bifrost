import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { User } from '../../models/User.js';

describe('admin role + requireAdmin (PR-A)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sin token → /api/admin/whoami responde 401 (auth corre antes que requireAdmin)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/admin/whoami' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('usuario normal → /api/admin/whoami responde 403 (feature-gate backend)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'normal@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/whoami',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('admin → /api/admin/whoami responde 200', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'admin@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/whoami',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.role).toBe('admin');
    // RBAC (F8): el admin es superusuario → whoami devuelve TODO el catálogo de permisos.
    expect(body.permissions).toContain('roles.manage');
    expect(body.permissions).toContain('accounts.manage');
    await app.close();
  });

  it('/api/admin/config/calendar (F5): defaults, deep-merge en PATCH, validación y gate admin', async () => {
    const app = await buildTestApp();
    const { user: normal } = await seedUserWithAccount({ email: 'norm-cal@test.com' });
    const { user: admin } = await seedUserWithAccount({ email: 'admin-cal@test.com' });
    await User.updateOne({ _id: admin._id }, { $set: { role: 'admin' } });
    const A = authHeaders(app, admin._id.toString());

    // gate admin
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/config/calendar',
          headers: authHeaders(app, normal._id.toString()),
        })
      ).statusCode
    ).toBe(403);

    // GET → defaults
    const def = await app.inject({ method: 'GET', url: '/api/admin/config/calendar', headers: A });
    expect(def.statusCode).toBe(200);
    expect(JSON.parse(def.body)).toMatchObject({ weekStart: 1, defaultView: 'week' });

    // PATCH parcial → mergea (lo no enviado conserva default)
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/calendar',
      headers: A,
      payload: { defaultView: 'month', defaultDurationMin: 45 },
    });
    expect(patched.statusCode).toBe(200);
    const body = JSON.parse(patched.body) as {
      defaultView: string;
      defaultDurationMin: number;
      weekStart: number;
    };
    expect(body.defaultView).toBe('month');
    expect(body.defaultDurationMin).toBe(45);
    expect(body.weekStart).toBe(1); // intacto (deep-merge)

    // segundo PATCH sólo de otra clave → NO pisa el defaultView previo (persistencia)
    const p2 = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/calendar',
      headers: A,
      payload: { showWeekends: false },
    });
    expect(JSON.parse(p2.body).defaultView).toBe('month');

    // validación: dayEnd <= dayStart → 400
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/admin/config/calendar',
          headers: A,
          payload: { dayStart: '20:00', dayEnd: '08:00' },
        })
      ).statusCode
    ).toBe(400);

    // validación: tz inválida → 400
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/admin/config/calendar',
          headers: A,
          payload: { timezone: 'X/Y' },
        })
      ).statusCode
    ).toBe(400);
    await app.close();
  });

  it('/api/admin/version: admin obtiene build/sha; un usuario normal 403 (no en /health público)', async () => {
    const app = await buildTestApp();
    const { user: normal } = await seedUserWithAccount({ email: 'norm-ver@test.com' });
    const normal403 = await app.inject({
      method: 'GET',
      url: '/api/admin/version',
      headers: authHeaders(app, normal._id.toString()),
    });
    expect(normal403.statusCode).toBe(403);

    const { user: admin } = await seedUserWithAccount({ email: 'admin-ver@test.com' });
    await User.updateOne({ _id: admin._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/version',
      headers: authHeaders(app, admin._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty('build');
    await app.close();
  });

  it('requireAdmin consulta la DB: cambiar el rol en DB invalida el acceso aunque el token siga', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'demote@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const headers = authHeaders(app, user._id.toString());
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/whoami', headers })).statusCode
    ).toBe(200);
    // Degradado en DB (mismo token) → 403.
    await User.updateOne({ _id: user._id }, { $set: { role: 'user' } });
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/whoami', headers })).statusCode
    ).toBe(403);
    await app.close();
  });

  it('GET /api/admin/config/storage → default local; PATCH lo persiste con updatedBy', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'cfg@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const headers = authHeaders(app, user._id.toString());

    const get = await app.inject({ method: 'GET', url: '/api/admin/config/storage', headers });
    expect(get.statusCode).toBe(200);
    expect((JSON.parse(get.body) as { providerType: string }).providerType).toBe('local');

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers,
      payload: { providerType: 'local' },
    });
    expect(patch.statusCode).toBe(200);
    expect((JSON.parse(patch.body) as { updatedBy: string }).updatedBy).toBe(user._id.toString());
  });

  it('PATCH config/storage con providerType no implementado (s3) → 400', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'cfg2@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
      payload: { providerType: 's3' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('config/storage requiere admin: usuario normal → 403', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'cfg3@test.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('el auto-registro por login NO crea admins (role default = user)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'auto@test.com' });
    const fresh = await User.findById(user._id).lean();
    expect(fresh?.role).toBe('user');
    await app.close();
  });

  it('PATCH config/storage s3 → 200, persiste el secret CIFRADO y la respuesta lo OMITE (PR-D)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
      payload: {
        providerType: 's3',
        s3: {
          endpoint: 'https://minio.test',
          bucket: 'b',
          region: 'us-east-1',
          accessKeyId: 'AKIA',
          secretAccessKey: 'el-secreto-no-debe-volver',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { s3?: { secretConfigured?: boolean } };
    expect(body.s3?.secretConfigured).toBe(true);
    // El secret en claro NUNCA vuelve en la respuesta.
    expect(res.body).not.toContain('el-secreto-no-debe-volver');

    // GET tampoco lo expone.
    const get = await app.inject({
      method: 'GET',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(get.body).not.toContain('el-secreto-no-debe-volver');
    await app.close();
  });

  it('PATCH config/storage s3 con campos faltantes → 400', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3bad@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
      payload: { providerType: 's3', s3: { bucket: 'b' } }, // falta region/accessKeyId/secret
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST config/storage/test: conexión S3 OK (round-trip mockeado) → 200 {ok:true}', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3test-ok@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request) =>
        Promise.resolve(
          input.method === 'GET'
            ? new Response(new Uint8Array(Buffer.from('bifrost-connectivity-probe')), {
                status: 200,
              })
            : new Response(null, { status: input.method === 'DELETE' ? 204 : 200 })
        )
      )
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/config/storage/test',
      headers: authHeaders(app, user._id.toString()),
      payload: {
        endpoint: 'https://minio.test',
        bucket: 'b',
        region: 'us-east-1',
        accessKeyId: 'AK',
        secretAccessKey: 's',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    await app.close();
  });

  it('POST config/storage/test: si S3 falla → 400 con mensaje claro (sin persistir)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3test-fail@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 403 })))
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/config/storage/test',
      headers: authHeaders(app, user._id.toString()),
      payload: { bucket: 'b', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 's' },
    });
    expect(res.statusCode).toBe(400);
    // No persistió: el provider activo sigue siendo el default 'local'.
    const get = await app.inject({
      method: 'GET',
      url: '/api/admin/config/storage',
      headers: authHeaders(app, user._id.toString()),
    });
    expect((JSON.parse(get.body) as { providerType: string }).providerType).toBe('local');
    await app.close();
  });

  it('POST config/storage/test requiere admin: usuario normal → 403', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3test-403@test.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/config/storage/test',
      headers: authHeaders(app, user._id.toString()),
      payload: { bucket: 'b', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 's' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('PATCH config/storage s3 rechaza endpoint/región peligrosos → 400 (anti-SSRF/inyección)', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 's3ssrf@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const headers = authHeaders(app, user._id.toString());
    const base = { bucket: 'b', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 's' };
    const bad = [
      { ...base, endpoint: 'http://169.254.169.254/' }, // metadata cloud
      { ...base, endpoint: 'ftp://example.com' }, // esquema no http(s)
      { ...base, endpoint: 'https://u:p@example.com' }, // userinfo
      { ...base, endpoint: 'https://example.com/foo?x=1' }, // query/path (hijack de concat)
      { ...base, region: 'us-east-1/../evil' }, // región con charset inválido
    ];
    for (const s3 of bad) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/config/storage',
        headers,
        payload: { providerType: 's3', s3 },
      });
      expect(res.statusCode, JSON.stringify(s3)).toBe(400);
    }
    // En cambio, un MinIO interno (http + host privado, sin path) SÍ se acepta.
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/admin/config/storage',
      headers,
      payload: { providerType: 's3', s3: { ...base, endpoint: 'http://minio:9000' } },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  // ───────── Agenda (Fase 3.7) ─────────
  async function adminApp(email: string) {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email });
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    return { app, headers: authHeaders(app, user._id.toString()) };
  }

  it('scheduling/settings: GET default + PATCH parcial (defaults se mergea, no se exige completo)', async () => {
    const { app, headers } = await adminApp('sched-cfg@test.com');
    const get = await app.inject({ method: 'GET', url: '/api/admin/scheduling/settings', headers });
    expect(get.statusCode).toBe(200);
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/admin/scheduling/settings',
      headers,
      payload: { enabled: true, defaults: { durationMinutes: 45 } },
    });
    expect(patch.statusCode).toBe(200);
    const body = JSON.parse(patch.body) as {
      enabled: boolean;
      defaults: { durationMinutes: number; timezone: string };
    };
    expect(body.enabled).toBe(true);
    expect(body.defaults.durationMinutes).toBe(45);
    expect(body.defaults.timezone).toBeTruthy(); // no se perdió el resto del objeto
    await app.close();
  });

  it('scheduling/settings: PATCH con tz inválida → 400', async () => {
    const { app, headers } = await adminApp('sched-tz@test.com');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/scheduling/settings',
      headers,
      payload: { defaults: { timezone: 'Marte/Olympus' } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('scheduling/bookings: 403 si auditEnabled=false, 200 si on (review B-LOW)', async () => {
    const { app, headers } = await adminApp('sched-audit@test.com');
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/scheduling/settings',
      headers,
      payload: { auditEnabled: false },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/scheduling/bookings', headers }))
        .statusCode
    ).toBe(403);
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/scheduling/settings',
      headers,
      payload: { auditEnabled: true },
    });
    const ok = await app.inject({ method: 'GET', url: '/api/admin/scheduling/bookings', headers });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toHaveProperty('total');
    await app.close();
  });

  it('scheduling/{settings,bookings,summary} exigen admin → 403 para usuario normal', async () => {
    const app = await buildTestApp();
    const { user } = await seedUserWithAccount({ email: 'sched-norm@test.com' });
    const headers = authHeaders(app, user._id.toString());
    for (const url of [
      '/api/admin/scheduling/settings',
      '/api/admin/scheduling/bookings',
      '/api/admin/scheduling/summary',
    ]) {
      expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(403);
    }
    await app.close();
  });
});
