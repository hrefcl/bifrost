/**
 * Set de iconos de Bifrost, renderizado con **FontAwesome Pro duotone** (una sola línea gráfica
 * coherente). Extraído del SFC `AppIcon.vue` a un módulo puro para poder testear el mapeo y el
 * render en el entorno `node` de vitest (un `.vue` con `<script setup>` no es importable ahí).
 *
 * CSP: `config.autoAddCss = false` evita que svg-core inyecte un `<style>` en `<head>` (lo bloquearía
 * `style-src 'self'`); el CSS mínimo (tamaño + opacidad duotone) vive en el `<style scoped>` de AppIcon.
 */
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
// Lo desactivamos y proveemos el CSS necesario en AppIcon (scoped). Idempotente.
config.autoAddCss = false;

// Mapa nombre-lógico → icono duotone. Las claves son la API pública estable del set anterior
// (lucide): un `<AppIcon name="…" />` existente no se rompe si no cambian estas claves.
export const ICONS = {
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

/**
 * Markup SVG duotone para un nombre. `ICONS[name]` es siempre una IconDefinition válida (unión
 * cerrada) → `icon()` no es nulo. Se inyecta con `v-html` en AppIcon (markup estático, sin dato
 * de usuario → seguro).
 */
export function renderIconHtml(name: IconName): string {
  return icon(ICONS[name]).html[0];
}
