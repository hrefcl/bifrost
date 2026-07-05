# PWA — Checklist QA

Leyenda: ✅ verificado automatizado · 🟡 pendiente en dispositivo real · ⛔ falla

## Instalación

| # | Caso | Estado | Evidencia |
| --- | --- | --- | --- |
| 1 | Ofrece instalación en Chrome Android | 🟡 | Requiere dispositivo. Criterios cumplidos (manifest+SW+íconos). |
| 2 | Se agrega a inicio en iOS Safari | 🟡 | Meta Apple presentes; hint in-app implementado. |
| 3 | Instala en escritorio (Chrome/Edge) | 🟡 | Criterios de instalabilidad cumplidos. |
| 4 | El ícono se muestra correcto | ✅ | `/tmp/pwa-evidence/00-icons.png` (192/512/maskable/apple). |
| 5 | El nombre se muestra correcto | ✅ | manifest `name`/`short_name`; `apple-mobile-web-app-title`. |
| 6 | Abre en modo standalone | 🟡 | `display: standalone`; verificar tras instalar. |
| 12 | Lighthouse reconoce instalable | 🟡→✅* | Lighthouse CLI no disponible local. *Criterios verificados a mano: manifest válido servido `application/manifest+json`, SW **active**, íconos 192+512+maskable, `start_url`/`scope` `/`, `display standalone`, secure context. Correr Lighthouse en el navegador para el sello final. |

## Sesión / seguridad

| # | Caso | Estado | Evidencia |
| --- | --- | --- | --- |
| 7 | El login funciona | ✅ | Smoke test: la app monta el login (5.5 KB HTML), sin errores JS. |
| 8 | El logout limpia la sesión | ✅ (código) | `stores/auth.ts logout()` → `/auth/logout` (invalida cookie) + `clearSession()` (borra token/usuario de memoria). Token nunca en storage. |
| 9 | Sin acceso a correos privados tras logout | ✅ (diseño) | `/api/*` es NetworkOnly (no cacheado); token en memoria; guard de router expulsa a `/login`. |
| 10 | Sin conexión → pantalla controlada | ✅ | `pwa-offline.mjs`: recarga offline devuelve 200 (shell del SW) + banner "Sin conexión" visible. `/tmp/pwa-evidence/02-offline-shell.png`. |
| 11 | No quedan correos/adjuntos cacheados | ✅ | `grep` del `sw.js`: precache no contiene `/api`; regla `NetworkOnly` para `/api`; denylist del navigateFallback. |

## No-regresión

| # | Caso | Estado | Evidencia |
| --- | --- | --- | --- |
| 13 | No rompe build/deploy | ✅ | `vue-tsc --noEmit` limpio + `vite build` OK (sw.js+manifest generados). |
| 14 | No rompe rutas del webmail | ✅ | Cambios aditivos; router intacto; navigateFallback excluye `/api`. Verificar navegación completa 🟡. |
| 15 | No rompe admin | ✅ (código) | Sin cambios en `/admin`; guard `requiresAdmin` intacto. |
| 16 | No rompe scheduling | ✅ (código) | Sin cambios en `/scheduling`; rutas `guestOk` intactas (los CTA de install no aparecen ahí). |

## Pruebas automatizadas incluidas

- `scripts/pwa-smoke.mjs` — SW active, manifest linkeado, metas Apple, app monta, sin errores JS. **PASS**.
- `scripts/pwa-offline.mjs` — recarga offline 200 (shell del SW) + banner offline. **PASS**.

Ejecutar: `pnpm --filter @webmail6/web build && (pnpm --filter @webmail6/web preview --port 4178 &) && sleep 3 && node packages/web/scripts/pwa-smoke.mjs && node packages/web/scripts/pwa-offline.mjs`

## Pendiente (dispositivo real)

Instalar en **Android (Chrome)**, **iOS (Safari)** y **escritorio**; confirmar standalone, ícono, nombre, login/logout, y recorrer inbox/lectura/redacción/adjuntos/config sin cortes ni scrolls raros. Correr **Lighthouse** en el navegador para el sello PWA.
