import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

export const useSettingsStore = defineStore('settings', () => {
  const saved = localStorage.getItem('theme');
  const validThemes: ('light' | 'dark' | 'system')[] = ['light', 'dark', 'system'];
  const theme = ref<'light' | 'dark' | 'system'>(
    validThemes.includes(saved as 'light' | 'dark' | 'system')
      ? (saved as 'light' | 'dark' | 'system')
      : 'system'
  );

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
    localStorage.setItem('theme', value);
    applyTheme();
  }

  watch(theme, applyTheme);

  return { theme, applyTheme, setTheme };
});
