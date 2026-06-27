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
      path: '/compose',
      name: 'compose-new',
      component: () => import('@/views/ComposerView.vue'),
    },
    {
      path: '/compose/:draftId',
      name: 'compose',
      component: () => import('@/views/ComposerView.vue'),
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
      path: '/admin',
      name: 'admin',
      component: () => import('@/views/AdminView.vue'),
      meta: { requiresAdmin: true },
    },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
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
