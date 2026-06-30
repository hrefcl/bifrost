# Diseño — SES outbound turnkey (TD-PROVISION-OUTBOUND-SES)

> Estado: **V5 — implementado, pendiente re-review B/D**. V4.1 cruzó el gate (B9.1/D9.0). V5 = decisión del
> PM: se DESCARTA el auto-pause CloudWatch→SNS→Lambda (desproporcionado para webmail PYME de bajo volumen);
> el manejo de bounces queda en suppression-list automática + backstop de AWS + métricas + corte manual
> `ses-pause`. Esto **relaja** la postura de B sobre #7 → re-validar en B/D antes de cerrar fase. El resto
> del diseño (identidad/DKIM/MAIL FROM/credenciales crash-safe/send-gating) sin cambios y ya implementado.
> Misión: *deliverability = existencial*. Hoy el box **recibe** pero no **envía** solo (puerto 25
> saliente bloqueado por AWS; el relay SES es manual). Objetivo: que `bifrost-provision` **auto-provisione
> el plumbing de salida** cuando el operador elige SES — y **reporte el estado con honestidad**
> (verificación DKIM y salida de sandbox NO son instantáneas ni automatizables al 100%).

## Qué significa "turnkey" acá (re-encuadre tras B-HIGH#3)
NO significa "manda correo real en el segundo 0". Significa: el CLI deja **toda la infra cableada**
(identidad, DKIM, IAM, relay, DNS) y **te dice exactamente en qué estado estás**:
`outbound: pending-dkim` (DNS propagando) → `pending-production-access` (en sandbox) → `ready`.
Lo que es manual en AWS (salir del sandbox) se detecta y se explica, no se promete.

**Máquina de estados del outbound (V3, ampliada por B-MED):**
`pending-dkim` (CNAME DKIM sin verificar) → `pending-mail-from` (Custom MAIL FROM async, ≤72h) →
`pending-production-access` (en sandbox) → `ready`. Más `failed-mail-from` / `failed-dkim` si SES marca
fallo. El CLI **nunca** reporta `ready` sin DKIM verificado **y** MAIL FROM `success` **y** fuera de
sandbox — así no se promete alineación SPF/entrega que no existe todavía.

## Por qué SES SMTP relay (y no envío directo)

AWS bloquea el puerto 25 saliente en EC2 por defecto (anti-spam). docker-mailserver no puede entregar
directo a los MX del mundo. La salida soportada es **relay vía SES SMTP** (`email-smtp.<region>.amazonaws.com:587`,
STARTTLS, SMTP AUTH). docker-mailserver ya soporta relay (`RELAY_HOST/RELAY_PORT/RELAY_USER/RELAY_PASSWORD`).

El relay SMTP **necesita credenciales estáticas** (SMTP AUTH) — el rol del EC2 (que resolvió S3) NO
sirve para SMTP AUTH. Ese es el problema central de este diseño: crear esas creds y entregarlas al box
sin exponerlas (mismo principio que apliqué en S3: nada de secretos en el user-data ni en outputs).

## DKIM: el de SES, no el del box

El box corre su propio OpenDKIM (`ENABLE_OPENDKIM=1`), pero con relay SES **lo relevante es el Easy DKIM
de SES**: SES re-firma el correo con `d=<dominio>` usando su par de llaves gestionado (3 CNAME). Eso da
alineación DKIM para DMARC. La firma OpenDKIM del box es secundaria (puede coexistir). Por eso el DNS de
salida necesita los **3 CNAME del DKIM de SES** + SPF con `include:amazonses.com`.

## Decisión de dónde corre cada cosa (cambio V2)
B+D coinciden: **IAM user + creds SMTP estáticas es inevitable** para SMTP AUTH (el rol del EC2 no firma
SMTP). El sidecar SES-API queda como V2. Y los **tokens DKIM no son confiables como `Fn::GetAtt` de CFN**
(D lo niega, B lo da por hecho — conflicto). Para no depender de eso y poder **pollear verificación +
derivar el password + reportar estado**, la orquestación SES vive en el **CLI (SDK), post-stack**, no en
CFN. CFN sólo aporta el `InstanceRole` con permiso de leer el secret. Esto mantiene una sola fuente de
verdad y evita el Lambda custom-resource.

## Componentes (V2)

### 1. Identidad SES + Easy DKIM — CLI (SDK), post-stack
- `CreateEmailIdentity` (Easy DKIM, 2048-bit) para el dominio.
- Leer los **3 tokens DKIM** del response → si hay zona Route53 gestionada, crear los **3 CNAME**.
- **Custom MAIL FROM** en subdominio **`bounce.<dominio>`** (NO `mail.<dominio>` — AWS reserva ese para
  MX/host operativo; B-MED) vía `PutEmailIdentityMailFromAttributes` → **alineación SPF** para DMARC
  (B-HIGH#2). Crea su MX (`feedback-smtp.<region>.amazonses.com`) + TXT SPF.
- SPF del MAIL FROM subdominio: `v=spf1 include:amazonses.com -all` (en el **subdominio**, NO tocar el
  SPF del apex para no romper el existente — corrige el riesgo de B sobre el apex).
- `MailFromAttributes.BehaviorOnMxFailure = USE_DEFAULT_VALUE` (si el MX del subdominio aún no propaga,
  SES cae al MAIL FROM por defecto en vez de **rebotar** — evita un corte de envío durante la propagación).
- DMARC: ya existe `p=quarantine` en el apex. Se mantiene.
- **Verificación NO bloqueante**: el CLI NO espera 72h. Crea todo, hace un poll corto y reporta el estado
  (`pending-dkim`/`pending-mail-from`). Un `bifrost-provision ses-status` re-chequea DKIM **y** MAIL FROM
  (`GetEmailIdentity` → `MailFromAttributes.MailFromDomainStatus` ∈ pending/success/failed) después.

### 2. IAM user SMTP (mínimo privilegio) — CLI (SDK)
- `CreateUser` + policy inline: `ses:SendRawEmail` con `Resource` = ARN de la identidad + `Condition`
  `StringLike ses:FromAddress = *@<dominio>`. **Honestidad (B/D-MED):** la Condition acota a *este
  dominio*, pero un leak igual puede spamear desde el dominio → la mitigación real es el almacenamiento
  seguro + rotación, no la policy.
- `CreateAccessKey` → el username SMTP = AccessKeyId.

### 3. Derivación + entrega segura (corrige B-HIGH#1)
- El **CLI deriva el SMTP password** del SecretAccessKey (HMAC SigV4, abajo) **en memoria** y descarta el
  SecretAccessKey crudo. **Nunca lo imprime ni lo persiste.**
- Guarda en **SSM Parameter Store SecureString** (más barato que Secrets Manager; KMS): el par
  `RELAY_USER` (AccessKeyId, plano) + `RELAY_PASSWORD` (**password ya derivado**, SecureString). El
  SecretAccessKey crudo de AWS **no toca el box** (B-HIGH#1: el box recibe el password SMTP, no la key AWS).
- El `InstanceRole` (CFN) recibe `ssm:GetParameter` + `kms:Decrypt` **scoped al parámetro/clave exactos**.

### 4. Relay en docker-mailserver — user-data (vía `config/user-patches.sh`, PROBADO)
- El helper `bifrost-ses-activate` lee la credencial de SSM (con el rol) y escribe **`config/user-patches.sh`**
  con la config del relay (`postconf relayhost = [email-smtp.<region>...]:587` + SASL `/etc/postfix/sasl_passwd`).
- **Por qué user-patches.sh y NO `mailserver.env`+`compose up`:** docker-mailserver corre user-patches.sh en
  CADA arranque del contenedor → el relay **sobrevive restart/reboot/recreate**. Confiar en que
  `docker compose up -d` recree por un cambio de *contenido* de `env_file` es FRÁGIL/version-dependiente: si
  no recrea, el relay nunca se aplica → **replicaría a un nuevo usuario el incidente del relay perdido**
  (ver `docs/post-mortem-relay-saliente.md`). Mecanismo verificado contra un restart real del contenedor.
- El helper lo aplica **YA** en el contenedor corriendo (`exec ... user-patches.sh`) + `postqueue -f`
  (flushea la cola atascada), sin esperar un restart. Idempotente (sólo si el contenido cambió).
- Sólo cuando el operador eligió SES, igual que `s3Bucket` gatea el bloque S3.
- **Rotación (3AM):** `rotate-ses` reescribe el SSM param; el cron (≤5 min) regenera user-patches.sh y lo
  re-aplica. (El env-file `mailserver.env` queda como camino MANUAL alternativo, documentado en el README.)

### 5. Estado de envío honesto (corrige B-HIGH#3)
- Tras provisionar, el CLI llama `GetAccountSendingEnabled` + `GetAccount` → detecta **sandbox**.
  Si está en sandbox: marca `outbound: pending-production-access`, imprime el paso EXACTO + link para
  pedir producción. NO promete entrega a destinos arbitrarios.
- Quotas sandbox: 200 dest/24h, 1 msg/s, sólo verificados. Se reportan.

### 6. Manejo de bounces/complaints — RESPONSABILIDAD DEL OPERADOR (revisión V5)
> **Principio (PM):** Bifrost es open-source **self-hosted per-tenant**: cada empresa corre su propio box
> con su propia cuenta AWS y su propio SES. NO hay servicio compartido → NO hay reputación compartida. Si
> un operador hace mal uso (spam, listas sucias) y AWS le suspende SES, **es su cuenta y su problema, no
> del proyecto.** Por eso el #7 no es un riesgo que *Bifrost* deba mitigar con maquinaria (auto-pause
> CloudWatch→SNS→Lambda): es responsabilidad del operador. Bifrost da **defaults sanos + visibilidad +
> docs**, y nada más. (La postura estricta de B asumía que cargábamos el riesgo de reputación — falso en
> self-hosted-por-tenant.)

El mecanismo proporcionado (todo nativo de SES, cero infra extra):
- **Account-level suppression list ON**, **reconciliada, no sobrescrita** (D): `GetAccountSuppressionAttributes`
  → mergear `BOUNCE,COMPLAINT` con lo que el operador ya tuviera → `PutAccountSuppressionAttributes`. SES deja
  de enviar a addresses que **hard-bounced**/se quejaron. **Esta es la defensa nº1 y es AUTOMÁTICA.**
  Residual explícito (B-MED): sólo *hard* bounces entran solos y no todo proveedor reporta complaints (Gmail).
- **Backstop de AWS:** SES mismo pausa/revisa la cuenta si la reputación se degrada — segunda red automática.
- **Configuration set** `bifrost-<dominio>` con `ReputationOptions.ReputationMetricsEnabled=true` → el
  operador VE las tasas de bounce/complaint en el dashboard de SES.
- **Aplicación GARANTIZADA del config-set:** se fija como **default de la identidad** vía
  `PutEmailIdentityConfigurationSetAttributes` → SES lo asocia a TODO envío sin depender de ningún header
  (evita el bug de `smtp_header_checks` que señaló B4: un correo sin Subject se escaparía del set).
- **Corte manual de un comando:** `ses-pause` / `ses-resume` (`UpdateConfigurationSetSendingEnabled`) +
  `ses-suppressions` (`ListSuppressedDestinations`) para ver quién está suprimido. Runbook documentado:
  mirar el dashboard de reputación; si la tasa sube, `ses-pause`, investigar, `ses-resume`.
- **#7 reencuadrado, no "mitigado":** la suspensión de SES por mal uso es **riesgo del operador**, no de
  Bifrost (self-hosted per-tenant, sin reputación compartida). Bifrost entrega defaults sanos (suppression
  list automática) + visibilidad (métricas, `ses-suppressions`) + corte manual (`ses-pause`) + docs. No hay
  obligación de construir un circuit-breaker: quien manda mal, la paga él. Esto **saca #7 de la lista de
  HIGH de Bifrost** (pasa a "responsabilidad del operador, documentada").

### 6.b Rate-limit de envío saliente POR BUZÓN (guardrail in-box, sí proporcionado)
A diferencia del auto-pause AWS (descartado), ESTO sí lo hace Bifrost porque es un guardrail del **propio
producto** y cuesta cero: que el webmail no se use de **cañón de spam** (cuenta comprometida, empleado
malicioso). Vive en la API, sobre el **Redis que ya está en el stack** — sin infra extra:
- `services/outbound-limit.ts`: limiter por buzón (cuenta DESTINATARIOS, no mensajes) en ventanas
  minuto/hora/día, **atómico vía Lua** (check-and-incr en una llamada → sin race entre envíos concurrentes).
- Engancha en `POST /drafts/:id/send` tras resolver la cuenta y antes del submit SMTP; si excede → revierte
  el draft a `editing` y devuelve **429 + Retry-After**.
- Defaults generosos (60/min, 300/h, 1000/día por buzón), override por env `OUTBOUND_MAX_RCPT_PER_*`.
- **FAIL-OPEN:** si Redis falla, se permite el envío (no romper correo legítimo por un blip); el cap es
  guardrail, no frontera dura. Un pico de abuso queda acotado igual por la ventana al volver Redis.
- **Observabilidad:** la ruta loguea `warn` cuando BLOQUEA (señal de abuso: accountId/userId/scope/recipients)
  y `error` cuando degrada a fail-open (Redis caído → cap OFF). El operador ve ambas en los logs del API.
- **Tradeoff conocido (pre-incremento):** la cuota se reserva ANTES del submit SMTP (para que envíos
  concurrentes no esquiven el cap por race). Si el submit luego falla, ese envío igual consumió cuota. Es
  conservador a propósito: para un guardrail anti-abuso preferimos contar de más que de menos. No se
  "reembolsa" en fallo (más simple y sin reabrir la ventana de race).
- **Cap de destinatarios por MENSAJE** (default 100, env `OUTBOUND_MAX_RCPT_PER_MESSAGE`): sin esto un solo
  draft con miles de destinatarios pasaba el schema y agotaba el cupo de una → 400 + revierte a editing. [D-MED]
- Esto acota el abuso EN ORIGEN (un compromiso no escala a miles), complementando la suppression list que
  actúa AGUAS ABAJO. **12 tests** (servicio + 2 de integración de ruta: 429 por ventana y 400 por mensaje).

**Review D (Kimi) 7/10 + B (Codex) 8/10 — todos los fixes aplicados (sin HIGH):**
- hash tags `{accountId}` (sobrevive a Redis Cluster) · cap por mensaje (D-MED).
- `EXPIRE` defensivo en AMBOS paths —permitido Y rechazo— para que una key sin TTL ya saturada no bloquee
  el buzón para siempre (B2-LOW/MED; el fix inicial sólo cubría el path permitido).
- fail-open ahora **captura la causa** (`degradedReason`) y la ruta la loguea → root-cause a las 3AM (B2-MED).
- defaults coherentes: `perMinute(100) >= maxPerMessage(100)` → un anuncio a toda la PYME pasa la ventana
  de minuto (antes 61-100 daba 429 eterno) (B2-LOW).

**Residuales aceptados:** fail-open (coherente con el modelo self-hosted/guardrail, ahora con causa logueada);
ventana fixed con bypass de borde ~2x (defensible vs sliding window/GCRA para este volumen); pre-incremento
sin reembolso (documentado). **14 tests** (servicio + ruta). B y D verificaron y corrieron la suite.
  Eso baja #7 de **HIGH a MED operacional con owner = operador del box** (riesgo aceptado explícitamente,
  ver tabla). Lo único 100% fuera de control —que AWS decida suspender pese a todo— es el residual MED aceptado.

### 7. CLI idempotente y transaccional (cierra B-MED/D-MED de rollback)
La orquestación SES toca varios recursos (identidad, MAIL FROM, IAM user, AccessKey, SSM, Route53). Si
falla a medio camino, **no debe dejar una AccessKey activa huérfana** ni estado a medias:
- **Idempotente:** cada paso chequea si el recurso ya existe (por nombre/tag determinístico
  `bifrost-ses-<dominio>`) y reconcilia en re-run en vez de duplicar. Re-correr el provision = converge.
- **Crash-safe (cierra B/D sobre la ventana CreateAccessKey↔SSM):** no se confía sólo en el cleanup
  in-proceso (un kill -9 entre `CreateAccessKey` y `DeleteAccessKey` dejaría huérfana). Al **inicio** de
  cada run, el CLI **reconcilia**: `ListAccessKeys` del user `bifrost-ses-<dominio>` y, si hay una key
  activa que **no** corresponde al password vigente en SSM, la borra (huérfana de un crash previo). Así el
  re-run sana el estado aunque el anterior muriera a mitad.
- **Límite de 2 keys de IAM (cierra D #6):** antes de `CreateAccessKey`, si ya hay 2, borra la más vieja
  inactiva/no-vigente. La rotación es create-new → SSM → restart → delete-old (nunca quedan 2 vigentes).
- **`PutAccountSuppressionAttributes` es account-wide:** se hace merge (sección 6), no overwrite, y el CLI
  avisa si la cuenta ya tenía otra config de SES (no pisa silenciosamente).
- **Tags** `bifrost:managed=ses` en lo que admita tag → el teardown (`destroy`) y `ses-status` los hallan.

### 7b. Send-gating hasta `ready` (cierra D #10)
La máquina de estados *reporta* pero no *impide* enviar; mientras `MailFromDomainStatus != success` SES usa
su MAIL FROM por defecto y se rompe la alineación SPF. Barrera técnica: el relay se cablea **sólo cuando el
estado es `ready`**. En `pending-*`, el user-data deja el relay **sin configurar** (el box recibe pero no
relaya saliente) y `ses-status` reporta el bloqueo. Así no se manda correo mal-alineado que dañe reputación
desde el día 0. Un `bifrost-provision ses-activate` (post-verificación) escribe el env-file + restart.

### 8. Least-privilege del OPERADOR que corre el CLI (cierra D-MED)
La orquestación SES NO usa el rol del EC2; usa las credenciales del **operador** que corre
`bifrost-provision`. Esas creds necesitan un set **acotado** (no admin): `ses:CreateEmailIdentity`,
`ses:PutEmailIdentityMailFromAttributes`, `ses:PutAccountSuppressionAttributes`,
`ses:CreateConfigurationSet*`, `ses:GetEmailIdentity`, `ses:GetAccount`, `iam:CreateUser`,
`iam:PutUserPolicy`, `iam:CreateAccessKey`, `iam:DeleteAccessKey`, `iam:ListAccessKeys` (scoped a
`bifrost-ses-*`), `ses:UpdateConfigurationSetSendingEnabled`, `ses:GetAccountSuppressionAttributes`,
`ses:PutAccountSuppressionAttributes`, `ses:ListSuppressedDestinations`,
`route53:ChangeResourceRecordSets` (sobre la zona dada), `ssm:PutParameter`, `kms:Encrypt` (clave del
parámetro). (V5: ya NO se necesitan `cloudwatch:*`/`sns:*`/`lambda:*` — se descartó el auto-pause.) Se
documenta una **policy mínima de operador** (JSON) para no pedir AdministratorAccess. Reduce el blast
radius si la máquina del operador se compromete (D señaló este vector nuevo).

### 9. Contrato del CLI + criterios de aceptación (cierra D #11/#14)
Comandos: `provision … --outbound=ses` · `ses-status` (DKIM+MAIL FROM+sandbox+suppressions count) ·
`ses-activate` (cablea el relay cuando `ready`) · `ses-suppressions` · `rotate-ses` ·
`pause-outbound`/`resume-outbound`. Salida JSON estable (`{ state, dkim, mailFrom, sandbox, sendingEnabled }`).
**Tests de aceptación (gate de impl, no de diseño):** unit de derivación del SMTP password (vector conocido
AWS), unit de la máquina de estados, test de idempotencia (re-run = no-op), test de crash-cleanup (huérfana
borrada), test del PREPEND del header en Postfix, dry-run que no toca AWS. E2E contra el box real: enviar a
una address verificada (sandbox) y confirmar entrega + alineación DKIM/SPF en el header recibido.

## Derivación del SMTP password (referencia, corre en el CLI)
SES SMTP password = `Base64( 0x04 || HMAC-SHA256( kSigning, "SendRawEmail" ) )` donde `kSigning` es la
clave SigV4 derivada: `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date="11111111"), region), "ses"), "aws4_request")`,
versión `0x04`. Reproducible con `crypto` de Node — el CLI ya está en TS, no hace falta openssl en el box.

## Riesgos consolidados (V1 B6.5/D7 → V2 B8/D8 → V3 B8.3/D8.1 → V4; gate <9: no hay código)
| # | Riesgo | Sev | Mitigación en V4 |
|---|--------|-----|------------------|
| 1 | SecretAccessKey crudo en el box | HIGH→**resuelto** | CLI deriva en memoria; al box sólo va el SMTP password (SSM SecureString) |
| 2 | Deliverability > DKIM+SPF; apex SPF roto | HIGH→**resuelto** | custom MAIL FROM en `bounce.<dom>` (alineación SPF) + `BehaviorOnMxFailure` + DMARC + no tocar SPF apex |
| 3 | "Turnkey" promete envío inmediato | HIGH→**resuelto** | máquina de estados; nunca `ready` sin DKIM+MAIL FROM+prod; **send-gating** (relay sólo en `ready`) |
| 4 | DKIM no síncrono (≤72h) | MED→**resuelto** | orquestación en CLI, poll + `ses-status`, sin rollback del stack |
| 5 | Policy no frena leak de creds SMTP | MED→**aceptado** | Condition acota al dominio; mitigación real = SSM SecureString + rotación documentada |
| 6 | Rotación rompe Postfix (sin hot-reload) | MED→**mitigado** | `rotate-ses` create-new→SSM→restart→delete-old; healthcheck 587 |
| 7 | Cuenta SES suspendida por bounces/complaints | ~~HIGH~~→**fuera de alcance** | (V5) **responsabilidad del operador** — self-hosted per-tenant, sin reputación compartida; el mal uso lo paga su cuenta. Bifrost da defaults sanos (suppression list auto) + visibilidad + corte manual + docs. NO es un HIGH de Bifrost |
| 8 | MAIL FROM async sin estado → falso `ready` | MED→**resuelto** | estados `pending/failed-mail-from`; `ready` exige `MailFromDomainStatus=success` |
| 9 | AccessKey huérfana (crash CreateAccessKey↔SSM) | MED→**resuelto** | reconcile al inicio (`ListAccessKeys` vs SSM vigente) + límite-2-keys; sana en re-run aun tras kill -9 |
| 10 | Subdominio MAIL FROM `mail.` (reservado MX) | MED→**resuelto** | se usa `bounce.<dominio>` |
| 11 | Permisos amplios del operador del CLI | MED→**mitigado** | policy mínima de operador (JSON) documentada (no AdministratorAccess) |
| 12 | Config-set no se aplica al tráfico (correo sin Subject bypassa) | ~~HIGH~~→**resuelto** | config-set como **default de la identidad** (`PutEmailIdentityConfigurationSetAttributes`) → SES lo aplica a TODO envío, sin header (cierra el bug de B4) |
| 13 | Suppression account-wide pisa config existente | MED→**resuelto** | `GetAccountSuppressionAttributes` + merge, no overwrite; avisa si ya había config |
| 14 | SNS sin consumidor (medio mecanismo) | MED→**resuelto** | topic → Lambda auto-pause + email al admin; `ses-suppressions` lista los suprimidos |
| 15 | Identidad/DKIM borrada, drift | MED/LOW | `ses-status` detecta vía tags `bifrost:managed=ses`; doc |

**Riesgo aceptado explícito (gate):** #7 queda como **MED operacional, owner = operador del box** — el único
residual es que AWS suspenda la cuenta pese al auth alineado + supresión + auto-pause automático; es inherente
a usar SES, recuperable por apelación, y con el envío ya auto-pausado no se agrava. **Esto requiere la firma
del PM (A) como aceptación del residual** para cruzar el gate `sin HIGH abierto`.

**Conflicto a verificar en impl:** ¿`AWS::SES::EmailIdentity` expone `DkimDNSTokenName1..3` como `Fn::GetAtt`?
(B sí, D no). V4 lo evita yendo por el CLI-SDK, pero conviene confirmarlo por si parte del DNS vuelve a CFN.
