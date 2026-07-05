# PWA — Log de revisión multi-equipo

**Equipo A:** Claude Code · Cadena de autoridad: **B → D** (F excluido por REGLA 0.1; A=Claude).
**Revisores:** B=Codex, C=z.ai GLM (`z`), D=Kimi.

## Ronda 1

| Equipo | Score | Veredicto |
| --- | --- | --- |
| B (Codex) | 6/10 | NOT APPROVE (2 HIGH) |
| D (Kimi) | 8/10 | APPROVE con fixes pedidos |
| C (z.ai) | — | TEAM_UNAVAILABLE (conflicto `ANTHROPIC_API_KEY` en el bin `z`) |

### Findings y resolución

| ID | Sev | Descripción | Resolución |
| --- | --- | --- | --- |
| B-H1 / D-001 | HIGH | `skipWaiting: true` + `clientsClaim: true` contradicen `registerType: 'prompt'` → el SW nuevo tomaba control de tabs abiertas, arriesgando shell viejo vs precache nuevo y romper una redacción en curso. | Quitados ambos de `workbox`. Ahora `skipWaiting()` sólo se dispara al recibir el mensaje `SKIP_WAITING` que envía `applyUpdate()` (verificado en `dist/sw.js`). |
| B-H2 | HIGH | `logout()` sólo limpiaba memoria si el `POST /auth/logout` tenía éxito; offline (NetworkOnly) dejaba `accessToken`/`user`/`Authorization` vivos. | `clearSession()` movido a `finally` en `stores/auth.ts`. |
| B-MED | MEDIUM | `navigateFallbackDenylist: [/^\/api\//]` no cubría `/api` exacto ni `/api?…`. | Regex `/^\/api(?:\/|$|\?)/` y `/^\/metrics(?:\/|$|\?)/`; `NetworkOnly` matchea `/api` exacto y `/api/`. |
| D-002 | MED | Código muerto: `offlineReady` expuesto sin uso; clave i18n `pwa.ios.body` sin uso. | `offlineReady` quitado del API (queda `console.info` de observabilidad); `pwa.ios.body` eliminado de `es`/`en`. |
| D-003 | MED | Banners de instalación visibles sin conexión (instalación podía fallar). | `showInstallBanner`/`showIosHint` exigen `online`. |
| D-005 | LOW | `useOnline()` en scope de módulo (frágil sin DOM). | Guardado: `typeof window !== 'undefined' ? useOnline() : ref(true)`. |
| D-008 | LOW | Detección de iPadOS por `'ontouchend'` daba falsos positivos. | Ahora exige `navigator.maxTouchPoints > 1`. |
| D-009 | LOW | `promptInstall` sin `try/catch`. | Envuelto en `try/catch/finally`. |
| D-006 | LOW | `orientation: 'portrait'` forzado. | `orientation: 'any'`. |
| B-LOW | LOW | Precache de todos los chunks (admin/scheduling/públicos) para todo usuario. | **Aceptado (tech debt):** no es fuga de datos (chunks públicos del bundle); se documenta como follow-up de tamaño de precache. |
| D-004 | MED→acept. | Logout no limpia el flag `pwa:install-dismissed` (dispositivo compartido: el 2º usuario no ve el banner). | **Aceptado:** flag no sensible; sin datos privados en cache. Follow-up UX opcional. |
| D-007 | LOW | `manifest.lang` fijo `es`. | **Aceptado:** el manifest es estático; `es` es la marca base. |

### Regresión detectada por A (auto-auditoría) y corregida

- El banner offline `position: fixed; top:0` tapaba el `topbar` (flujo normal, no fixed) en `AppLayout`. Fix: `--pwa-top-inset` (0px online → comportamiento idéntico) consumido por `.shell` y `.pub`; el banner mide su alto real (incluye safe-area).

## Ronda 2 (validación de fixes)

| Equipo | Score | Veredicto |
| --- | --- | --- |
| D (Kimi) | 9/10 | **APPROVE** — D-001/002/003/005/008/009 verificados cerrados en fuente. |
| C (z.ai) | — | **APPROVE** — modelo shared-device correcto; 3 MED + 6 LOW (abajo). |
| B (Codex) | 8/10 | NOT APPROVE por 1 MED (logout offline seguía rechazando → ComplianceGateView no redirigía). **Resuelto tras B2** (ver ronda 3). |

### Findings ronda 2 y resolución

| ID | Sev | Descripción | Resolución |
| --- | --- | --- | --- |
| B2-MED | MED | `logout()` seguía **rechazando** si el POST fallaba offline; `ComplianceGateView` (sin `finally`) no llegaba al redirect → vista privada montada. | `logout()` ahora **no rechaza**: `try{POST}catch{}finally{clearSession}`. Ambos callers redirigen. |
| C-MED-1 | MED | `applyUpdate` bajaba `needRefresh` optimista; si la activación fallaba, el toast desaparecía sin reintento. | `try/catch`: en fallo se re-arma `needRefresh=true`. |
| C-MED-2 | MED | `--pwa-top-inset` se medía una vez; al wrappear/rotar el banner tapaba el topbar. | `ResizeObserver` sobre el banner re-mide el inset. |
| C-LOW-1 | LOW | `PublicLayout` no restaba el inset del `min-height` (scroll extra offline). | `min-height: calc(100vh - var(--pwa-top-inset))`. |
| C-LOW-4 | LOW | Doble-click en Install / descarte en `'unavailable'`. | Guard `installing` + botón `:disabled` + descartar sólo en `'dismissed'`. |
| C-LOW-5 | LOW | Denylist `/api` case-sensitive. | Flag `i` en ambos patrones. |
| D2-obs, C-LOW-2/3 | LOW | Comentario `runtimeCaching` GET; `installed` no resetea; `installDismissed` no sincroniza tabs / cross-user. | Comentario aclarado; el resto **aceptado** (no sensible / edge). |

### Tech debt registrado

```
TECH DEBT TICKET: resurrección de sesión por refresh single-flight en logout
Detectado en: 2026-07-05 (review C-MED-3)
Contexto: si un /auth/refresh single-flight está en vuelo y el usuario hace logout,
  clearSession() corre y luego el refresh compartido resuelve y reinstala accessToken/user.
Equipo: C (z.ai)
Severidad: MEDIUM
Estado: PRE-EXISTENTE (no introducido por la PWA). Fix sugerido: flag `loggingOut` que el
  commit del refresh respete, o abort del refresh en logout. Fuera de scope de esta feature.
```

## Ronda 3 (revalidación B tras logout-swallow + fixes C)

**B (Codex): 9/10 — APPROVE.** Confirmó: SW activation cerrado (`clientsClaim:0`, `skipWaiting` sólo en el handler `SKIP_WAITING`), logout offline cerrado (`logout()` no rechaza → ambos callers redirigen, sesión local limpia siempre), denylist `/api` cerrado. Sin HIGH nuevo. Único residuo: tech debt pre-existente de refresh single-flight (fuera de scope, no bloqueante).

## Scores finales

| Equipo | Score | Veredicto |
| --- | --- | --- |
| **B (Codex)** — autoridad primaria | **9/10** | ✅ APPROVE |
| **D (Kimi)** | **9/10** | ✅ APPROVE |
| **C (z.ai GLM)** | APPROVE | ✅ (ronda 2, tras destrabar el bin `z`) |

**Estado: APPROVED.** Cadena B→D (F excluido por REGLA 0.1). Sin HIGH abierto. Tech debt: 1 ticket pre-existente (refresh single-flight en logout).
