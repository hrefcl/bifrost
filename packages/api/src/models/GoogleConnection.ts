import mongoose, { Schema, type Document } from 'mongoose';
import type { EncryptedPayload } from '../config/crypto.js';

/**
 * Conexión OAuth de un usuario con Google Calendar (integración F-gcal, v1 unidireccional Bifrost→Google).
 * UNA por usuario (una identidad Google, aunque el usuario tenga varias cuentas de correo). Los tokens se
 * guardan CIFRADOS (AES-256-GCM, `config/crypto.ts`) y NUNCA se serializan a la API/frontend.
 * Desconexión = soft: `status:'revoked'` + `$unset` de los tokens (el doc queda como histórico).
 */
export interface IGoogleConnection extends Document {
  userId: mongoose.Types.ObjectId;
  accessTokenEnc?: EncryptedPayload; // cifrado — nunca sale por la API
  refreshTokenEnc?: EncryptedPayload; // cifrado — nunca al frontend
  tokenExpiresAt?: Date;
  scope?: string;
  googleCalendarId: string; // calendario destino, default 'primary'
  googleUserEmail?: string; // email de la cuenta Google (sólo para mostrar el estado)
  status: 'connected' | 'error' | 'revoked';
  syncError?: string; // último error legible a nivel conexión
  syncToken?: string; // cursor incremental del polling bidireccional (Google→Bifrost)
  // Epoch MONOTÓNICO de la conexión: se incrementa en cada connect/reconnect y en cada disconnect. El
  // poller lo captura al iniciar y lo re-verifica al terminar; si cambió (hubo disconnect ± reconnect
  // mientras importaba), purga sus imports (source:'google') → cierra la carrera disconnect-vs-poll de
  // forma monotónica (status por sí solo no basta: revoked→connected vuelve — review B).
  generation?: number;
  connectedAt: Date;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EncryptedFieldSchema = new Schema<EncryptedPayload>(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
  },
  { _id: false }
);

const GoogleConnectionSchema = new Schema<IGoogleConnection>(
  {
    // Aislamiento: la conexión es del usuario. `unique` → una sola conexión Google por usuario.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    accessTokenEnc: { type: EncryptedFieldSchema },
    refreshTokenEnc: { type: EncryptedFieldSchema },
    tokenExpiresAt: { type: Date },
    scope: { type: String },
    googleCalendarId: { type: String, default: 'primary' },
    googleUserEmail: { type: String },
    status: {
      type: String,
      enum: ['connected', 'error', 'revoked'],
      default: 'connected',
      index: true,
    },
    syncError: { type: String },
    syncToken: { type: String },
    generation: { type: Number, default: 0 },
    connectedAt: { type: Date, default: () => new Date() },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

/** Vista PÚBLICA (para GET /google/status): estado sin NINGÚN token ni dato sensible. */
export interface GoogleConnectionStatus {
  connected: boolean;
  email: string | null;
  calendarId: string;
  status: 'connected' | 'error' | 'revoked';
  error: string | null;
  lastSyncedAt: string | null;
}

export function toGoogleConnectionStatus(doc: IGoogleConnection | null): GoogleConnectionStatus {
  return {
    connected: doc?.status === 'connected',
    email: doc?.googleUserEmail ?? null,
    calendarId: doc?.googleCalendarId ?? 'primary',
    status: doc?.status ?? 'revoked',
    error: doc?.syncError ?? null,
    lastSyncedAt: doc?.lastSyncedAt ? doc.lastSyncedAt.toISOString() : null,
  };
}

export const GoogleConnection = mongoose.model<IGoogleConnection>(
  'GoogleConnection',
  GoogleConnectionSchema
);
