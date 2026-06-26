/** @type {import('tailwindcss').Config} */
import typography from '@tailwindcss/typography';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,ts,js}'],
  theme: {
    extend: {},
  },
  // `prose` (typography) lo usan el render del body de emails (InboxView) y el editor TipTap;
  // sin el plugin esas clases eran no-ops y el contenido salía sin estilo tipográfico.
  plugins: [typography],
};
