import { useCallback, useState } from 'react';

/**
 * A boolean the browser remembers between visits.
 *
 * Map preferences are sticky by nature: someone who hides the side panel or
 * turns the beams off usually means it every time, not once. Storage throws in
 * private browsing and can be cleared under the app's feet, so every access is
 * guarded — a preference that cannot be saved quietly degrades to lasting only
 * for the session, which is better than failing.
 */
export function usePersistedFlag(key: string, fallback = false): [boolean, () => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? fallback : stored === '1';
    } catch {
      return fallback;
    }
  });

  const toggle = useCallback(() => {
    setValue((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // A preference that cannot be saved is not worth failing over.
      }
      return next;
    });
  }, [key]);

  return [value, toggle];
}
