# Fase final — CLI de aprovisionamiento de servidor de correo en AWS

> Estado: DISEÑO (no implementado). Origen: visión del PM (sesión 6).
> Objetivo: un CLI interactivo que, con tus claves AWS, deja un **servidor de correo completo**
> corriendo en EC2 y recibiendo correo real — sin tocar la consola web de AWS a mano.

## 0. Misión (el filtro de TODA decisión técnica)

Dar a PYMEs y freelancers (20–100 personas) un servidor de correo **propio, casi sin costo por
buzón y "infinito"**, frente a los $5–10/usuario/mes comerciales (50 pers × $7 = $350/mes; 100 =
$700) que para ellos es insufrible. **Meta concreta: empresa de ~50 personas con correo
prácticamente ilimitado por ~$50/mes.**

**Palanca de costo:** EC2 modesto + **S3 bien configurado** como store de bulk (cuerpos + adjuntos =
"gigas y gigas" a ~$0.023/GB/mes), NO inflando EBS (más caro) ni Mongo. Sin licencias por asiento,
**open source**, costo marginal por buzón ≈ 0. **Esto convierte el S3 cifrado de "opcional" en
CENTRAL/DEFAULT** — es lo que hace verdadero el caso de costo.

**Principios derivados (no negociables):**
1. **Mail data → S3 cifrado como store primario** (cuerpos también, no solo adjuntos); minimizar EBS.
2. **Costo transparente**: el CLI MUESTRA costo total estimado + **$/buzón/mes** (probar la tesis).
3. **Entregabilidad VERIFICADA**: DKIM/SPF/DMARC/PTR/TLS no solo configurados sino chequeados
   post-install — si el correo cae en spam, el producto no sirve (existencial).
4. **Turnkey**: "llegar, instalar y todo funciona"; cero fricción/consultor/ops.

Ante cualquier opción técnica: "¿baja el costo por buzón y/o hace el install más turnkey?". Si no,
reconsiderar.

## 1. Objetivo y alcance

Un comando (`bifrost-provision`) que guía paso a paso:

1. **Credenciales AWS** (perfil, env, o ingreso interactivo) → validación (`sts:GetCallerIdentity`).
2. **Región** + **tipo de EC2** (lista curada con specs/precio) + **SSD/EBS** (tamaño sugerido).
3. **SSH**: importar tu clave pública existente, o que el CLI **cree** un par y guarde el `.pem` (0600).
4. **Dominio**: lo ingresás; el CLI detecta si ya hay **hosted zone** en Route53.
5. **Route53**: si falta, la crea (y te muestra los NS para el registrador); crea **MX, A, SPF,
   DKIM, DMARC**.
6. **Red**: **security group** (puertos de correo) + **Elastic IP** (IP estable para MX/PTR).
7. **Provisión del host**: instala el stack de correo, crea cuentas, genera **DKIM**, habilita **TLS**.
8. **Verificación**: chequea puertos/DNS/TLS y deja el servidor **recibiendo correo**.

Cada paso es **idempotente y resumible** (state file), con **dry-run** (plan sin crear nada),
**estimación de costo**, **confirmación explícita** antes de crear recursos facturables, y un
comando **`teardown`** que destruye todo lo creado (recursos etiquetados `Project=Bifrost`).

## 2. Decisiones clave (defaults recomendados — sujetos a confirmación del PM)

| # | Decisión | Default recomendado | Por qué / alternativas |
|---|----------|---------------------|------------------------|
| D1 | **Stack de correo** | **docker-mailserver** | Un solo contenedor: Postfix(25/465/587)+Dovecot(143/993)+OpenDKIM+SpamAssassin+Fail2ban+ClamAV+Let's Encrypt. Batteries-included, muy documentado, ya hay plantilla en `deploy/example-mailserver/`. Alternativas: Mailcow (más pesado, trae su propia webmail que NO necesitamos porque Bifrost ES la webmail), Postfix/Dovecot a mano (más control, mucho más trabajo y superficie de error). |
| D2 | **Qué despliega v1** | **ALL-IN-ONE: mail server + Bifrost en el mismo EC2** (decisión del PM) | El EC2 corre docker-mailserver **y** la webapp Bifrost completa (API+web+Mongo+Redis+nginx, vía el `docker-compose.prod.yml` que ya existe). Bifrost se conecta al mail server local. Un solo host, una sola IP, todo administrable desde el CLI. Sube los requisitos de RAM/EBS (ver D4/D5). |
| D3 | **OS / AMI** | **Ubuntu 22.04 LTS** (último AMI vía SSM parameter) | docker-mailserver está mejor probado en Ubuntu; AMI por SSM = siempre el último parcheado. |
| D4 | **Tipo EC2 mínimo** | **t3.medium (4GB)**; sugerir t3.large (8GB) | All-in-one: ClamAV(~1GB)+Mongo+Redis+Node API+nginx+docker-mailserver no entra en 2GB. 4GB es el piso realista; 8GB cómodo. Lista curada: t3.medium/large/xlarge. |
| D5 | **EBS** | **gp3, 40GB** (sugerir por nº de buzones + correo) | All-in-one guarda imágenes Docker + Mongo + buzones + adjuntos; 30GB queda justo. |
| D6 | **TLS** | **Let's Encrypt** (docker-mailserver) | Requiere A-record + 80/443 abiertos antes; el CLI ordena los pasos. |
| D7 | **Reverse DNS (PTR)** | **NO automatizable por Route53** | El PTR de una Elastic IP se pide por un **formulario de soporte de AWS** (o se delega). El CLI lo DETECTA y lo avisa con instrucciones — no promete lo que no puede. Sin PTR, muchos destinos marcan spam. |
| D8 | **AWS SDK** | **v3 (clientes modulares)** | EC2, Route53, STS, SSM, Pricing/ServiceQuotas, EC2 (KeyPairs/SG/EIP). Tree-shakeable. |
| D9 | **Ejecución remota** | **cloud-init (user-data)** para instalar Docker+stack; **SSH** (node-ssh) para crear cuentas, generar DKIM y leer la pubkey DKIM de vuelta. | user-data = reproducible; SSH = pasos que dependen de output (DKIM). |
| D10 | **Repositorio de datos en S3 cifrado** (pedido del PM) | **Opcional, recomendado: S3 + SSE-KMS** como object store de Bifrost (cuerpos de correo + adjuntos). **REUSA el subsistema de storage ya existente** (`services/storage/s3.ts`, provider s3 con secret cifrado, ver `admin-config-y-providers.md`) — no se reinventa. | El CLI crea el bucket + una **KMS CMK**, lo endurece (block public access, **bucket policy deny-unencrypted-PUT + TLS-only**, **versioning**, SSE-KMS default) y cablea la config de storage de Bifrost a ese bucket. Metadata liviana (headers/flags/threading) sigue en Mongo; los **blobs pesados (cuerpos+adjuntos) van a S3 cifrados**. |
| D11 | **Maildir vivo del mail server** | **Queda en EBS** (filesystem); S3 = backup/archivo cifrado opcional | HONESTIDAD: Postfix/Dovecot esperan un filesystem; apuntar el maildir VIVO a S3 (s3fs) es frágil y no-prod. S3 sí sirve para (a) el object store de Bifrost (D10) y (b) **sync/archivo cifrado** del maildir. El EBS además se cifra con la misma KMS (EBS encryption). |

## 3. Grafo de recursos AWS (lo que crea, en orden de dependencia)

```
STS (validar identidad)
  └─ KMS CMK (clave de cifrado; cifra S3 + EBS)            [si S3/cifrado activado]
  └─ S3 bucket (block-public, versioning, SSE-KMS,         [si S3 activado]
  │    bucket policy: deny PUT sin cifrar + deny no-TLS)
  └─ KeyPair (importada o creada)
  └─ Security Group  ──┐
  └─ Elastic IP        │
  └─ EC2 instance ◄────┘ (AMI Ubuntu, EBS gp3 cifrado con la CMK, user-data=install
        │                  docker-mailserver + Bifrost compose; storage=s3 → bucket)
        └─ associate Elastic IP
  └─ Route53 Hosted Zone (detectar/crear)
        ├─ A     mail.<dom>      → EIP
        ├─ MX    <dom>           → mail.<dom> (prio 10)
        ├─ TXT   <dom>           → SPF  "v=spf1 mx -all"
        ├─ TXT   _dmarc.<dom>    → DMARC "v=DMARC1; p=quarantine; rua=..."
        └─ TXT   mail._domainkey.<dom> → DKIM (tras generarla en el host)
  └─ (SSH) crear cuentas + generar DKIM + habilitar TLS + cablear storage S3 cifrado
```

### 3.bis — S3 como repositorio de datos cifrado (D10/D11)

El CLI, si activás S3:
1. Crea una **KMS CMK** (`alias/bifrost-data`) con rotación anual.
2. Crea el **bucket** con: Block Public Access (los 4 flags), **default encryption SSE-KMS** con la
   CMK, **versioning** on, y una **bucket policy** que (a) DENIEGA `s3:PutObject` sin
   `x-amz-server-side-encryption: aws:kms` y (b) DENIEGA cualquier request sin TLS
   (`aws:SecureTransport=false`).
3. **Cablea Bifrost** a ese bucket reusando el subsistema ya construido: setea la config de storage
   (provider `s3`, endpoint AWS, región, credenciales) — el `secretAccessKey` se guarda **cifrado**
   en `SystemConfig` como ya hace `services/storage/config.ts`. Los cuerpos de correo + adjuntos
   (los blobs pesados) pasan a vivir en S3 cifrado; Mongo retiene sólo metadata.
4. **EBS encryption** del volumen raíz con la misma CMK (datos en reposo del host cifrados).
5. (Opcional) job de **archivo/backup** del maildir a un prefijo `s3://.../archive/` cifrado.

IAM extra requerido para esto: `kms:CreateKey/CreateAlias/Encrypt/Decrypt/GenerateDataKey`,
`s3:CreateBucket/PutBucketPolicy/PutBucketVersioning/PutEncryptionConfiguration/PutPublicAccessBlock`.

> ⚠️ **GAP REAL (auto-auditoría) — el wiring APP-SIDE de S3 NO existe todavía.** Crear el bucket no
> alcanza para que el correo viva en S3. Hoy: (a) **`services/storage/s3.ts` exige accessKeyId/
> secretAccessKey ESTÁTICAS** (aws4fetch) — **NO soporta IAM instance role**; (b) **nada lee env de
> storage al boot** (sólo se configura por el admin API). Por eso el box arranca con **storage LOCAL**
> (funciona en EBS) y el `user-data` NO promete S3. Para que S3-turnkey funcione de verdad hace falta
> una fase con TRES piezas: (1) crear un **rol/instance-profile IAM** con acceso al bucket+CMK y
> adjuntarlo al EC2; (2) **soporte de instance role en S3Storage** (resolver creds temporales por la
> cadena del SDK / IMDS y refrescarlas, alimentando aws4fetch con sessionToken); (3) **bootstrap de
> storage por env al boot** del API (sembrar `SystemConfig` en modo s3-instance-role si no hay config).
> Hasta entonces, S3 es la pasada de optimización (C) sin auto-config — NO se promete como hecho.

Puertos del Security Group: 22 (SSH, idealmente restringido a la IP del admin), 25, 465, 587,
143, 993, 80, 443.

## 3.ter — PIVOTE a CloudFormation (decisión del PM, sesión 6)

**El CLI: pregunta → arma el YAML/JSON de CloudFormation → lo corre él mismo.** Esto reemplaza el
enfoque imperativo previo (RunInstances/EIP/SG + state/teardown propios), que estaba **reinventando
CloudFormation** (hallazgo de la auto-auditoría, dim. 5). CFN es superior para esta misión:
- **Turnkey real para cuenta nueva sin nada:** un solo stack crea **VPC + subnet + IGW + route table
  + SG + EIP + EC2** con dependencias y rollback automáticos. Si ya hay VPC → el CLI **pregunta en
  cuál** (lista VPCs/subnets) y pasa `ExistingVpcId/ExistingSubnetId` (el template las usa por condición).
- **Teardown trivial y sin huérfanos:** borrar el stack = borrar TODO. Supera al teardown imperativo.
- **Idempotencia/resumibilidad nativas:** Create si no existe, Update si existe; `OnFailure: DELETE`.

Implementado: `infra/stack-template.ts` (builder del template, condición `CreateNetwork`), `aws/vpc.ts`
(listVpcs/listSubnets para la pregunta), `aws/cloudformation.ts` (deployStack/getStackOutputs/
getStackStatus/deleteStack). Todo mock-testeable.

**Lo que QUEDA fuera de CFN (por necesidad):** (1) **key pair** — el CLI lo crea por SDK para obtener
el `.pem` (CFN no devuelve la clave privada); (2) **DKIM** — la clave se genera en el box al boot, así
que su registro Route53 se agrega DESPUÉS por SDK (los A/MX/SPF/DMARC sí pueden ir en el template).
**REMOVIDO (auto-auditoría dim 5):** el cómputo imperativo (SG/EIP/RunInstances/associate +
`provisionInstance`/`provisionComputeIdentity`), el `state`/`plan`/`teardown` propios y la resolución
de AMI por SDK (`aws/ssm.ts`) — todo superseded por CloudFormation (el stack ES el estado; DeleteStack
ES el teardown; el template resuelve el AMI por SSM). De `aws/compute.ts` queda SÓLO `ensureKeyPair`
(lo único que CFN no hace: devolver el `.pem`). Se CONSERVAN user-data, preflight y cost-calc.

## 3.quater — Bifrost Meet (opcional, videollamadas LiveKit)

El wizard ofrece **4 modos** de Meet (select, o flags `--meet-mode off|bundled|twobox|external`):

| Modo | Infra local | Cuándo usarlo | Costo extra aprox. |
|---|---|---|---|
| **off** (default) | Ninguna | Sin videollamadas | $0 |
| **bundled** | LiveKit en el **mismo EC2** | PYME chica, pocas llamadas | ~+$25/mes (piso RAM) |
| **twobox** | **2º EC2 dedicado** a LiveKit | Muchas llamadas; el correo no compite CPU/RAM | ~2× infra (2 EC2 + 2 EIP) |
| **external** | Ninguna; apunta a un LiveKit ajeno | Ya tenés un LiveKit/Cloud gestionado | $0 infra local |

### bundled (`MeetMode='enabled'`)
LiveKit self-hosted en el mismo EC2. Abre puertos media, exige ≥8 GiB RAM y sube el costo. El menú de EC2
sólo ofrece instancias ≥8 GiB y halva la capacidad de buzones. El **piso** sube a `t4g.large`. El template
crea un **2º Security Group** con los puertos media (`7881/tcp`, `7882/udp`, `3478/udp`); el SG base queda
byte-idéntico. Los registros `meet.<dom>`/`turn.meet.<dom>` apuntan a la EIP del app-box.

### twobox (`MeetMode='twobox'`)
LiveKit corre en un **2º EC2 dedicado** (media-box) con su propia EIP y Security Group. El app-box no lleva
LiveKit local: firma tokens y el navegador conecta al media-box por `wss://meet.<dom>`. El CLI:
1. Genera un par `apiKey`/`apiSecret` y lo guarda en **SSM SecureString** (`LivekitSecretParamName`); ambos
   boxes lo leen con su rol.
2. Ofrece un catálogo curado para el media-box con **default `t4g.medium` (~$24)**: `t4g.small` (~$12,
   ultra-mínimo, opt-in), `t4g.medium`, `t4g.large`, y `c6g.large`/`c6g.xlarge`/`c7g.large` (no-burstable,
   para muchas llamadas sostenidas). Flag: `--livekit-instance-type <tipo>`. **Filosofía "separar, NO
   duplicar":** el media-box es SÓLO LiveKit (~1-2 GiB) → no necesita 8 GiB; un 2-box mínimo = 2× t4g.medium
   (~$48) ≈ el costo de 1× t4g.large bundled, pero con la media separada del correo.
3. Escribe dos user-data: el del app-box (sin `COMPOSE_PROFILES=meet`) y el del media-box (LiveKit + Caddy
   auto-TLS). El media-box publica SÓLO `7881/7882/3478` + `127.0.0.1:7880` (health local); **NO mapea el
   rango `30000-40000` en el compose** (haría 10.001 `docker-proxy` → OOM; hallado en el deploy real).
4. Crea los recursos condicionales `LivekitSecurityGroup` (22/80/443 + media, nunca 7880), `LivekitElasticIP`,
   `LivekitInstance`, `LivekitEIPAssociation` y un **`LivekitInstanceRole`/`Profile` PROPIO y mínimo**
   (cfn-signal + `ssm:GetParameter` + `kms:Decrypt`, SIN S3/SES — least-privilege, no reusa el rol del
   app-box). `meet.<dom>`/`turn.meet.<dom>` apuntan a la EIP del media-box; el app-box firma tokens contra el
   twirp `https://meet.<dom>`. Las dos instancias señalizan `cfn-signal` independiente (sin deadlock).

### external (`MeetMode='external'`)
Apunta a un LiveKit que ya tenés (p.ej. Cleverty o LiveKit Cloud). El app-box NO corre media: sólo firma
tokens. El wizard pide `wss://` + apiKey + apiSecret (flags `--meet-external-url/-key/-secret` o env var
`BIFROST_LIVEKIT_SECRET`). El **wsUrl se valida fuerte** (sólo `wss://`, sin userinfo/path/query, sin hosts
internos/metadata/IPv4-mapped/NAT64 — anti-SSRF; se re-valida en el backend). El **apiSecret NO viaja en
user-data/CFN**: el CLI lo escribe a un **SSM SecureString** (KMS) y el box lo lee al boot con el rol
(mismo patrón que SES: `ssm:GetParameter` scoped + `kms:Decrypt` vía `kms:ViaService`). Fail-closed: si el
secret falta en SSM al boot, el provisioning aborta.

**Secret compartido (twobox/external).** El parámetro SSM (`/bifrost/<dom>/livekit-secret`) es leído por
el app-box y, en twobox, también por el media-box. El CLI lo publica justo antes del deploy.

**Selección de instancia por capacidad.** El menú de EC2 del app-box muestra costo + buzones (y participantes
de Meet si es bundled), recomendando la más chica que cubre los buzones: `t4g.medium` (~15), `large` (~50),
`xlarge` (~150), `2xlarge` (~500). Con twobox el app-box no sufre piso de RAM; el media-box se elige aparte.
Los `t4g` son **burstable** → para Meet intensivo conviene **twobox** con `c6g`/`c7g` o **external**.
Flags no-interactivos: `--mailboxes N`, `--instance-type <tipo>` (fuera de catálogo + bundled exige
`--allow-unknown-meet-instance`), `--livekit-instance-type <tipo>` (twobox).

> **Detalle clave — la EIP en `node_ip` NO sale de IMDS.** El `EIPAssociation` asocia DESPUÉS de que el
> cloud-init señaliza (`CreationPolicy`), así que IMDS daría la IP **efímera** de launch. Se inyecta por
> **CloudFormation** con `GetAtt <EIP>.PublicIp`, concatenado al user-data vía **`Fn::Join`** (no
> `Fn::Sub`). El `GetAtt` crea la dependencia implícita `Instance→EIP`, así CFN conoce la IP antes del launch.

Con `MeetMode='disabled'` (default) **nada de esto aplica**: el stack es idéntico al de sólo-correo.
Guía de operación/troubleshooting: [`meet/INSTALL.md`](./meet/INSTALL.md).

## 4. Arquitectura del código

Nuevo paquete **`packages/provisioner`** (TS, ESM, parte del monorepo pnpm):

```
packages/provisioner/
  src/
    cli.ts                 # entrypoint interactivo (@inquirer/prompts)
    aws/                   # wrappers finos sobre AWS SDK v3 (sts, ec2, route53, ssm, pricing)
    steps/                 # cada paso del flujo (credentials, instance, ssd, ssh, domain,
                           #   route53, network, provision, verify) — funciones puras-ish
    state.ts               # state file .bifrost-provision.json (ids de recursos, resumible)
    plan.ts                # dry-run: imprime el plan + costo estimado sin crear nada
    teardown.ts            # destruye todo lo del state file (orden inverso)
    mailserver/            # plantillas docker-mailserver (compose, env, postfix accounts)
  bin/bifrost-provision
```

**Principios:**
- **Idempotente**: cada step chequea si el recurso ya existe (por tag/state) antes de crear.
- **Resumible**: si falla a la mitad, re-correr continúa desde el state file.
- **Dry-run primero**: `--plan` muestra TODO lo que haría + costo estimado; nada se crea sin un
  `confirm` explícito.
- **Teardown**: `bifrost-provision teardown` borra todos los recursos etiquetados del state.
- **Secretos**: las claves AWS NUNCA se persisten en el state file; SSH `.pem` con 0600.
- **Tags**: todo recurso lleva `Project=Bifrost, ManagedBy=bifrost-provision` para limpieza segura.

## 5. Seguridad

- **IAM mínimo**: documentar el policy JSON exacto que necesita el usuario AWS (EC2, Route53, STS,
  SSM read) — no pedir admin total.
- **SSH**: SG 22 restringible a la IP del operador; clave creada con permisos 0600.
- **Sin secretos en disco/logs**: credenciales sólo en memoria; el state file no guarda claves.
- **Confirmación antes de facturar**: ningún `RunInstances`/`AllocateAddress` sin `confirm`.

## 6. Cómo se testea (sin gastar AWS) y la prueba final (con AWS real)

- **Orquestación**: tests con **`aws-sdk-client-mock`** (mockean los clientes SDK) → se verifica el
  ORDEN, idempotencia, manejo de errores y el grafo de dependencias sin tocar AWS.
- **Dry-run**: `--plan` corre el flujo completo sin efectos → verificable en CI.
- **Plantillas**: el compose/env de docker-mailserver se validan estructuralmente.
- **Prueba final (la del PM)**: con **claves AWS reales** → crear EC2 real, apuntar un dominio real,
  **enviar y recibir correo de verdad**, y conectar Bifrost por IMAP/SMTP al box. Esto NO es
  automatizable en CI (cuesta dinero, RCE remoto, DNS real) — es la validación manual de cierre.

## 7. Plan por fases (incremental, B/D-reviewable)

- **F-E1 — Preflight (read-only, sin facturar):** paquete + CLI base; validar credenciales
  (`sts:GetCallerIdentity`); listar regiones; listar tipos EC2 curados con specs+precio (sizing
  all-in-one); validar el dominio y detectar hosted zone Route53; validar nombre de bucket S3 y
  toggle de cifrado. **Testeable con SDK mocks, cero costo.** ← primer PR.
- **F-E2 — Plan + state + teardown + COSTO:** dry-run que imprime el grafo completo + **costo
  total estimado/mes Y $/buzón/mes** (EC2 + EBS + S3 + transferencia) para N buzones — la métrica
  que prueba la tesis "50 personas ≈ $50/mes" (misión §0). State file; comando teardown.
- **F-E2.5 — S3 cifrado + KMS (D10/D11) — store PRIMARIO de bulk:** crear CMK + bucket endurecido
  (block-public, SSE-KMS, versioning, policy deny-unencrypted/deny-no-TLS); generar la config de
  storage de Bifrost (provider s3, secret cifrado). EBS encryption con la CMK. **El correo en bulk
  (cuerpos+adjuntos) vive acá, no en EBS** (palanca de costo, misión §0). Idempotente + teardown.
- **F-E3 — Red + cómputo:** KeyPair (importar/crear), Security Group, Elastic IP, EC2. **REUSA la
  plantilla REAL existente `deploy/example-mailserver/`** (Traefik+TLS · docker-mailserver con
  OpenDKIM/DMARC/SPF/fail2ban · Mongo+Redis · Bifrost API/Web + `setup.sh` que parametriza dominio,
  genera secretos e imprime DNS) — NO reinventar; el user-data clona/parametriza ese compose.
  Idempotente + resumible. **DECISIÓN ABIERTA DE ARQUITECTURA (ver §8).**
- **F-E4 — DNS:** Route53 hosted zone (detectar/crear) + A/MX/SPF/DMARC; aviso de PTR.
- **F-E5 — Correo + ENTREGABILIDAD VERIFICADA:** SSH → crear cuentas, generar DKIM, publicar DKIM
  en Route53, TLS Let's Encrypt; **verificar** puertos/DNS(MX/SPF/DKIM/DMARC)/TLS y hacer un
  **envío+recepción de prueba contra un checker** (no solo "configurado": comprobado que NO cae en
  spam — existencial, misión §0).
- **F-E6 — Bifrost conectado:** la webapp (en el mismo EC2) usa el IMAP/SMTP local y el storage S3.

Cada fase: typecheck+lint+test (mocks) verdes + review B/C/D antes de avanzar. La prueba con AWS
real la corre el PM al final de F-E5.

### 7.bis — Envío SALIENTE en AWS: el bloqueo del puerto 25 (verificado en el primer deploy real)

**Hecho de AWS, no del turnkey:** AWS **bloquea el puerto 25 saliente** por defecto en EC2 (anti-spam).
El box **RECIBE** correo sin problema (inbound 25 abierto), pero **NO ENVÍA** directo a otros MX hasta
resolverlo. Dos caminos (el CLI lo imprime al terminar y debe explicarse al cliente final):

1. **Desbloqueo del puerto 25** — formulario de soporte AWS (24-48h). Envío directo self-hosted puro.
2. **Relay por Amazon SES** (recomendado, inmediato) — configurar `RELAY_HOST=email-smtp.<region>.
   amazonaws.com`, `RELAY_PORT=587`, `RELAY_USER`/`RELAY_PASSWORD` (credenciales SMTP de SES, derivadas
   de un usuario IAM con `ses:SendRawEmail`) en docker-mailserver. Probado en vivo: el mailserver
   relayea por TLS a SES y SES acepta el mensaje. **OJO — SANDBOX:** una cuenta SES nueva sólo entrega
   a destinatarios **verificados**; para enviar a **cualquiera** hay que pedir **production access**
   (saca el sandbox; suele aprobarse rápido para bajo volumen). El dominio verificado en SES sirve como
   REMITENTE; el sandbox limita el DESTINATARIO.

**Deuda turnkey (TD-PROVISION-OUTBOUND-RELAY):** hacer el relay SES una **opción del wizard** (si el
usuario da credenciales SES/SMTP → setea RELAY_* en el compose; si no → puerto 25 directo + aviso de
desbloqueo). Y considerar emitir las credenciales SMTP de SES + el pedido de production access desde el
propio flujo CloudFormation (con consentimiento explícito del cliente).

## 8. DECISIÓN ABIERTA — dónde vive el bulk del correo (clave para la tesis de costo)

La misión (§0) exige que los **gigas y gigas de correo vivan en S3 barato**, no en EBS. Pero
docker-mailserver guarda el **maildir en filesystem (EBS)**. Hay tensión; opciones:

- **(A) docker-mailserver en EBS + S3 solo para adjuntos/archivo** (lo más simple, v1 más rápida).
  El maildir completo crece en EBS → con volumen alto el costo NO baja tanto. Tesis parcial.
- **(B) Bifrost como store S3-nativo** (máxima tesis de costo): Postfix recibe → entrega por
  LMTP/pipe a Bifrost → Bifrost guarda cuerpo+adjuntos en **S3 cifrado** + metadata en Mongo; el
  IMAP lo sirve Bifrost desde S3. EBS queda mínimo. Es un **rework grande** del modelo de storage.
- **(C) Híbrido con tiering** (recomendado pragmático): v1 funciona con (A) para tener correo REAL
  rápido; luego un **cap de EBS + lifecycle** que offloadea cuerpos viejos a S3 y Bifrost los sirve
  desde ahí. Llega a la tesis de costo por etapas sin bloquear un v1 funcionando.

**Recomendación A→C:** v1 funcionando (A) para validar entregabilidad con AWS real cuanto antes,
y la pasada de optimización de costo (tiering a S3) como fase dedicada. Confirmar con el PM antes
de F-E3.

---

## Hallazgos B/C/D (revisión externa, 2026-06) — RESUELTOS · deploy APPROVED 9/10

> **Cierre (re-validación B/Codex):** deploy **9/10, 0 HIGH abiertos → APPROVED**. Los 2 HIGH de B
> (TLS de `mail.<dominio>` vía router Traefik→acme.json de DMS; wiring del login con toggle
> TLS/STARTTLS + 465/143) quedan RESUELTOS a nivel config. D(Kimi) marcó el TLS NO-RESUELTO →
> **falso positivo refutado** con docs oficiales de DMS. C(z) TEAM_UNAVAILABLE (z.ai 529). Sólo
> resta verificación en box real (emisión ACME, DKIM, entregabilidad SMTP) = **F-E5**, que corre el PM.


La auditoría real B(Codex)+D(Kimi) sobre el provisioner destapó ~9 HIGH que las auto-auditorías no
vieron (no se había cruzado el contrato real de `deploy/example-mailserver/docker-compose.yml`).
**CERRADOS:** secretos `.txt`+`*_FILE` en la API, longitud/hex de ENCRYPTION_KEY, tools+Docker
firmado en user-data, DNS `webmail`, CreationPolicy+cfn-signal+readiness, EBS no-borra, IMDSv2,
deployStack idempotente, catches acotados, poll timeout/rollback, bucket policy, SSH CIDR, S3 off,
nginx↔servicio (api/web), SPF ~all, 465/143 publicados.

**RESUELTOS A NIVEL CONFIG (pendiente verificación en box real — F-E5):**
- **TLS del mail server (`mail.<dominio>`)** [B HIGH]: se añadió un **router Traefik `mailcert`** en el
  servicio `mailserver` (`Host(mail.<dominio>)` + `tls.certresolver=letsencrypt`) que **fuerza la
  emisión ACME** de ese FQDN. `docker-mailserver` con `SSL_TYPE=letsencrypt` + `SSL_DOMAIN=mail.<dominio>`
  **lee el `acme.json` de Traefik** (montado en `/etc/letsencrypt/acme.json:ro` vía el volumen
  compartido `./letsencrypt`) y extrae el cert — patrón soportado oficialmente por DMS. El challenge
  HTTP-01 va por el entrypoint `web` igual que el router `bifrost` del webmail (ya probado). Sólo falta
  confirmar la emisión real (IMAPS/SMTP STARTTLS) en un box con DNS+80/443 abiertos.
  > Nota: D(Kimi) marcó esto NO-RESUELTO alegando que DMS exige layout certbot y que hace falta
  > `traefik-certs-dumper`. **Falso positivo (conocimiento desactualizado)**: la doc oficial de DMS
  > dice que *"Traefik's storage format is natively supported if the `acme.json` store is mounted
  > into the container at `/etc/letsencrypt/acme.json`"* y `SSL_DOMAIN` selecciona el cert por FQDN.
  > El mount `./letsencrypt:/etc/letsencrypt:ro` cumple esa ruta. `certs-dumper` era el workaround
  > viejo, ya innecesario.
- **Wiring webmail↔mailserver local** [B HIGH]: la UI del login ya **togglea TLS/STARTTLS** (IMAP+SMTP,
  con `tlsHint` i18n y e2e que lo verifica) y el compose **publica 465 (SMTPS) + 143 (IMAP STARTTLS)**.
  El default sigue siendo Gmail por ser un **webmail genérico** (reemplazo de Roundcube): el usuario
  escribe su servidor; prefijar el login al `mail.<dominio>` local es decisión de producto (build-time
  brand/config), no un bug del wiring.

**ABIERTO (MEDIUM, requiere box real — F-E5):**
- **Cuentas + DKIM post-boot**: SSH al box → `setup email add` + `setup config dkim` + publicar el TXT
  DKIM + verificar entregabilidad. [D MEDIUM]

El TLS/ACME, DKIM y SMTP reales sólo se verifican con un box AWS — núcleo de F-E5. Los fixes de config
están en su sitio siguiendo los patrones documentados/ya-probados; la verificación end-to-end la corre
el PM al desplegar.
