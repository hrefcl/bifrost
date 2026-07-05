import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// `virtual:pwa-register` se mockea porque sin vite-plugin-pwa no resuelve. `useOnline` se mockea con un
// valor controlable (`hoisted.onlineValue`): SÓLO se invoca en los tests que definen `window` (path de
// instalación / offline); en los tests de detección de plataforma `window` queda undefined y el
// composable cae por su guarda a `online=ref(true)` sin llamar a useOnline. Dejar `window` undefined
// aísla la lógica de detección (rama iOS que los e2e en Chrome desktop nunca tocan y sin dispositivo iOS).
const hoisted = vi.hoisted(() => ({ onlineValue: true }));
vi.mock('virtual:pwa-register', () => ({ registerSW: () => vi.fn() }));
vi.mock('@vueuse/core', () => ({
  useOnline: () => ({
    get value() {
      return hoisted.onlineValue;
    },
  }),
}));

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/604.1',
  ipadOS:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  iphoneEdge:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 EdgiOS/126.0 Mobile/15E148 Safari/604.1',
};

async function loadWith(ua: string, maxTouchPoints = 0) {
  vi.resetModules(); // el composable es un singleton module-level → import fresco por caso
  vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints });
  const { usePwa } = await import('../usePwa');
  return usePwa();
}

/** window mínimo con registro de eventos + matchMedia, para ejercitar el camino con `beforeinstallprompt`. */
function makeWindow() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  return {
    addEventListener(type: string, cb: (e: unknown) => void) {
      (listeners[type] ??= []).push(cb);
    },
    dispatchEvent(e: { type: string }) {
      (listeners[e.type] ?? []).forEach((cb) => {
        cb(e);
      });
    },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  };
}

describe('usePwa — detección de plataforma', () => {
  beforeEach(() => {
    hoisted.onlineValue = true;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('iPhone Safari → isIos + isIosSafari', async () => {
    const p = await loadWith(UA.iphoneSafari);
    expect(p.isIos).toBe(true);
    expect(p.isIosSafari).toBe(true);
  });

  it('iPhone Chrome (CriOS) → isIos pero NO isIosSafari', async () => {
    const p = await loadWith(UA.iphoneChrome);
    expect(p.isIos).toBe(true);
    expect(p.isIosSafari).toBe(false);
  });

  it('iPhone Firefox (FxiOS) → isIos pero NO isIosSafari', async () => {
    const p = await loadWith(UA.iphoneFirefox);
    expect(p.isIos).toBe(true);
    expect(p.isIosSafari).toBe(false);
  });

  it('iPadOS 13+ (Macintosh con touch) → isIos', async () => {
    const p = await loadWith(UA.ipadOS, 5); // maxTouchPoints>1 distingue de un Mac
    expect(p.isIos).toBe(true);
    expect(p.isIosSafari).toBe(true);
  });

  it('Mac de escritorio (Macintosh sin touch) → NO isIos (evita falso positivo, review D-008)', async () => {
    const p = await loadWith(UA.macDesktop, 0);
    expect(p.isIos).toBe(false);
    expect(p.isIosSafari).toBe(false);
  });

  it('Android Chrome → NO isIos', async () => {
    const p = await loadWith(UA.androidChrome);
    expect(p.isIos).toBe(false);
    expect(p.isIosSafari).toBe(false);
  });

  it('iPhone Edge (EdgiOS) → isIos pero NO isIosSafari (blinda la exclusión edgios)', async () => {
    const p = await loadWith(UA.iphoneEdge);
    expect(p.isIos).toBe(true);
    expect(p.isIosSafari).toBe(false);
  });
});

describe('usePwa — gating de los CTA de instalación', () => {
  beforeEach(() => {
    hoisted.onlineValue = true;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('iPhone Safari no instalado → showIosHint true, showInstallBanner false (sin beforeinstallprompt)', async () => {
    const p = await loadWith(UA.iphoneSafari);
    expect(p.showIosHint.value).toBe(true);
    // Sin evento beforeinstallprompt capturado no hay prompt nativo → no se ofrece el banner.
    expect(p.showInstallBanner.value).toBe(false);
  });

  it('Android sin prompt capturado → ningún CTA visible', async () => {
    const p = await loadWith(UA.androidChrome);
    expect(p.showIosHint.value).toBe(false);
    expect(p.showInstallBanner.value).toBe(false);
  });

  it('iPhone Chrome (no Safari) → NO muestra el hint de iOS', async () => {
    const p = await loadWith(UA.iphoneChrome);
    expect(p.showIosHint.value).toBe(false);
  });

  it('dismissInstall() oculta el hint de iOS (persistencia en memoria aunque no haya localStorage)', async () => {
    const p = await loadWith(UA.iphoneSafari);
    expect(p.showIosHint.value).toBe(true);
    p.dismissInstall();
    expect(p.showIosHint.value).toBe(false);
  });

  it('Android + beforeinstallprompt capturado → showInstallBanner true y promptInstall dispara el prompt', async () => {
    vi.resetModules();
    const win = makeWindow();
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', { userAgent: UA.androidChrome, maxTouchPoints: 1 });
    const mod = await import('../usePwa');
    mod.initPwa(); // registra el listener beforeinstallprompt (necesita window)
    const p = mod.usePwa();
    expect(p.showInstallBanner.value).toBe(false); // aún sin evento

    // Simular el evento nativo del navegador.
    const prompt = vi.fn().mockResolvedValue(undefined);
    const evt = {
      type: 'beforeinstallprompt',
      preventDefault: vi.fn(),
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    };
    win.dispatchEvent(evt);

    expect(evt.preventDefault).toHaveBeenCalled(); // no dejamos el mini-infobar automático
    expect(p.showInstallBanner.value).toBe(true);

    const outcome = await p.promptInstall();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('accepted');
  });

  it('offline → ningún CTA aunque sea iPhone Safari (review D-003)', async () => {
    vi.resetModules();
    hoisted.onlineValue = false; // con window definido, el composable lee useOnline (=false)
    vi.stubGlobal('window', makeWindow());
    vi.stubGlobal('navigator', { userAgent: UA.iphoneSafari, maxTouchPoints: 5 });
    const mod = await import('../usePwa');
    const p = mod.usePwa();
    expect(p.showIosHint.value).toBe(false);
    expect(p.showInstallBanner.value).toBe(false);
  });
});
