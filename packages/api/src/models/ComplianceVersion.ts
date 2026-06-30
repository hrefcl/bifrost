import mongoose, { Schema, type Document, type Types } from 'mongoose';

export type ComplianceVersionStatus = 'draft' | 'published' | 'archived';

export interface IComplianceLocaleContent {
  locale: string;
  title: string;
  bodyMarkdown: string;
  /** HTML saneado derivado del markdown (pipeline §6). No entra en `contentHash`. */
  bodyHtml: string;
}

export interface IComplianceAttachment {
  name: string;
  blobRef?: string;
  sizeBytes?: number;
  contentType?: string;
}

/**
 * `ComplianceVersion` — snapshot inmutable y versionado (DESIGN v4 §2.2).
 *
 * Es la **fuente de verdad**. Una versión `published` es **inmutable e indeleble**: el middleware
 * de abajo rechaza toda mutación/borrado si `status !== 'draft'`. Toda edición ⇒ nueva versión draft.
 */
export interface IComplianceVersion extends Document {
  tenantId: string;
  documentId: Types.ObjectId;
  documentKey: string;
  version: number;
  status: ComplianceVersionStatus;
  contents: IComplianceLocaleContent[];
  pipelineVersion: string;
  /** sha256(JSON canónico de contents[] con sólo {locale,title,bodyMarkdown}, ordenado por locale). */
  contentHash: string;
  changeSummary: string;
  requiresReacceptance: boolean;
  effectiveAt: Date;
  expiresAt?: Date | null;
  attachments: IComplianceAttachment[];
  authorId?: Types.ObjectId | null;
  authorEmail: string;
  publishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const LocaleContentSchema = new Schema<IComplianceLocaleContent>(
  {
    locale: { type: String, required: true },
    title: { type: String, required: true },
    bodyMarkdown: { type: String, required: true },
    bodyHtml: { type: String, default: '' },
  },
  { _id: false }
);

const AttachmentSchema = new Schema<IComplianceAttachment>(
  {
    name: { type: String, required: true },
    blobRef: { type: String },
    sizeBytes: { type: Number },
    contentType: { type: String },
  },
  { _id: false }
);

const ComplianceVersionSchema = new Schema<IComplianceVersion>(
  {
    tenantId: { type: String, required: true, default: 'default', index: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'ComplianceDocument', required: true },
    documentKey: { type: String, required: true },
    version: { type: Number, required: true },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
      required: true,
    },
    contents: { type: [LocaleContentSchema], default: [] },
    pipelineVersion: { type: String, default: '' },
    contentHash: { type: String, default: '' },
    changeSummary: { type: String, default: '' },
    requiresReacceptance: { type: Boolean, default: true },
    effectiveAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    attachments: { type: [AttachmentSchema], default: [] },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    authorEmail: { type: String, default: '' },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Número de versión único por documento → red de seguridad ante carrera de publish.
ComplianceVersionSchema.index({ tenantId: 1, documentId: 1, version: 1 }, { unique: true });
// Para recomputeDenorm/reconciler: versiones publicadas de un documento por effectiveAt.
ComplianceVersionSchema.index({ tenantId: 1, documentId: 1, status: 1, effectiveAt: 1 });

/**
 * INMUTABILIDAD E INDELEBILIDAD (DESIGN §2.2, B-L2 / C-M7).
 *
 * Una versión `published`/`archived` no se muta ni se borra: dejaría `currentVersionId` y
 * `ComplianceAcceptance.versionId` colgando. Sólo `services/compliance.ts` debe escribir aquí.
 * `db.collection()` nativo bypassa Mongoose → operación prohibida fuera del servicio (documentado).
 */
export class ComplianceImmutabilityError extends Error {
  statusCode = 409;
  constructor(message = 'Published compliance version is immutable and indelible') {
    super(message);
    this.name = 'ComplianceImmutabilityError';
  }
}

/**
 * POLÍTICA DE INMUTABILIDAD INVERTIDA (B P0c HIGH-1/HIGH-2).
 *
 * En vez de enumerar campos/operadores "peligrosos" (frágil: dot-paths, $unset, $inc, $push…),
 * se CONGELA TODO sobre una versión no-draft. La ÚNICA transición permitida es `published`→`archived`
 * (sólo cambia `status`). Cualquier otra mutación o borrado se rechaza/no-opea.
 *
 * - `save()` (document path): valida con `modifiedPaths()` — cobertura total de campos.
 * - update/delete (query path): se acotan ATÓMICAMENTE a `status:'draft'` SIEMPRE (sin lectura
 *   previa → sin TOCTOU; cubre cualquier operador/dot-path porque la operación sólo matchea drafts).
 *   Publish y archive se hacen vía `save()` de documento (no por query update), o publish vía CAS
 *   `{_id,status:'draft'}` que es consistente con el acotado. Archivar published→archived = `save()`.
 *
 * Limitaciones conocidas y DOCUMENTADAS como prohibidas fuera de `services/compliance.ts`:
 * `Model.bulkWrite()` y el driver nativo `db.collection()` NO disparan estos middlewares.
 */

// Captura el status persistido al cargar/guardar → fuente de verdad de la transición en save().
ComplianceVersionSchema.post('init', function (this: IComplianceVersion) {
  this.$locals.loadedStatus = this.status;
});
ComplianceVersionSchema.post('save', function (this: IComplianceVersion) {
  this.$locals.loadedStatus = this.status;
});

// Campos que Mongoose puede tocar automáticamente y no cuentan como mutación del usuario.
const AUTO_PATHS = new Set(['updatedAt', 'createdAt', '__v']);

ComplianceVersionSchema.pre('save', function (next) {
  if (this.isNew) {
    next();
    return;
  }
  const loaded = (this.$locals.loadedStatus as ComplianceVersionStatus | undefined) ?? this.status;
  if (loaded === 'draft') {
    next(); // los drafts se editan libremente
    return;
  }
  const modified = this.modifiedPaths().filter((p) => !AUTO_PATHS.has(p.split('.')[0]));
  // Única mutación permitida sobre no-draft: published → archived, cambiando SÓLO `status`.
  const isArchiveTransition =
    loaded === 'published' &&
    this.status === 'archived' &&
    modified.length === 1 &&
    modified[0] === 'status';
  if (!isArchiveTransition) {
    next(new ComplianceImmutabilityError());
    return;
  }
  next();
});

// Query update/delete: SIEMPRE acotado a draft (atómico, sin TOCTOU, inmune a operadores/dot-paths).
function scopeToDraft(
  this: mongoose.Query<unknown, IComplianceVersion>,
  next: (err?: Error) => void
) {
  this.setQuery({ ...this.getFilter(), status: 'draft' });
  next();
}

ComplianceVersionSchema.pre('updateOne', scopeToDraft);
ComplianceVersionSchema.pre('updateMany', scopeToDraft);
ComplianceVersionSchema.pre('findOneAndUpdate', scopeToDraft);
ComplianceVersionSchema.pre('replaceOne', scopeToDraft);
ComplianceVersionSchema.pre('findOneAndReplace', scopeToDraft);
ComplianceVersionSchema.pre('deleteOne', { document: false, query: true }, scopeToDraft);
ComplianceVersionSchema.pre('deleteMany', scopeToDraft);
ComplianceVersionSchema.pre('findOneAndDelete', scopeToDraft);
// Document-level delete: usa loadedStatus (no this.status en memoria) — D P0b residual #2.
ComplianceVersionSchema.pre('deleteOne', { document: true, query: false }, function (next) {
  const loaded = (this.$locals.loadedStatus as ComplianceVersionStatus | undefined) ?? this.status;
  if (loaded !== 'draft') {
    next(new ComplianceImmutabilityError());
    return;
  }
  next();
});

export const ComplianceVersion = mongoose.model<IComplianceVersion>(
  'ComplianceVersion',
  ComplianceVersionSchema
);
