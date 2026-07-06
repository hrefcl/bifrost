import { ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/lib/http';
import type { Contact } from '@webmail6/shared';

/** Campos editables de un contacto (lo que aceptan POST/PATCH). */
export type ContactInput = Pick<Contact, 'fullName' | 'email'> &
  Partial<Pick<Contact, 'emails' | 'phones' | 'organization' | 'jobTitle' | 'notes'>>;

export interface ImportResult {
  total: number;
  imported: number;
  skipped: number;
}

export const useContactStore = defineStore('contacts', () => {
  const contacts = ref<Contact[]>([]);

  async function fetchContacts() {
    const { data } = await api.get<Contact[]>('/contacts');
    contacts.value = data;
  }

  async function createContact(contact: ContactInput) {
    const { data } = await api.post<Contact>('/contacts', contact);
    contacts.value.push(data);
    contacts.value.sort((a, b) => a.sortName.localeCompare(b.sortName));
    return data;
  }

  async function updateContact(id: string, patch: Partial<ContactInput>) {
    const { data } = await api.patch<Contact>(`/contacts/${id}`, patch);
    const i = contacts.value.findIndex((c) => c.id === id);
    if (i >= 0) contacts.value[i] = data;
    contacts.value.sort((a, b) => a.sortName.localeCompare(b.sortName));
    return data;
  }

  async function deleteContact(id: string) {
    await api.delete(`/contacts/${id}`);
    contacts.value = contacts.value.filter((c) => c.id !== id);
  }

  /** Importa desde el texto de un .vcf o .csv; devuelve el resumen y refresca la lista. */
  async function importContacts(content: string): Promise<ImportResult> {
    const { data } = await api.post<ImportResult>('/contacts/import', { content });
    if (data.imported > 0) await fetchContacts();
    return data;
  }

  return { contacts, fetchContacts, createContact, updateContact, deleteContact, importContacts };
});
