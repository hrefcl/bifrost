<script setup lang="ts">
import { ref, onMounted } from 'vue';
import AppLayout from '@/layouts/AppLayout.vue';
import { useContactStore } from '@/stores/contacts';

const store = useContactStore();
const showForm = ref(false);
const form = ref({ fullName: '', email: '', organization: '' });

onMounted(() => {
  void store.fetchContacts();
});

async function submit() {
  await store.createContact(form.value);
  form.value = { fullName: '', email: '', organization: '' };
  showForm.value = false;
}
</script>

<template>
  <AppLayout>
    <div class="p-6">
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-2xl font-bold">Contacts</h1>
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          @click="showForm = !showForm"
        >
          New contact
        </button>
      </div>

      <form
        v-if="showForm"
        class="mb-6 space-y-3 rounded-xl border p-4 dark:border-gray-700"
        @submit.prevent="submit"
      >
        <input v-model="form.fullName" type="text" placeholder="Full name" required class="input" />
        <input v-model="form.email" type="email" placeholder="Email" required class="input" />
        <input v-model="form.organization" type="text" placeholder="Organization" class="input" />
        <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-white">Save</button>
      </form>

      <div class="space-y-2">
        <div
          v-for="contact in store.contacts"
          :key="contact.id"
          class="flex items-center justify-between rounded-lg border p-4 dark:border-gray-700"
        >
          <div>
            <div class="font-medium">{{ contact.fullName }}</div>
            <div class="text-sm text-gray-600 dark:text-gray-400">{{ contact.email }}</div>
          </div>
          <button
            class="text-sm text-red-600 hover:underline"
            @click="store.deleteContact(contact.id)"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.input {
  @apply w-full rounded-lg border border-gray-300 bg-white px-4 py-2 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800;
}
</style>
