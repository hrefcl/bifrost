<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore, type ListFilter } from '@/stores/ui';
import { useComposerStore } from '@/stores/composer';
import { SUPPORTED_LOCALES, LOCALE_NAMES, setLocale, type Locale } from '@/i18n';
import AppLogo from '@/components/AppLogo.vue';
import AppIcon from '@/components/AppIcon.vue';
import AppAvatar from '@/components/AppAvatar.vue';
import ComposerWindow from '@/components/ComposerWindow.vue';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const settings = useSettingsStore();
const ui = useUiStore();
const composer = useComposerStore();
const { t, locale } = useI18n();

const searchFocused = ref(false);
const menuOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);

// Embudo de filtro del TopBar: aplica el filtro rápido de la lista (compartido con el Inbox vía
// el store ui). Antes el botón no hacía nada.
const filterMenuOpen = ref(false);
const TOPNAV_FILTERS: { key: ListFilter; label: string; icon: string }[] = [
  { key: 'all', label: 'list.filterAll', icon: 'mail' },
  { key: 'unread', label: 'list.filterUnread', icon: 'dot' },
  { key: 'starred', label: 'list.filterStarred', icon: 'star' },
  { key: 'attachments', label: 'list.filterAttachments', icon: 'paperclip' },
];
function pickFilter(f: ListFilter) {
  ui.setListFilter(f);
  filterMenuOpen.value = false;
  // Si no estamos en el inbox, ir allí para que el filtro sea visible.
  if (route.name !== 'inbox') void router.push({ name: 'inbox' });
}

// Atajo "/" (desde el Inbox): enfocar la barra de búsqueda.
watch(
  () => ui.searchFocusNonce,
  () => searchInput.value?.focus()
);

function toggleTheme() {
  settings.setTheme(settings.theme === 'dark' ? 'light' : 'dark');
}
function pickLocale(l: Locale) {
  setLocale(l);
}
function isActive(name: string) {
  return route.name === name;
}

// Logout: revoca la sesión en backend + limpia el token, cierra el menú y SIEMPRE redirige
// a login. El push va en `finally` para volver al login aunque el POST /auth/logout falle
// (la sesión local igual quedó limpia → quedarse en una vista protegida sería un estado roto).
async function onLogout() {
  menuOpen.value = false;
  try {
    await auth.logout();
  } finally {
    await router.push({ name: 'login' });
  }
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <button class="icon-btn" :title="t('nav.menu')" @click="ui.toggleSidebar()">
        <AppIcon name="menu" :size="20" />
      </button>
      <div class="logo-slot" @click="router.push({ name: 'inbox' })">
        <AppLogo :size="30" />
      </div>

      <div class="search-area">
        <form
          class="search"
          :class="{ focused: searchFocused }"
          @submit.prevent="ui.submitSearch()"
        >
          <AppIcon name="search" :size="19" class="search-icon" />
          <input
            ref="searchInput"
            v-model="ui.searchQuery"
            class="search-input"
            :placeholder="t('common.search')"
            @focus="searchFocused = true"
            @blur="searchFocused = false"
          />
          <button
            v-if="ui.searchQuery"
            type="button"
            class="icon-btn sm"
            :title="t('common.clear')"
            @click="ui.searchQuery = ''"
          >
            <AppIcon name="x" :size="17" />
          </button>
          <div class="filter-wrap">
            <button
              type="button"
              class="icon-btn sm"
              :class="{ on: ui.listFilter !== 'all' }"
              :title="t('nav.advancedSearch')"
              @click.stop="filterMenuOpen = !filterMenuOpen"
            >
              <AppIcon name="filter" :size="17" />
            </button>
            <div v-if="filterMenuOpen" class="filter-backdrop" @click="filterMenuOpen = false" />
            <div v-if="filterMenuOpen" class="filter-menu" @click.stop>
              <button
                v-for="f in TOPNAV_FILTERS"
                :key="f.key"
                type="button"
                class="filter-item"
                :class="{ sel: ui.listFilter === f.key }"
                @click="pickFilter(f.key)"
              >
                <AppIcon :name="f.icon" :size="16" />
                <span>{{ t(f.label) }}</span>
                <AppIcon v-if="ui.listFilter === f.key" name="check" :size="15" class="fi-check" />
              </button>
            </div>
          </div>
        </form>
      </div>

      <button
        class="icon-btn"
        :title="settings.theme === 'dark' ? t('nav.lightMode') : t('nav.darkMode')"
        @click="toggleTheme"
      >
        <AppIcon :name="settings.theme === 'dark' ? 'sun' : 'moon'" :size="20" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: isActive('calendar') }"
        :title="t('nav.calendar')"
        @click="router.push({ name: 'calendar' })"
      >
        <AppIcon name="calendar" :size="20" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: isActive('scheduling') }"
        :title="t('nav.scheduling')"
        @click="router.push({ name: 'scheduling' })"
      >
        <AppIcon name="users" :size="20" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: isActive('contacts') }"
        :title="t('nav.contacts')"
        @click="router.push({ name: 'contacts' })"
      >
        <AppIcon name="users" :size="20" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: isActive('settings') }"
        :title="t('nav.settings')"
        @click="router.push({ name: 'settings' })"
      >
        <AppIcon name="settings" :size="20" />
      </button>
      <button
        v-if="auth.user?.role === 'admin'"
        class="icon-btn"
        :class="{ active: isActive('admin') }"
        :title="t('nav.admin')"
        @click="router.push({ name: 'admin' })"
      >
        <AppIcon name="shield" :size="20" />
      </button>

      <div class="avatar-menu">
        <button class="avatar-btn" @click="menuOpen = !menuOpen">
          <AppAvatar :name="auth.user?.displayName" :email="auth.user?.primaryEmail" :size="34" />
        </button>
        <div v-if="menuOpen" class="menu-backdrop" @click="menuOpen = false" />
        <div v-if="menuOpen" class="menu">
          <div class="menu-id">
            <AppAvatar :name="auth.user?.displayName" :email="auth.user?.primaryEmail" :size="40" />
            <div class="menu-id-text">
              <div class="menu-name">{{ auth.user?.displayName || auth.user?.primaryEmail }}</div>
              <div class="menu-email">{{ auth.user?.primaryEmail }}</div>
            </div>
          </div>
          <div class="menu-sep" />
          <div class="menu-section">{{ t('nav.language') }}</div>
          <button v-for="l in SUPPORTED_LOCALES" :key="l" class="menu-item" @click="pickLocale(l)">
            <AppIcon name="globe" :size="17" />
            <span>{{ LOCALE_NAMES[l] }}</span>
            <AppIcon v-if="locale === l" name="check" :size="16" class="menu-check" />
          </button>
          <div class="menu-sep" />
          <button class="menu-item danger" @click="onLogout()">
            <AppIcon name="logout" :size="17" />
            <span>{{ t('nav.logout') }}</span>
          </button>
        </div>
      </div>
    </header>

    <main class="main"><slot /></main>

    <!-- Composer flotante estilo Gmail: overlay sobre cualquier vista, minimizable. -->
    <ComposerWindow v-if="composer.open" :key="composer.instanceKey" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
}
.topbar {
  height: 60px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  z-index: 40;
}
.logo-slot {
  cursor: pointer;
}
.search-area {
  flex: 1;
  max-width: 700px;
  margin: 0 auto;
}
.search {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 8px 0 16px;
  border-radius: 24px;
  background: var(--search-bg);
  border: 1px solid transparent;
  transition: all 0.14s;
}
.search.focused {
  border-radius: 14px;
  background: var(--surface);
  border-color: var(--accent);
  box-shadow: var(--shadow-md);
}
.search-icon {
  color: var(--text-3);
}
.search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 14.5px;
  color: var(--text-1);
}
.icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-2);
  transition:
    background 0.12s,
    color 0.12s;
}
.icon-btn.sm {
  width: 32px;
  height: 32px;
}
.icon-btn:hover {
  background: var(--hover);
}
.icon-btn.active {
  color: var(--accent);
}
.icon-btn.on {
  color: var(--accent);
}
.filter-wrap {
  position: relative;
  display: inline-flex;
}
.filter-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
}
.filter-menu {
  position: absolute;
  top: 115%;
  right: 0;
  z-index: 60;
  min-width: 190px;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
}
.filter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-1);
  text-align: left;
}
.filter-item:hover {
  background: var(--hover);
}
.filter-item.sel {
  color: var(--accent);
  font-weight: 600;
}
.fi-check {
  margin-left: auto;
  color: var(--accent);
}
.avatar-menu {
  position: relative;
  margin-left: 4px;
}
.avatar-btn {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  display: flex;
}
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
}
.menu {
  position: absolute;
  top: 46px;
  right: 0;
  width: 256px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  padding: 8px;
  z-index: 60;
}
.menu-id {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 8px 10px;
}
.menu-id-text {
  min-width: 0;
}
.menu-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-1);
}
.menu-email {
  font-size: 12.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu-sep {
  height: 1px;
  background: var(--border);
  margin: 6px 0;
}
.menu-section {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 4px 10px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  background: transparent;
  border-radius: 9px;
  cursor: pointer;
  font: inherit;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-1);
  text-align: left;
}
.menu-item:hover {
  background: var(--hover);
}
.menu-item.danger {
  color: var(--danger);
}
.menu-check {
  margin-left: auto;
  color: var(--accent);
}
.main {
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
</style>
