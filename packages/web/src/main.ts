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
  const { useComplianceStore } = await import('./stores/compliance');
  const { api } = await import('./lib/http');

  // Restaurar sesión ANTES de instalar el router (ver nota arriba sobre el falso logout en reload).
  const { useAuthStore } = await import('./stores/auth');
  const restored = await useAuthStore(pinia).restore();
  // Hidratar el estado de compliance (pendientes) tras restaurar la sesión. (Las rutas de auth/compliance
  // usadas en restore/hidratación son skipCompliance/públicas → NO disparan el 403 del gate.)
  if (restored) await useComplianceStore(pinia).fetchPending();

  app.use(router);

  // Interceptor de compliance: un 403 COMPLIANCE_REQUIRED del gate del backend marca los pendientes y
  // redirige al gate. Se registra DESPUÉS de `app.use(router)` para que `router.push` opere sobre un
  // router YA instalado (D-005). El backend es la autoridad; esto es la reacción UX.
  api.interceptors.response.use(
    (r) => r,
    (err: { response?: { status?: number; data?: { code?: string; pending?: unknown } } }) => {
      const res = err.response;
      if (res?.status === 403 && res.data?.code === 'COMPLIANCE_REQUIRED') {
        useComplianceStore(pinia).markRequired(
          Array.isArray(res.data.pending) ? (res.data.pending as never[]) : undefined
        );
        if (router.currentRoute.value.name !== 'compliance-gate') {
          router.push({ name: 'compliance-gate' }).catch(() => {
            /* navegación cancelada/duplicada: irrelevante (D-007) */
          });
        }
      }
      return Promise.reject(err instanceof Error ? err : new Error('Request failed'));
    }
  );

  app.mount('#app');
}

void bootstrap();
