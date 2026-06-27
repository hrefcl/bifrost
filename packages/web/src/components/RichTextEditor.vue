<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';

const { t } = useI18n();

// Editor WYSIWYG mínimo estilo Gmail (Tiptap 2 / ProseMirror, per doc funcional §7.3.1).
// Emite HTML; el backend lo re-sanitiza al guardar el draft (sanitize-html).
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const editor = useEditor({
  content: props.modelValue,
  extensions: [
    // StarterKit ya incluye Link; lo desactivamos ahí y lo añadimos con NUESTRA config
    // (sin abrir al click, rel/target seguros) para evitar el extension duplicado.
    StarterKit.configure({ link: false }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      // Defensa cliente (además del saneo del backend): sólo http/https/mailto. Bloquea
      // que se inserte un href javascript:/data: desde el editor.
      protocols: ['http', 'https', 'mailto'],
      isAllowedUri: (url) => {
        try {
          // base relativa: un href relativo resuelve a https (permitido); javascript:/data:
          // conservan su protocolo y se rechazan.
          const proto = new URL(url, 'https://placeholder.local').protocol;
          return proto === 'http:' || proto === 'https:' || proto === 'mailto:';
        } catch {
          return false;
        }
      },
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    }),
  ],
  editorProps: {
    attributes: { class: 'prose max-w-none focus:outline-none min-h-[12rem] dark:prose-invert' },
  },
  onUpdate: ({ editor }) => {
    emit('update:modelValue', editor.getHTML());
  },
});

// Sincronizar cuando el valor cambia DESDE afuera (p.ej. precarga de reply/forward) sin
// reescribir si ya coincide (evita resetear el cursor mientras el usuario tipea).
watch(
  () => props.modelValue,
  (val) => {
    if (editor.value && val !== editor.value.getHTML()) {
      editor.value.commands.setContent(val, { emitUpdate: false });
    }
  }
);

function setLink(): void {
  const prev = editor.value?.getAttributes('link').href as string | undefined;
  const url = window.prompt(t('editor.linkPrompt'), prev ?? 'https://');
  if (url === null) return; // cancelado
  if (url === '') {
    editor.value?.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  editor.value?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
}

onBeforeUnmount(() => {
  editor.value?.destroy();
});
</script>

<template>
  <div class="rounded-lg border border-gray-300 dark:border-gray-700">
    <div
      v-if="editor"
      class="flex flex-wrap items-center gap-1 border-b px-2 py-1 dark:border-gray-700"
    >
      <button
        type="button"
        class="tb"
        :class="{ active: editor.isActive('bold') }"
        :title="t('editor.bold')"
        @click="editor.chain().focus().toggleBold().run()"
      >
        <b>B</b>
      </button>
      <button
        type="button"
        class="tb italic"
        :class="{ active: editor.isActive('italic') }"
        :title="t('editor.italic')"
        @click="editor.chain().focus().toggleItalic().run()"
      >
        I
      </button>
      <span class="mx-1 h-4 w-px bg-gray-300 dark:bg-gray-600"></span>
      <button
        type="button"
        class="tb"
        :class="{ active: editor.isActive('bulletList') }"
        :title="t('editor.bulletList')"
        @click="editor.chain().focus().toggleBulletList().run()"
      >
        •
      </button>
      <button
        type="button"
        class="tb"
        :class="{ active: editor.isActive('orderedList') }"
        :title="t('editor.orderedList')"
        @click="editor.chain().focus().toggleOrderedList().run()"
      >
        1.
      </button>
      <button
        type="button"
        class="tb"
        :class="{ active: editor.isActive('blockquote') }"
        :title="t('editor.blockquote')"
        @click="editor.chain().focus().toggleBlockquote().run()"
      >
        ❝
      </button>
      <span class="mx-1 h-4 w-px bg-gray-300 dark:bg-gray-600"></span>
      <button
        type="button"
        class="tb"
        :class="{ active: editor.isActive('link') }"
        :title="t('editor.link')"
        @click="setLink"
      >
        🔗
      </button>
    </div>
    <EditorContent :editor="editor" class="px-3 py-2" />
  </div>
</template>

<style scoped>
.tb {
  @apply flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800;
}
.tb.active {
  @apply bg-blue-100 text-blue-700 dark:bg-gray-700 dark:text-blue-300;
}
</style>
