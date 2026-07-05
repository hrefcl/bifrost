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

## Ronda 4 — Auto-auditoría (cron) del Equipo A

Re-auditoría en 3 rondas tras el APPROVE. Hallazgos accionados:

| # | Ronda | Hallazgo | Acción |
| --- | --- | --- | --- |
| A1 | QA | Los smoke/offline tests corrían bajo `vite preview`, que **NO aplica la CSP de nginx** → nunca se probó el SW bajo `script-src 'self'; default-src 'self'` de producción. | **Cerrado:** `scripts/serve-with-csp.mjs` replica la CSP exacta; smoke+offline **PASS** bajo esa CSP (SW active, sin errores). |
| A2 | hostil | El manifest hardcodeaba `theme_color`/`name` en la marca base Bifrost, ignorando el white-label build-time `VITE_BRAND_ACCENT`/`VITE_BRAND_NAME` (misión existencial). | **Cerrado:** manifest + metas Apple leen el env (verificado: tenant `Acme`/`#d81b60` propaga). Íconos siguen requiriendo regeneración (documentado). |
| A3 | 3AM | Sin kill-switch remoto del SW; sin chequeo periódico de update en sesión SPA larga; iOS evicta storage ~7 días. | **Documentado** en 02-README (limitaciones/ops). No bloqueante: diseño `prompt` sin `clientsClaim` evita zombies; `index.html` no-cache detecta update al recargar. |

Confirmados sin issue en la re-auditoría: `/api` fuera de todo cache (re-verificado en `dist/sw.js`), token sólo en memoria, logout limpia siempre, rutas webmail/admin/scheduling/guestOk intactas, registro de SW idempotente (`initialized` guard), banners mutuamente excluyentes.

### Review del delta white-label (vite.config.ts)

| ID | Sev | Descripción | Resolución |
| --- | --- | --- | --- |
| C1 / D-001 | HIGH (inyección) | `BRAND_NAME` (env del operador) sin escapar en `transformIndexHtml` → attribute breakout. | HTML-escape `& " < >` antes de interpolar. Verificado con `AT&T <Mail> "Pro"`. |
| C3 / D-002 | MED | String-replace literal frágil (no-op silencioso si se reformatea `index.html`). | Regex tolerante `/(<meta name="…" content=")[^"]*(")/`. |
| C2 | LOW | `slice(45)` partía pares suplentes UTF-16 (emoji). | Slice por code points `[...s]`. Verificado con `🚀 Rocket Mail`. |
| D-003 | MED | `short_name` hasta 45 (Chrome recomienda ≤12). | `BRAND_SHORT = [...BRAND_NAME].slice(0,12)`. |
| C4 / D-004 | LOW | Fail-soft sin log (convención del proyecto: con log). | `console.warn` si `VITE_BRAND_ACCENT` no es hex. |
| D-005 | LOW | `name` puede llegar a 51 code points (Chrome recomienda ≤42). | **Aceptado** (recomendación, no bug; plataformas truncan; brand names reales son cortos). |
| B-$ | MED | El `BRAND_NAME` escapado fluía como replacement string en `String.replace` → un `$` (`$1`,`$$`,`$&`) se interpretaba como patrón (C y D no lo vieron). | **Replacer callback** (no string) → `$` sale literal. Verificado con `Pay$1$$ Mail`. |

**Scores finales del delta:** B (Codex) **9/10 APPROVE** · C (z.ai) **9/10 APPROVE** · D (Kimi) **10/10 APROBADO**. Sin HIGH abierto. Residual menor (regex asume orden `name` antes de `content`) — no bloqueante, `index.html` versionado.
