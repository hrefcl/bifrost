// Screenshot harness para evidencia visual del rediseño. Mockea /api/** en el navegador
// (sin backend) y captura admin, scheduling y páginas públicas. Uso:
//   node e2e/shots.mjs   (con `vite preview` corriendo en el puerto BASE)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SHOT_BASE || 'http://localhost:5199';
const OUT = process.env.SHOT_OUT || '/tmp/redis/shots';
mkdirSync(OUT, { recursive: true });

const USER = {
  id: 'u1',
  displayName: 'Admin Demo',
  primaryEmail: 'admin@aulion.app',
  role: 'admin',
};
const BRANDING = {
  companyName: 'Aulion',
  tagline: 'Tu correo, tu marca',
  accentColor: '#1b66ff',
  logoDataUrl: null,
};
const ACCOUNTS = [
  {
    id: 'a1',
    userId: 'u1',
    email: 'ana@aulion.app',
    name: 'Ana',
    displayName: 'Ana Pérez',
    role: 'admin',
    isPrimary: true,
    status: 'active',
    quotaBytes: 5368709120,
    usedBytes: 1503238553,
    lastSyncedAt: null,
  },
  {
    id: 'a2',
    userId: 'u2',
    email: 'diego@aulion.app',
    name: 'Diego',
    displayName: 'Diego Soto',
    role: 'user',
    isPrimary: true,
    status: 'active',
    quotaBytes: 2147483648,
    usedBytes: 805306368,
    lastSyncedAt: null,
  },
  {
    id: 'a3',
    userId: 'u3',
    email: 'lucia@aulion.app',
    name: 'Lucia',
    displayName: 'Lucía Mora',
    role: 'user',
    isPrimary: true,
    status: 'disabled',
    quotaBytes: 0,
    usedBytes: 134217728,
    lastSyncedAt: null,
  },
];
const SCHED = [
  {
    id: 's1',
    userId: 'u1',
    name: 'Horario laboral',
    timezone: 'America/Santiago',
    weeklyRules: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      intervals: [{ start: '09:00', end: '18:00' }],
    })),
    overrides: [
      { date: '2026-09-18', intervals: [], note: 'Fiestas Patrias' },
      {
        date: '2026-07-11',
        intervals: [{ start: '10:00', end: '13:00' }],
        note: 'Sábado especial',
      },
    ],
    isDefault: true,
    createdAt: '',
    updatedAt: '',
  },
];
const EVENT_TYPES = [
  {
    id: 'e1',
    userId: 'u1',
    slug: '30min',
    title: 'Reunión 30 min',
    description: 'Una charla rápida.',
    durationMinutes: 30,
    color: '#1b66ff',
    location: { type: 'video' },
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minimumNoticeMin: 0,
    dateRangeDays: 60,
    availabilityScheduleId: 's1',
    customQuestions: [],
    active: true,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'e2',
    userId: 'u1',
    slug: 'asesoria',
    title: 'Asesoría 60 min',
    durationMinutes: 60,
    color: '#9333ea',
    location: { type: 'phone' },
    bufferBeforeMin: 10,
    bufferAfterMin: 10,
    minimumNoticeMin: 120,
    dateRangeDays: 30,
    availabilityScheduleId: 's1',
    customQuestions: [],
    active: false,
    createdAt: '',
    updatedAt: '',
  },
];
const BOOKINGS = [
  {
    id: 'b1',
    eventTypeId: 'e1',
    userId: 'u1',
    snapshot: {
      timezone: 'America/Santiago',
      durationMinutes: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minimumNoticeMin: 0,
      title: 'Reunión 30 min',
      location: { type: 'video' },
    },
    startAt: '2026-07-10T14:00:00.000Z',
    endAt: '2026-07-10T14:30:00.000Z',
    invitee: {
      name: 'Juan Pérez',
      email: 'juan@cliente.cl',
      timezone: 'America/Santiago',
      phone: '+56 9 1234 5678',
    },
    answers: [],
    status: 'confirmed',
    source: 'public',
    createdAt: '2026-06-27T18:04:00.000Z',
    updatedAt: '',
  },
  {
    id: 'b2',
    eventTypeId: 'e1',
    userId: 'u1',
    snapshot: {
      timezone: 'America/Santiago',
      durationMinutes: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minimumNoticeMin: 0,
      title: 'Reunión 30 min',
      location: { type: 'video' },
    },
    startAt: '2026-07-08T16:00:00.000Z',
    endAt: '2026-07-08T16:30:00.000Z',
    invitee: { name: 'María López', email: 'maria@x.com', timezone: 'America/Santiago' },
    answers: [],
    status: 'cancelled',
    source: 'public',
    createdAt: '',
    updatedAt: '',
  },
];
const PUB_PROFILE = {
  username: 'ana',
  displayName: 'Ana Pérez',
  avatarUrl: null,
  eventTypes: [
    {
      slug: '30min',
      title: 'Reunión 30 min',
      description: 'Una charla rápida para conocernos.',
      durationMinutes: 30,
      color: '#1b66ff',
      location: { type: 'video' },
      customQuestions: [],
    },
    {
      slug: 'asesoria',
      title: 'Asesoría 60 min',
      durationMinutes: 60,
      color: '#9333ea',
      location: { type: 'phone' },
      customQuestions: [],
    },
  ],
};
const PUB_EVENT = {
  slug: '30min',
  title: 'Reunión 30 min',
  description: 'Una charla rápida para conocernos.',
  durationMinutes: 30,
  color: '#1b66ff',
  location: { type: 'video' },
  customQuestions: [],
};
function slotsFor() {
  // Genera huecos para el día siguiente (mañana) a las 10:00..16:30 en UTC aproximado.
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setHours(13, 0, 0, 0);
  const out = [];
  for (let i = 0; i < 8; i++)
    out.push({ start: new Date(d.getTime() + i * 30 * 60000).toISOString() });
  return { slots: out };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(page, { publicSlug = 'ana' } = {}) {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/api/, '');
    // auth + bootstrap
    if (p === '/setup/status') return json(route, { setupRequired: false });
    if (p === '/branding') return json(route, BRANDING);
    if (p === '/auth/refresh') return json(route, { accessToken: 'tok' });
    if (p === '/auth/me') return json(route, USER);
    if (p.startsWith('/compliance/pending')) return json(route, { pending: [] });
    // admin
    if (p === '/admin/accounts') return json(route, { accounts: ACCOUNTS });
    if (p === '/admin/config/branding') return json(route, BRANDING);
    if (p === '/admin/config/storage') return json(route, { providerType: 'local' });
    if (p === '/admin/groups')
      return json(route, {
        groups: [
          {
            id: 'g1',
            name: 'Ventas',
            description: 'Equipo comercial',
            color: '#1b66ff',
            email: 'ventas@aulion.app',
            memberUserIds: ['u1', 'u2'],
            memberCount: 2,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'g2',
            name: 'Soporte técnico',
            color: '#9333ea',
            memberUserIds: ['u3'],
            memberCount: 1,
            createdAt: '',
            updatedAt: '',
          },
        ],
      });
    if (p === '/admin/config/storage-defaults')
      return json(route, { defaultQuotaBytes: 2147483648 });
    if (p === '/admin/config/calendar')
      return json(route, {
        timezone: 'America/Santiago',
        weekStart: 1,
        dayStart: '08:00',
        dayEnd: '20:00',
        defaultDurationMin: 30,
        defaultView: 'week',
        showWeekends: true,
        autoInvite: true,
        syncAgenda: true,
      });
    if (p === '/admin/version') return json(route, { build: '113', sha: 'abc1234' });
    if (p === '/admin/update/check')
      return json(route, {
        current: { version: '6.0.0', build: '113', sha: 'abc1234' },
        latest: { build: 113, sha: 'abc1234', date: '' },
        updateAvailable: false,
        behind: 0,
        checkError: false,
        compareUrl: null,
        repoUrl: '',
      });
    if (p === '/admin/scheduling/settings')
      return json(route, {
        enabled: true,
        publicLinksEnabled: true,
        defaults: { timezone: 'America/Santiago', durationMinutes: 30, dateRangeDays: 60 },
        auditEnabled: true,
        maxEventTypesPerUser: 10,
      });
    if (p === '/admin/scheduling/summary')
      return json(route, { eventTypes: 3, confirmed: 12, cancelled: 2, hostsWithUsername: 4 });
    if (p.startsWith('/admin/scheduling/bookings'))
      return json(route, { total: 2, bookings: BOOKINGS });
    if (p.startsWith('/compliance/admin/documents')) return json(route, []);
    // scheduling host
    if (p === '/schedule/profile') return json(route, { username: 'ana' });
    if (p === '/schedule/availability') return json(route, SCHED);
    if (p === '/schedule/event-types') return json(route, EVENT_TYPES);
    if (p.startsWith('/schedule/bookings')) return json(route, BOOKINGS);
    // público
    if (p.endsWith(`/schedule/public/${publicSlug}`) || p === `/schedule/public/${publicSlug}`)
      return json(route, PUB_PROFILE);
    if (p.startsWith('/schedule/public/') && p.includes('/slots')) return json(route, slotsFor());
    if (p.match(/\/schedule\/public\/[^/]+\/[^/]+$/)) return json(route, PUB_EVENT);
    if (p.startsWith('/schedule/public/')) return json(route, {}, 404); // slug inexistente → 404
    return json(route, {}, 200);
  });
}

async function shot(page, name, theme = 'light') {
  if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  if (theme === 'dark')
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
  console.log('shot', name);
}

const run = async () => {
  const browser = await chromium.launch();
  // Desktop
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: 'America/Santiago',
  });
  const page = await ctx.newPage();
  await mockApi(page);

  // Admin
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await shot(page, 'admin-accounts');
  await page
    .getByRole('button', { name: 'Grupos' })
    .click()
    .catch(() => undefined);
  await shot(page, 'admin-groups');
  await page
    .getByRole('button', { name: 'Marca' })
    .click()
    .catch(() => undefined);
  await shot(page, 'admin-branding');
  await page
    .getByRole('button', { name: 'Agenda' })
    .click()
    .catch(() => undefined);
  await shot(page, 'admin-scheduling');
  await page
    .getByRole('button', { name: 'Almacenamiento' })
    .click()
    .catch(() => undefined);
  await shot(page, 'admin-storage');
  await page
    .getByRole('button', { name: 'Preferencias' })
    .click()
    .catch(() => undefined);
  await shot(page, 'admin-preferences');
  await shot(page, 'admin-accounts-dark', 'dark');

  // Scheduling host
  await page.goto(`${BASE}/scheduling`, { waitUntil: 'networkidle' });
  await shot(page, 'sched-types');
  await page
    .locator('[data-testid="sched-tab-availability"]')
    .click()
    .catch(() => undefined);
  await shot(page, 'sched-availability');
  await page
    .locator('[data-testid="sched-tab-bookings"]')
    .click()
    .catch(() => undefined);
  await shot(page, 'sched-bookings');
  await page
    .locator('[data-testid="sched-tab-availability"]')
    .click()
    .catch(() => undefined);
  await page
    .locator('[data-testid="sched-new-exception"]')
    .click()
    .catch(() => undefined);
  await shot(page, 'sched-exception-modal');

  // Público
  await page.goto(`${BASE}/u/ana`, { waitUntil: 'networkidle' });
  await shot(page, 'pub-profile');
  await page
    .locator('[data-testid="pub-eventtype-30min"]')
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(400);
  await shot(page, 'pub-booking-calendar');
  await page.goto(`${BASE}/u/inexistente`, { waitUntil: 'networkidle' });
  await shot(page, 'pub-404');

  await ctx.close();

  // Mobile (drawer admin)
  const m = await browser.newContext({
    viewport: { width: 414, height: 850 },
    timezoneId: 'America/Santiago',
  });
  const mp = await m.newPage();
  await mockApi(mp);
  await mp.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await shot(mp, 'admin-mobile-closed');
  await mp
    .locator('.admin-burger')
    .click()
    .catch(() => undefined);
  await mp.waitForTimeout(350);
  await shot(mp, 'admin-mobile-drawer');
  await mp.goto(`${BASE}/u/ana`, { waitUntil: 'networkidle' });
  await shot(mp, 'pub-profile-mobile');
  await m.close();

  await browser.close();
  console.log('DONE');
};
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
