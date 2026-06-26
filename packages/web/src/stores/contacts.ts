import { ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/lib/http';
import type { Contact } from '@webmail6/shared';

export const useContactStore = defineStore('contacts', () => {
  const contacts = ref<Contact[]>([]);

  async function fetchContacts() {
    const { data } = await api.get<Contact[]>('/contacts');
    contacts.value = data;
  }

  async function createContact(
    contact: Omit<
      Contact,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'usageCount'
      | 'isFrequent'
      | 'source'
      | 'userId'
      | 'sortName'
    >
  ) {
    const { data } = await api.post<Contact>('/contacts', contact);
    contacts.value.push(data);
    return data;
  }

  async function deleteContact(id: string) {
    await api.delete(`/contacts/${id}`);
    contacts.value = contacts.value.filter((c) => c.id !== id);
  }

  return { contacts, fetchContacts, createContact, deleteContact };
});
