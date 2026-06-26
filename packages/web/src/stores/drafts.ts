import { ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/lib/http';
import type { Draft } from '@webmail6/shared';

export interface ComposerState {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyHtml: string;
}

/** Contexto de threading para responder (el backend setea In-Reply-To/References al enviar). */
export interface ReplyContext {
  emailId: string;
  messageId?: string;
  references?: string[];
}

export const useDraftStore = defineStore('drafts', () => {
  const drafts = ref<Draft[]>([]);

  async function fetchDrafts() {
    const { data } = await api.get<Draft[]>('/drafts');
    drafts.value = data;
  }

  async function createDraft(state: ComposerState, replyTo?: ReplyContext) {
    const { data } = await api.post<Draft>('/drafts', {
      accountId: state.accountId,
      to: parseAddresses(state.to),
      cc: parseAddresses(state.cc),
      bcc: parseAddresses(state.bcc),
      subject: state.subject,
      bodyHtml: state.bodyHtml,
      // Threading: sólo al crear. El PATCH posterior (update→send) preserva replyTo porque
      // el backend no lo toca si no se envía. El backend valida ownership del email original.
      ...(replyTo
        ? {
            replyToEmailId: replyTo.emailId,
            replyToMessageId: replyTo.messageId,
            replyToReferences: replyTo.references,
          }
        : {}),
    });
    return data;
  }

  async function updateDraft(draftId: string, state: ComposerState) {
    const { data } = await api.patch<Draft>(`/drafts/${draftId}`, {
      accountId: state.accountId,
      to: parseAddresses(state.to),
      cc: parseAddresses(state.cc),
      bcc: parseAddresses(state.bcc),
      subject: state.subject,
      bodyHtml: state.bodyHtml,
    });
    return data;
  }

  async function sendDraft(draftId: string) {
    const { data } = await api.post<{ messageId: string }>(`/drafts/${draftId}/send`);
    return data;
  }

  async function deleteDraft(draftId: string) {
    await api.delete(`/drafts/${draftId}`);
  }

  return { drafts, fetchDrafts, createDraft, updateDraft, sendDraft, deleteDraft };
});

/**
 * Parte una lista de destinatarios respetando `"comillas"` y `<ángulos>`: así un display
 * name con comas (`"Pérez, Ana" <a@b>`) no se rompe, y `Nombre <email>` extrae name+address.
 * Exportada para test unitario.
 */
export function parseAddresses(raw: string): { address: string; name?: string }[] {
  const tokens: string[] = [];
  let cur = '';
  let inAngle = false;
  let inQuote = false;
  for (const ch of raw) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === '<') inAngle = true;
    else if (ch === '>') inAngle = false;
    if (ch === ',' && !inAngle && !inQuote) {
      tokens.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  tokens.push(cur);
  return tokens
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(t);
      if (!m) return { address: t };
      const name = m[1]
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim();
      const address = m[2].trim();
      return name ? { address, name } : { address };
    });
}
