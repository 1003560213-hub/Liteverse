import { useCallback, useState, type SetStateAction } from "react";

/**
 * Per-viewer interface preferences (panel visibility, lens, quality). Storage
 * can be unavailable or cleared; the default value is always a valid state.
 * Library data never lives here.
 */
export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback((next: SetStateAction<T>) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(current) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Preferences are optional.
      }
      return resolved;
    });
  }, [key]);
  return [value, update] as const;
}
