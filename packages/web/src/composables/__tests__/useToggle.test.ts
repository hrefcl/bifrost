import { describe, it, expect } from 'vitest';
import { useToggle } from '../useToggle';

describe('useToggle', () => {
  it('toggles value', () => {
    const { value, toggle } = useToggle(false);
    expect(value.value).toBe(false);
    toggle();
    expect(value.value).toBe(true);
  });

  it('sets value explicitly', () => {
    const { value, set } = useToggle(false);
    set(true);
    expect(value.value).toBe(true);
  });
});
