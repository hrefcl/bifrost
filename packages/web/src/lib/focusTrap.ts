import type { Directive } from 'vue';

/**
 * `v-focus-trap` — atrapa el foco dentro de un elemento (modales/drawer) y lo devuelve al
 * disparador al cerrar. Cumple el checklist a11y del rediseño (focus-trap + foco inicial + retorno).
 *
 * Valor booleano opcional = "activo": útil para un drawer que vive siempre en el DOM (móvil).
 *  - sin valor o `true`  → activo mientras el elemento esté montado (caso modal con v-if).
 *  - `false`             → inactivo (no atrapa); al pasar de true→false devuelve el foco.
 *
 * Robusto: si no hay focusables visibles, retiene el foco en el contenedor (requiere tabindex="-1").
 */
const SEL =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface TrapState {
  onKey: (e: KeyboardEvent) => void;
  prev: HTMLElement | null;
  active: boolean;
}
const store = new WeakMap<HTMLElement, TrapState>();

function focusables(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(SEL)).filter(
    (e) => e.offsetWidth > 0 || e.offsetHeight > 0 || e === document.activeElement
  );
}

function activate(el: HTMLElement) {
  if (store.get(el)?.active) return;
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const f = focusables(el);
    if (f.length === 0) {
      e.preventDefault();
      el.focus();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const a = document.activeElement;
    if (e.shiftKey && (a === first || !el.contains(a))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (a === last || !el.contains(a))) {
      e.preventDefault();
      first.focus();
    }
  };
  el.addEventListener('keydown', onKey);
  store.set(el, { onKey, prev, active: true });
  const f = focusables(el);
  (f[0] ?? el).focus();
}

function deactivate(el: HTMLElement) {
  const s = store.get(el);
  if (!s?.active) return;
  el.removeEventListener('keydown', s.onKey);
  s.active = false;
  // Devolver el foco al disparador (botón que abrió el modal/drawer).
  s.prev?.focus();
}

export const vFocusTrap: Directive<HTMLElement, boolean | undefined> = {
  mounted(el, binding) {
    if (binding.value !== false) activate(el);
  },
  updated(el, binding) {
    const isActive = store.get(el)?.active ?? false;
    if (binding.value !== false && !isActive) activate(el);
    else if (binding.value === false && isActive) deactivate(el);
  },
  beforeUnmount(el) {
    deactivate(el);
  },
};
