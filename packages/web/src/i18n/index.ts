/**
 * i18n — la UI es multi-idioma SIEMPRE. Ningún texto visible se hardcodea: todo pasa por
 * claves de traducción. El idioma por defecto es español (alineado con la maqueta); inglés
 * disponible. El idioma elegido se persiste en localStorage y se refleja en <html lang>.
 */
import { createI18n } from 'vue-i18n';
import es from './locales/es';
import en from './locales/en';

export const SUPPORTED_LOCALES = ['es', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  es: 'Español',
  en: 'English',
};

function isSupported(value: string | null): value is Locale {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function detectLocale(): Locale {
  // Por defecto español (alineado con la maqueta). Si el usuario ya eligió un idioma, se
  // respeta esa elección persistida. La UI es multi-idioma y conmutable en cualquier momento.
  const saved = localStorage.getItem('locale');
  return isSupported(saved) ? saved : 'es';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'es',
  messages: { es, en },
});

/** Cambia el idioma, lo persiste y actualiza el atributo lang del documento. */
export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  localStorage.setItem('locale', locale);
  document.documentElement.setAttribute('lang', locale);
}

/** Aplica el idioma detectado al atributo lang en el arranque. */
export function initLocaleAttr(): void {
  document.documentElement.setAttribute('lang', i18n.global.locale.value);
}
