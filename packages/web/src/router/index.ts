import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
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
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/views/AdminView.vue'),
      meta: { requiresAdmin: true },
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
  return true;
});

export default router;
