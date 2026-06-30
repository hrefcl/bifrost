# BifrostMail Compliance Framework — Diagramas de Arquitectura

Complementa `DESIGN.md` (v4). Diagramas Mermaid de modelo de datos, gating, publish y aceptación.

## 1. Modelo de datos (ER)

```mermaid
erDiagram
    ComplianceDocument ||--o{ ComplianceVersion : "tiene versiones"
    ComplianceDocument ||--o{ ComplianceAcceptance : "es aceptado en"
    ComplianceVersion  ||--o{ ComplianceAcceptance : "evidencia de"
    User               ||--o{ ComplianceAcceptance : "acepta"
    User               ||--o{ ComplianceAdminAction : "ejecuta (admin)"
    ComplianceSettings ||--|| Tenant : "por tenant"

    ComplianceDocument {
        string tenantId
        string key
        enum   enforcement "none|soft|block_partial|block_full"
        enum   audience
        bool   active
        int    versionCounter
        ref    currentVersionId "denorm: vigente"
        int    enforcedVersion  "denorm: umbral"
        date   enforcedFrom
        ref    nextVersionId    "denorm: próxima programada"
        date   nextEffectiveAt
    }
    ComplianceVersion {
        int    version "monotónico"
        enum   status  "draft|published|archived"
        array  contents "por locale: title+bodyMarkdown+bodyHtml"
        string contentHash "sha256 markdown fuente"
        string pipelineVersion
        date   effectiveAt "monótono no decreciente"
        bool   requiresReacceptance
    }
    ComplianceAcceptance {
        ref    userId
        ref    versionId
        int    version
        string contentHash
        string ip "real, tras trustProxy"
        string hmacKeyId
        string evidenceHmac "tamper-evident"
    }
    ComplianceAdminAction {
        ref    actorId
        enum   action
        mixed  before
        mixed  after
    }
```

## 2. Gate de primer acceso (request flow)

```mermaid
flowchart TD
    REQ[Request autenticada] --> AUTH[plugins/auth.ts: jwtVerify]
    AUTH --> GATE{compliance-gate hook}
    GATE -->|requiresAuth:false / skipCompliance| PASS[pasa a la ruta]
    GATE -->|kill-switch ON| PASS
    GATE --> SNAP[Snapshot enforced docs por epoch Redis]
    SNAP -->|0 docs enforced| PASS
    SNAP --> ROLE[Lookup rol si audience role:*]
    ROLE --> NEXT{nextEffectiveAt <= now?}
    NEXT -->|sí| RECO[recomputeDenorm CAS off-hot-path]
    NEXT -->|no| ACC
    RECO --> ACC[Lookup aceptaciones del user]
    ACC --> PEND{¿pendientes bloqueantes?}
    PEND -->|no| PASS
    PEND -->|block_full| B403[403 COMPLIANCE_REQUIRED]
    PEND -->|block_partial + complianceEffect=write| B403
    PEND -->|soft| PASS
    GATE -.->|excepción| FAILOPEN[fail-open + log + métrica]
    FAILOPEN --> PASS
```

## 3. Publish (standalone-safe, sin transacción multi-doc)

```mermaid
flowchart TD
    PUB[POST /admin/versions/:id/publish] --> CHK{effectiveAt >= latestPublishedEffectiveAt?}
    CHK -->|no| R409[409 effectiveAt no monótono]
    CHK -->|sí| INC[1. $inc versionCounter → nextVersion ATÓMICO]
    INC --> VER[2. upsert Version published unique docId+version]
    VER --> DEN[3. recomputeDenorm: current*/next*/enforced* CAS]
    DEN --> EP[4. bump complianceEpoch + Redis]
    EP --> OK[OK + ComplianceAdminAction]
    VER -.->|crash| RECON[reconcileComplianceDenorm en boot/drift]
    DEN -.->|crash| RECON
    RECON --> DEN
```

## 4. Aceptación + evidencia HMAC

```mermaid
sequenceDiagram
    participant U as Usuario (SPA)
    participant API as /api/compliance
    participant DB as MongoDB
    U->>API: GET /pending
    API-->>U: docs bloqueantes + enforcement
    U->>U: lee doc (scroll-to-end habilita Aceptar)
    U->>API: POST /accept {documentKey, version}
    API->>API: si nextEffectiveAt<=now → recomputeDenorm (CAS)
    API->>API: valida version == vigente exigible (si no → 409 VERSION_STALE)
    API->>API: captura ip(X-Forwarded-For real), userAgent, locale
    API->>API: evidenceHmac = HMAC(key[hmacKeyId], canonicalJSON length-prefixed)
    API->>DB: insert ComplianceAcceptance (unique → E11000=idempotente)
    API-->>U: 200 (o pendientes restantes)
    Note over U,API: al aceptar el último bloqueante → libera el gate
```

## 5. Reaceptación por nueva versión

```mermaid
flowchart LR
    A[Admin publica v_n+1 requiresReacceptance=true] --> B[enforcedVersion = n+1, enforcedFrom = effectiveAt]
    B --> C[epoch bump → invalida caché cross-worker]
    C --> D{Usuario: maxAcceptedVersion >= enforcedVersion?}
    D -->|no| E[pendiente → gate según enforcement]
    D -->|sí| F[ok, no re-acepta]
    A2[typo-fix requiresReacceptance=false] --> G[enforcedVersion NO sube → nadie re-acepta]
```
