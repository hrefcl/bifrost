/**
 * PWA: estado de instalación, actualización del service worker y conexión.
 *
 * Es un SINGLETON module-level: los listeners (`beforeinstallprompt`, `appinstalled`) se registran
 * una sola vez vía `initPwa()` desde `main.ts`, ANTES de montar la app, porque `beforeinstallprompt`
 * se dispara muy temprano y un composable montado tarde se lo perdería. Los componentes sólo LEEN
 * el estado reactivo con `usePwa()`.
 *
 * Seguridad: el SW no cachea nada de `/api/*` (ver vite.config.ts). El token vive en memoria
 * (stores/auth.ts). Aquí sólo se guarda en localStorage un flag booleano de "descarté el banner de
 * instalación" — nada sensible.
 */
import { ref, computed, readonly } from 'vue';
import { useOnline } from '@vueuse/core';
import { registerSW } from 'virtual:pwa-register';

/** Evento no estándar de Chromium para instalar la PWA. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_KEY = 'pwa:install-dismissed';

// `useOnline()` toca `window` al invocarse; se guarda contra entornos sin DOM (tests/SSR). (review D-005)
const online = typeof window !== 'undefined' ? useOnline() : ref(true);
const needRefresh = ref(false);
const deferredPrompt = ref<BeforeInstallPromptEvent | null>(null);
const installed = ref(false);
const installDismissed = ref(readDismissed());

/** Fuerza la activación del SW en espera y recarga (se llama desde el toast "Actualizar"). */
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

// ── Detección de plataforma (una sola vez) ─────────────────────────────────────────────────────
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0;
// iPadOS 13+ se presenta como "Macintosh"; se distingue de un Mac de escritorio exigiendo pantalla
// táctil real (maxTouchPoints > 1), no sólo 'ontouchend' — que da falsos positivos. (review D-008)
const isIos = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
// Safari (no Chrome/Firefox iOS, que traen CriOS/FxiOS).
const isIosSafari = isIos && !/crios|fxios|edgios/i.test(ua);
function computeStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mm = window.matchMedia('(display-mode: standalone)').matches;
  // iOS expone `navigator.standalone` (propietario).
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return mm || iosStandalone;
}
const isStandalone = ref(computeStandalone());

let initialized = false;

/** Registra los listeners + el service worker. Idempotente. Llamar desde main.ts antes de montar. */
export function initPwa(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  updateServiceWorker = registerSW({
    onNeedRefresh() {
      needRefresh.value = true;
    },
    onOfflineReady() {
      // El shell ya está precacheado (la app puede abrir offline). Sólo observabilidad; no hay UI
      // asociada porque el estado "offline" real lo comunica el banner por `online` (review D-002).
      console.info('[pwa] app shell listo para uso offline');
    },
  });

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    // Evita el mini-infobar automático del navegador: el prompt lo dispara nuestro banner.
    e.preventDefault();
    deferredPrompt.value = e as BeforeInstallPromptEvent;
  });

  window.addEventListener('appinstalled', () => {
    installed.value = true;
    deferredPrompt.value = null;
  });

  // Si el usuario instala/desinstala, `display-mode` cambia en caliente.
  window.matchMedia('(display-mode: standalone)').addEventListener('change', (ev) => {
    isStandalone.value = ev.matches || computeStandalone();
  });
}

export function usePwa() {
  /** Puede instalarse por el flujo nativo (Android/desktop): hay prompt guardado y no está instalada. */
  const canInstallNative = computed(
    () => deferredPrompt.value !== null && !installed.value && !isStandalone.value
  );

  // Nunca ofrecer instalar SIN conexión: el flujo de instalación puede fallar o dejar una app
  // inservible (review D-003). Se exige `online`.
  /** Mostrar el hint de iOS (Safari, online, no instalada, no descartado). */
  const showIosHint = computed(
    () => online.value && isIosSafari && !isStandalone.value && !installDismissed.value
  );

  /** Mostrar el banner nativo de instalación (online, no descartado). */
  const showInstallBanner = computed(
    () => online.value && canInstallNative.value && !installDismissed.value
  );

  /** Dispara el prompt nativo de instalación. */
  async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const ev = deferredPrompt.value;
    if (!ev) return 'unavailable';
    try {
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      return outcome;
    } catch {
      // El navegador rechazó el prompt (política/contexto inseguro/doble invocación): no romper. (D-009)
      return 'unavailable';
    } finally {
      deferredPrompt.value = null; // el evento es de un solo uso, se consuma o falle
    }
  }

  /** Persiste que el usuario descartó el CTA de instalación (no vuelve a molestar). */
  function dismissInstall(): void {
    installDismissed.value = true;
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage no disponible (modo privado): el flag en memoria alcanza para la sesión */
    }
  }

  /** Aplica la actualización del SW en espera y recarga la app. */
  async function applyUpdate(): Promise<void> {
    try {
      // En éxito, `updateSW(true)` activa el SW nuevo y RECARGA la página (no hace falta bajar el flag).
      await updateServiceWorker?.(true);
    } catch {
      // Si la activación falla, mantener el toast visible para reintentar (review C-MED-1).
      needRefresh.value = true;
    }
  }

  return {
    online, // ref<boolean> de @vueuse/core
    needRefresh: readonly(needRefresh),
    isStandalone: readonly(isStandalone),
    isIos,
    isIosSafari,
    canInstallNative,
    showInstallBanner,
    showIosHint,
    promptInstall,
    dismissInstall,
    applyUpdate,
  };
}
