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

Puertos del Security Group: 22 (SSH, idealmente restringido a la IP del admin), 25, 465, 587,
143, 993, 80, 443.

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
- **F-E3 — Red + cómputo:** KeyPair (importar/crear), Security Group, Elastic IP, EC2 (user-data
  instala Docker + docker-mailserver + **Bifrost compose** all-in-one, apuntando el storage al
  bucket S3 cifrado). Idempotente + resumible. **DECISIÓN ABIERTA DE ARQUITECTURA (ver §8).**
- **F-E4 — DNS:** Route53 hosted zone (detectar/crear) + A/MX/SPF/DMARC; aviso de PTR.
- **F-E5 — Correo + ENTREGABILIDAD VERIFICADA:** SSH → crear cuentas, generar DKIM, publicar DKIM
  en Route53, TLS Let's Encrypt; **verificar** puertos/DNS(MX/SPF/DKIM/DMARC)/TLS y hacer un
  **envío+recepción de prueba contra un checker** (no solo "configurado": comprobado que NO cae en
  spam — existencial, misión §0).
- **F-E6 — Bifrost conectado:** la webapp (en el mismo EC2) usa el IMAP/SMTP local y el storage S3.

Cada fase: typecheck+lint+test (mocks) verdes + review B/C/D antes de avanzar. La prueba con AWS
real la corre el PM al final de F-E5.

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
