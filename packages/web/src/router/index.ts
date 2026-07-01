import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useComplianceStore } from '@/stores/compliance';
import LoginView from '@/views/LoginView.vue';
import InboxView from '@/views/InboxView.vue';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { public: true },
    },
    {
      path: '/',
      name: 'inbox',
      component: InboxView,
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
    {
      path: '/contacts',
      name: 'contacts',
      component: () => import('@/views/ContactsView.vue'),
    },
    {
      path: '/calendar',
      name: 'calendar',
      component: () => import('@/views/CalendarView.vue'),
    },
    {
      path: '/scheduling',
      name: 'scheduling',
      component: () => import('@/views/SchedulingView.vue'),
    },
    // Home AUTENTICADO de Bifrost Meet: crear una reunión instantánea o unirse por link/código. La sala en
    // sí vive en `/meet/:slug` (MeetJoinView, guestOk) — este `/meet` sin slug es el punto de entrada del
    // webmail que faltaba (no había botón para crear/entrar a llamadas).
    {
      path: '/meet',
      name: 'meet-home',
      component: () => import('@/views/MeetHomeView.vue'),
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/views/AdminView.vue'),
      meta: { requiresAdmin: true },
    },
    {
      path: '/compliance/accept',
      name: 'compliance-gate',
      component: () => import('@/views/ComplianceGateView.vue'),
    },
    // ── Páginas PÚBLICAS de agenda (invitados externos; también accesibles logueado para previsualizar) ──
    {
      path: '/u/:userSlug',
      name: 'public-profile',
      component: () => import('@/views/public/PublicProfileView.vue'),
      meta: { guestOk: true },
    },
    // Sala de Bifrost Meet (videollamada). El slug es de la MeetRoom (no un userSlug): el `meetUrl`
    // horneado en las reservas es `${publicBaseUrl}/meet/<slug>`. Antes este path era un alias del perfil
    // de agenda; se re-mapeó porque los perfiles ya viven en `/u/:userSlug` (review L5).
    {
      path: '/meet/:slug',
      name: 'public-meet-room',
      component: () => import('@/views/public/MeetJoinView.vue'),
      meta: { guestOk: true },
    },
    {
      path: '/u/:userSlug/:eventSlug',
      name: 'public-book',
      component: () => import('@/views/public/PublicBookingView.vue'),
      meta: { guestOk: true },
    },
    {
      path: '/booking/:token',
      name: 'public-manage',
      component: () => import('@/views/public/PublicManageView.vue'),
      meta: { guestOk: true },
    },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  // `guestOk`: páginas públicas de agenda accesibles por invitados Y por usuarios logueados (sin
  // redirigir al inbox — review B: separar 'public' de 'guestOk').
  if (to.meta.guestOk) return true;
  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login' };
  }
  if (to.meta.public && auth.isAuthenticated) {
    return { name: 'inbox' };
  }
  // Gate de admin en el cliente (defensa en UX; el backend re-valida rol en cada endpoint).
  if (to.meta.requiresAdmin && auth.user?.role !== 'admin') {
    return { name: 'inbox' };
  }
  // Gate de compliance (UX; el backend es la autoridad real vía 403 COMPLIANCE_REQUIRED).
  // - block_full: se FUERZA la pantalla de aceptación (no se puede usar nada hasta aceptar).
  // - block_partial: NO se fuerza (el user puede leer/navegar), pero el interceptor lo lleva al gate
  //   ante un 403 de write; ahí debe poder QUEDARSE para aceptar. Por eso sólo se expulsa del gate
  //   cuando NO queda ningún pendiente bloqueante (full o partial) — sin esto, block_partial rebotaba (B P4).
  if (auth.isAuthenticated) {
    const compliance = useComplianceStore();
    const hasBlocking = compliance.blockFull || compliance.blockPartial;
    if (compliance.blockFull && to.name !== 'compliance-gate') {
      return { name: 'compliance-gate' };
    }
    if (to.name === 'compliance-gate' && !hasBlocking) {
      return { name: 'inbox' };
    }
  }
  return true;
});

export default router;
