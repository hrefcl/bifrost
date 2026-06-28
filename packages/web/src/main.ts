import { createApp } from 'vue';
import { createPinia } from 'pinia';
import axios from 'axios';
import App from './App.vue';
import router from './router';
import SetupWizard from './views/SetupWizard.vue';
import { i18n, initLocaleAttr } from './i18n';
import { applyBrand, loadRemoteBrand } from './config/brand';
import './assets/main.css';

async function bootstrap() {
  // Marca (white-label) + idioma: aplicar antes de montar para evitar parpadeo.
  applyBrand();
  initLocaleAttr();
  // Branding de runtime del admin (nombre/logo/color de empresa). Pisa el default por env. Se
  // awaitea antes de montar para no mostrar la marca por defecto y luego "saltar" a la de empresa.
  await loadRemoteBrand();

  try {
    const { data } = await axios.get<{ setupRequired: boolean }>('/api/setup/status');
    if (data.setupRequired) {
      createApp(SetupWizard).use(i18n).mount('#app');
      return;
    }
  } catch {
    // If setup endpoint is unavailable, proceed with normal app
  }

  const app = createApp(App);
  const pinia = createPinia();
  app.use(pinia);
  app.use(i18n);
  // Restaurar sesión ANTES de instalar el router: Vue Router dispara la navegación
  // inicial al instalarse y el guard leería isAuthenticated=false → /login aunque la
  // cookie de refresh sea válida. Restaurar primero evita ese falso logout en reload.
  const { useAuthStore } = await import('./stores/auth');
  await useAuthStore(pinia).restore();
  app.use(router);
  app.mount('#app');
}

void bootstrap();
