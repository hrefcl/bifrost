import { ref } from 'vue';

export function useToggle(initial = false) {
  const value = ref(initial);
  function toggle() {
    value.value = !value.value;
  }
  function set(v: boolean) {
    value.value = v;
  }
  return { value, toggle, set };
}
