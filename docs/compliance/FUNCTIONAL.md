# BifrostMail — Compliance Framework — Documentación Funcional

Guía funcional del módulo de Compliance: qué hace, cómo lo usa un administrador, qué experimenta un
usuario, y cómo se configura/opera. Complementa `DESIGN.md` (arquitectura) y `ARCHITECTURE.md` (diagramas).

---

## 1. Qué es

Un **framework de políticas legales configurable** para BifrostMail. Permite a cada organización
administrar sus documentos legales (Términos, Privacidad, Uso Aceptable, Cookies, Retención, Auditoría,
Seguridad y los que cree) **sin tocar código**, con:

- **Versionado inmutable**: cada cambio es una versión nueva; las publicadas nunca se editan ni borran.
- **Evidencia legal de aceptación** con HMAC (tamper-evident): usuario, fecha/hora, IP real, navegador,
  versión, hash del contenido, tenant, idioma.
- **Gate de primer acceso**: bloquea el uso del sistema hasta aceptar las políticas obligatorias.
- **Reaceptación automática** cuando se publica una versión que la exige.
- **Multi-tenant-ready** y **auditoría** de las acciones del administrador.

Trae **7 políticas por defecto** (es/en), neutrales e internacionales, editables, con disclaimer de
"adaptar a su jurisdicción".

---

## 2. Experiencia del usuario final

1. **Primer acceso / login**: si la organización tiene políticas obligatorias (`block_full`) pendientes,
   el usuario es llevado a una **pantalla de aceptación** (`/compliance/accept`) antes de entrar.
2. **Lectura y aceptación**: cada documento se muestra renderizado; el botón **"Acepto"** se habilita
   sólo al **desplazarse hasta el final** (evidencia de oportunidad de lectura; método `scroll_confirmed`).
   Documentos cortos que no requieren scroll habilitan la aceptación de inmediato.
3. **Registro**: al aceptar, se guarda la evidencia firmada (HMAC). Al aceptar el último documento
   bloqueante, el usuario entra al sistema.
4. **Bloqueo parcial** (`block_partial`): el usuario puede **leer** pero no realizar **acciones de
   escritura** (componer/enviar) hasta aceptar; un 403 al intentar una escritura lo lleva al gate.
5. **Reaceptación**: si el admin publica una versión nueva que requiere reaceptación, el usuario vuelve a
   ser llevado al gate en su próximo request.
6. **Salida**: siempre puede **cerrar sesión** desde el gate (no queda atrapado).

Modos informativos: `soft` muestra el documento como pendiente sin bloquear; `none` no rastrea.

---

## 3. Experiencia del administrador

Panel **Administración → pestaña Compliance** (`/admin`):

### Gestión de documentos
- **Crear documento**: clave (kebab-case), título, categoría. Nace `soft` (no bloquea).
- **Editar metadata**: `enforcement` (none/soft/block_partial/block_full), `audience`
  (all/role:user/role:admin), activo/inactivo, orden.
- **Activar enforcement**: al pasar a `block_*` se exige una versión publicada vigente; el sistema fija
  el umbral exigido (`enforcedVersion`) a la versión vigente.
- **Borrar**: soft-delete si existe alguna **versión publicada o aceptación** (preserva la evidencia);
  hard-delete sólo si no hay versiones publicadas ni aceptaciones (los borradores no lo impiden) y el
  documento no es `system`.

### Gestión de versiones
- **Crear borrador**: contenido Markdown (por idioma), fecha de vigencia (`effectiveAt`, puede ser
  futura), y si **requiere reaceptación**.
- **Publicar**: el borrador pasa a publicado de forma **atómica**; la fecha de vigencia debe ser
  **monótona** (no anterior a la última publicada). Una versión con `effectiveAt` futuro entra en vigor
  automáticamente al llegar la fecha.
- **Historial**: todas las versiones quedan visibles (inmutables).

### Auditoría
- **Export CSV** de las aceptaciones por documento (evidencia legal). Columnas: `userEmail`,
  `documentKey`, `version`, `acceptedAt`, `ip`, `userAgent`, `locale`, `method`, `hmacKeyId` (para
  verificación). El export queda auditado como acción admin (`export_acceptances`).
- **Verificación de evidencia**: endpoint que recomputa el HMAC y confirma si un registro es íntegro.
- **Log de acciones admin** (`ComplianceAdminAction`): quién creó/editó/publicó/cambió enforcement/exportó.

---

## 4. Configuración (operación)

Variables de entorno:

| Variable | Efecto |
| --- | --- |
| `COMPLIANCE_HMAC_SECRET` | Secreto dedicado para firmar la evidencia. **Obligatorio en producción** (no se firma con JWT_SECRET, que rota). |
| `COMPLIANCE_HMAC_RETIRED_KEYS` | JSON `{keyId: secret}` de claves retiradas → la evidencia histórica sigue verificable tras rotar. |
| `COMPLIANCE_ENFORCEMENT_DISABLED=1` | **Kill-switch**: desactiva el gate (escape operativo ante un lockout). Se emite un `warn` al boot. |
| `COMPLIANCE_FAIL_MODE=open\|closed` | Ante un error del gate: `open` (default, permite — no deja a la org sin correo) o `closed` (deniega 503). |

Seed: los 7 documentos por defecto se siembran en boot (idempotente) como `soft` — **nunca bloquean un
login existente**. El admin decide conscientemente volverlos obligatorios.

---

## 5. Observabilidad

Métricas Prometheus (en `/api/metrics`):
- `webmail_compliance_acceptances_total` — aceptaciones registradas.
- `webmail_compliance_publishes_total` — versiones publicadas.
- `webmail_compliance_gate_blocks_total` — requests bloqueados por el gate.
- `webmail_compliance_gate_errors_total` — errores del gate (señal de alarma; con fail-open creciente = bug).

Logs estructurados en publish, errores del gate, y un **warn al boot** si el kill-switch
(`COMPLIANCE_ENFORCEMENT_DISABLED=1`) está activo (para que un bypass no pase silencioso; el kill-switch
es una env var, no un endpoint, y no se registra como acción admin). El **export CSV de evidencia** sí
queda registrado como acción admin (`export_acceptances`) en `ComplianceAdminAction`.

**Latencia de propagación (caché del gate):** el gate cachea el set de documentos enforced por tenant
(TTL ≤30s, invalidado por `complianceEpoch` ante publish/cambio de metadata) y el estado "usuario
conforme" (TTL ≤60s, invalidado por epoch). Un cambio de **rol** o una edición **directa en DB** (fuera
del servicio) pueden tardar hasta ~60s en reflejarse; un publish/cambio de política se refleja de
inmediato (bump de epoch).

---

## 6. Seguridad y garantías

- **El backend es la autoridad**: el gate (hook `onRequest`) decide; el router del SPA es sólo UX.
- **Inmutabilidad e indelebilidad** de versiones publicadas (middleware Mongoose; único write-path es el servicio).
- **Evidencia tamper-evident**: HMAC-SHA256 con secreto dedicado, canónico no ambiguo (length-prefix),
  `contentHash` del texto exacto, append-only, idempotente.
- **IP real**: capturada server-side tras `trustProxy` (X-Forwarded-For), no provista por el cliente.
- **Multi-tenant scopeado**: todas las queries filtran `tenantId`.
- **Markdown saneado**: pipeline `html:false` + allowlist estricta (sin script/img/iframe/on*), XSS-tested.
- **Admin no exento**: un admin con políticas pendientes debe aceptar para operar (se desbloquea vía
  `/accept`, exento, o kill-switch).

---

## 7. Limitaciones conocidas / responsabilidad

- Los documentos por defecto son **plantillas iniciales**, NO asesoría legal. Cada organización es
  responsable de adaptarlos a su legislación y de revisarlos con asesores legales antes de producción.
- Multi-tenant es **forward-compatible** (hoy single-tenant por deployment; `tenantId='default'`).
- i18n del **panel admin** pendiente (el gate de usuario está i18n es/en) — follow-up documentado.

---

## 8. Mapa de aceptación → evidencia (flujo)

```
Admin crea documento (soft) → crea versión borrador (Markdown) → publica (atómico, vigencia monótona)
   → activa enforcement block_full (fija enforcedVersion)
        ↓
Usuario hace login → el gate detecta pendiente block_full → 403 COMPLIANCE_REQUIRED / redirect al gate
        ↓
Usuario lee (scroll-to-end) → "Acepto" → POST /accept
   → backend valida versión vigente, captura IP/UA server-side, firma HMAC, guarda evidencia (idempotente)
        ↓
Gate recomputa: usuario conforme → entra al sistema
        ↓
Admin publica v2 (requiresReacceptance) → enforcedVersion sube → el usuario vuelve al gate en su próximo request
        ↓
Admin exporta CSV de evidencia / verifica HMAC de un registro
```
