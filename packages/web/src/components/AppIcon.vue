<script setup lang="ts">
/**
 * Set de iconos de Bifrost — renderizado con **FontAwesome Pro duotone** para una sola línea
 * gráfica coherente en toda la app. La API pública (`name`, `size`) se mantiene 1:1 con el set
 * anterior (lucide, trazo), así que ningún consumidor `<AppIcon name="inbox" />` cambia: sólo
 * cambia el glifo a duotone.
 *
 * CSP: `config.autoAddCss = false` evita que svg-core inyecte un <style> en <head> (lo bloquearía
 * `style-src 'self'`); el CSS mínimo (tamaño + opacidad duotone) vive en el <style scoped> de abajo.
 * `v-html` es seguro: el markup lo produce `icon()` sobre definiciones estáticas del bundle (sin
 * dato de usuario) — igual que el literal SVG estático del set previo.
 */
import { computed } from 'vue';
import { icon, config, type IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faBars,
  faMagnifyingGlass,
  faGear,
  faInbox,
  faStar,
  faClock,
  faPaperPlane,
  faFile,
  faBoxArchive,
  faShieldHalved,
  faTrashCan,
  faReply,
  faReplyAll,
  faShare,
  faEllipsisVertical,
  faLocationDot,
  faPaperclip,
  faXmark,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faPlus,
  faPen,
  faCalendarDays,
  faTag,
  faArrowsRotate,
  faMoon,
  faSun,
  faCircleQuestion,
  faGrid,
  faBell,
  faCheck,
  faDownload,
  faFilter,
  faUser,
  faUsers,
  faLock,
  faGlobe,
  faEnvelope,
  faArrowLeft,
  faPrint,
  faArrowRightFromBracket,
  faCircle,
  faPalette,
  faDatabase,
  faBriefcase,
  faCopy,
  faArrowUpRightFromSquare,
  faArrowRight,
  faBuilding,
  faSliders,
  faVideo,
  faPhone,
  faImage,
  faUpload,
  faEye,
  faCalendarClock,
  faList,
  faLink,
} from '@fortawesome/pro-duotone-svg-icons';

// svg-core inyectaría su CSS en <head> vía <style> → la CSP (style-src 'self') lo bloquearía.
// Lo desactivamos y proveemos el CSS necesario nosotros (abajo, scoped). Idempotente.
config.autoAddCss = false;

// Mapa nombre-lógico → icono duotone. Mismas claves que el set anterior: la unión cerrada
// `IconName` no cambia, así ningún `<AppIcon name="…" />` existente se rompe.
const ICONS = {
  menu: faBars,
  search: faMagnifyingGlass,
  settings: faGear,
  inbox: faInbox,
  star: faStar,
  clock: faClock,
  send: faPaperPlane,
  file: faFile,
  archive: faBoxArchive,
  shield: faShieldHalved,
  trash: faTrashCan,
  reply: faReply,
  replyAll: faReplyAll,
  forward: faShare,
  more: faEllipsisVertical,
  mapPin: faLocationDot,
  paperclip: faPaperclip,
  x: faXmark,
  chevronDown: faChevronDown,
  chevronLeft: faChevronLeft,
  chevronRight: faChevronRight,
  plus: faPlus,
  pencil: faPen,
  calendar: faCalendarDays,
  tag: faTag,
  refresh: faArrowsRotate,
  moon: faMoon,
  sun: faSun,
  help: faCircleQuestion,
  grid: faGrid,
  bell: faBell,
  check: faCheck,
  download: faDownload,
  filter: faFilter,
  user: faUser,
  users: faUsers,
  lock: faLock,
  globe: faGlobe,
  mail: faEnvelope,
  arrowLeft: faArrowLeft,
  printer: faPrint,
  logout: faArrowRightFromBracket,
  dot: faCircle,
  palette: faPalette,
  database: faDatabase,
  briefcase: faBriefcase,
  copy: faCopy,
  externalLink: faArrowUpRightFromSquare,
  arrowRight: faArrowRight,
  building: faBuilding,
  sliders: faSliders,
  video: faVideo,
  phone: faPhone,
  image: faImage,
  upload: faUpload,
  eye: faEye,
  calendarClock: faCalendarClock,
  list: faList,
  link: faLink,
} as const satisfies Record<string, IconDefinition>;

/** Nombres válidos de icono (unión cerrada del mapa). El nuevo código debe usar este tipo. */
export type IconName = keyof typeof ICONS;

const props = withDefaults(
  defineProps<{
    // Unión CERRADA de nombres válidos: impide pasar datos dinámicos/usuario al render.
    name: IconName;
    size?: number;
    // Compat con el set anterior (lucide, trazo). Duotone es relleno → estos props son no-ops;
    // se conservan para no romper llamadas existentes que los pasaban.
    strokeWidth?: number;
    fill?: string;
  }>(),
  { size: 20, strokeWidth: 2, fill: 'none' }
);

// `icon()` acepta la definición directa (sin registrar library) y devuelve el markup duotone.
// `ICONS[name]` es siempre una IconDefinition válida (unión cerrada) → `icon()` no es nulo.
const html = computed(() => icon(ICONS[props.name]).html[0]);
</script>

<template>
  <!-- v-html: markup producido por `icon()` sobre defs estáticas del bundle → seguro. -->
  <!-- eslint-disable vue/no-v-html -->
  <span class="app-icon" :style="{ fontSize: `${size}px` }" aria-hidden="true" v-html="html" />
  <!-- eslint-enable vue/no-v-html -->
</template>

<style scoped>
.app-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  flex-shrink: 0;
}
/* CSS mínimo de FA (no importamos su hoja por CSP). El SVG escala con el font-size del wrapper;
   height:1em + width:auto preserva el aspect-ratio del viewBox de cada icono. */
.app-icon :deep(svg) {
  height: 1em;
  width: auto;
  display: block;
  fill: currentColor;
  overflow: visible;
}
/* Efecto duotone: capa secundaria atenuada, primaria plena. Ambas heredan currentColor → el icono
   se adapta a su contexto (sidebar, botón sobre acento, badges, etc.). */
.app-icon :deep(.fa-secondary) {
  opacity: 0.4;
}
.app-icon :deep(.fa-primary) {
  opacity: 1;
}
</style>
