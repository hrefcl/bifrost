import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { brand } from '@/config/brand';

export const useSettingsStore = defineStore('settings', () => {
  const saved = localStorage.getItem('theme');
  const validThemes: ('light' | 'dark' | 'system')[] = ['light', 'dark', 'system'];
  const theme = ref<'light' | 'dark' | 'system'>(
    validThemes.includes(saved as 'light' | 'dark' | 'system')
      ? (saved as 'light' | 'dark' | 'system')
      : 'system'
  );

  // Acento configurable a nivel USUARIO (override de la marca, en runtime): personaliza la
  // plataforma sin tocar build. Se persiste y se reaplica al cargar (App.vue).
  // VALIDADO como HEX antes de inyectarlo en CSS (`style.setProperty('--accent', …)`): el valor
  // viene de localStorage (controlable por el usuario) y se interpola en `color-mix(...)`; un
  // string arbitrario podría romper la regla CSS. Si no es HEX válido, cae al accent de marca.
  const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  function safeAccent(value: string | null): string {
    const v = (value ?? '').trim();
    return HEX_COLOR.test(v) ? v : brand.accent;
  }
  const accent = ref<string>(safeAccent(localStorage.getItem('accent')));

  function applyAccent() {
    const root = document.documentElement;
    root.style.setProperty('--accent', accent.value);
    root.style.setProperty('--accent-700', `color-mix(in srgb, ${accent.value} 82%, #000)`);
    root.style.setProperty('--accent-300', `color-mix(in srgb, ${accent.value} 52%, #fff)`);
  }

  function setAccent(value: string) {
    accent.value = safeAccent(value);
  }

  watch(accent, (value) => {
    localStorage.setItem('accent', value);
    applyAccent();
  });

  function applyTheme() {
    const root = document.documentElement;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = theme.value === 'dark' || (theme.value === 'system' && prefersDark);
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }

  function setTheme(value: 'light' | 'dark' | 'system') {
    theme.value = value;
  }

  // Persistir + aplicar en el watch (fuente única): así CUALQUIER cambio de `theme` —
  // incluido el `v-model` del select en SettingsView — se guarda en localStorage. Antes
  // sólo `setTheme` persistía, y el select usa v-model directo → el tema no sobrevivía al reload.
  watch(theme, (value) => {
    localStorage.setItem('theme', value);
    applyTheme();
  });

  return { theme, applyTheme, setTheme, accent, applyAccent, setAccent };
});
