import { createApp } from 'vue';
import { createPinia } from 'pinia';
import axios from 'axios';
import App from './App.vue';
import router from './router';
import SetupWizard from './views/SetupWizard.vue';
import './assets/main.css';

async function bootstrap() {
  try {
    const { data } = await axios.get<{ setupRequired: boolean }>('/api/setup/status');
    if (data.setupRequired) {
      createApp(SetupWizard).mount('#app');
      return;
    }
  } catch {
    // If setup endpoint is unavailable, proceed with normal app
  }

  const app = createApp(App);
  const pinia = createPinia();
  app.use(pinia);
  // Restaurar sesión ANTES de instalar el router: Vue Router dispara la navegación
  // inicial al instalarse y el guard leería isAuthenticated=false → /login aunque la
  // cookie de refresh sea válida. Restaurar primero evita ese falso logout en reload.
  const { useAuthStore } = await import('./stores/auth');
  await useAuthStore(pinia).restore();
  app.use(router);
  app.mount('#app');
}

void bootstrap();
