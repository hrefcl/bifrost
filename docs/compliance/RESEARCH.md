# Investigación inicial — Frameworks de Compliance en suites empresariales

Fuente: investigación web (Microsoft Entra ToU, Google Workspace, Nextcloud, Proton, Zoho,
Zimbra, Roundcube, Odoo, ERPNext, OnlyOffice, Calendly). Resumen de patrones y decisiones.

## Patrones comunes confirmados
1. Dos arquetipos: (a) **gate en la capa de identidad/auth** (Microsoft Entra ToU, Google
   onboarding, Nextcloud ToS app) — robusto; (b) consentimiento implícito por uso continuado
   (Proton, Zoho, OnlyOffice, ERPNext, Calendly) — evidencia débil. → Bifrost adopta (a).
2. Click-to-accept con timestamp = Effective Date.
3. **Inmutabilidad por reemplazo, no por edición** (Microsoft/Nextcloud prohíben editar doc vivo).
4. **Reaceptación gobernada por ciclo de sesión/token**: Microsoft documenta como su mayor caveat
   que `Require reaccept` NO expulsa sesiones vigentes hasta que el token expira. → Bifrost gana
   aquí: el gate se computa EN VIVO por request (no desde el claim del JWT), así que la
   reaceptación es **inmediata** sin invalidar sesiones.
5. Tres palancas de reaceptación: reset duro por versión / expiración periódica fija / duración
   relativa por-usuario.
6. Multi-idioma con fallback por preferencia de navegador.
7. Scope granular por usuario/grupo/rol, configurable por admin sin código.
8. **Separación registro-de-aceptación (vida del tenant) vs audit-log técnico (retención corta)**.
9. Composición: un acto de aceptación cubre varios documentos (cada uno registrado individual).
10. "Require expand/scroll-to-end" como evidencia de oportunidad de lectura.
11. **Bypass M2M obligatorio** (Nextcloud allow_path_prefix/allow_ip_ranges; Microsoft excluye
    service accounts) — sin allowlist el gate rompe integraciones.

## Decisiones adoptadas para Bifrost (derivadas, no copiadas)
- A. Gate en login/sesión, computado en vivo (ventaja: reaceptación inmediata).
- B. Versiones inmutables + **content_hash SHA-256** del cuerpo → prueba de "qué texto exacto se aceptó".
- C. Aceptación append-only separada del audit técnico; evidencia perdura por vida del tenant.
- D. **Scroll-to-end antes de habilitar Aceptar**; registrar `method: 'scroll_confirmed'`.
- E. Reaceptación honesta: gate en vivo = enforcement inmediato (sin esperar expiración de token).
- F. Multi-tenant config por admin sin código (forward-compatible, ver DESIGN §9).
- G. Consentimientos componibles como entidades separadas (cada doc su versión/hash).
- H. **Allowlist M2M obligatoria** (auth, compliance, health, metrics, branding/config).
- I. Templates por defecto marcados `system`/disclaimer; publicación activa del admin = acto auditado.
- J. Endpoint self-service "mis términos aceptados" (`/api/compliance/me/acceptances`).
- K. Evidencia grado-forense opcional: hash del documento + hash de evento (habilitado, no obligatorio PYME).

Referencia técnica más exhaustiva: Microsoft Entra "Terms of use". Mejor modelo self-hosted
clonable: Nextcloud `terms_of_service`. El resto = contraste de "lo que NO basta".
