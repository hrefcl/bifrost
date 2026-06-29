import { Contact } from '../models/Contact.js';

interface Recipient {
  name?: string;
  address: string;
}

/**
 * Auto-guarda destinatarios como contactos (estilo Gmail): cada address al que el usuario envía queda
 * como contacto si NO existía. Idempotente vía upsert con `$setOnInsert` → NUNCA pisa un contacto ya
 * curado por el usuario (nombre/organización). Best-effort; el caller ignora errores.
 */
export async function autoSaveContacts(userId: string, recipients: Recipient[]): Promise<void> {
  const seen = new Set<string>();
  for (const r of recipients) {
    const email = r.address.trim().toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    const fullName = (r.name ?? '').trim() || (email.split('@')[0] ?? email);
    await Contact.updateOne(
      { userId, email },
      {
        $setOnInsert: {
          userId,
          email,
          fullName,
          sortName: fullName.toLowerCase(),
          source: 'auto',
        },
      },
      { upsert: true }
    );
  }
}
