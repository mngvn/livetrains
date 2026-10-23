import { useCallback, useSyncExternalStore } from 'react';

/** Where the layout becomes a phone's: a bottom sheet over a tab bar. Keep in step with styles.css. */
export const PHONE_QUERY = '(max-width: 720px)';

/**
 * Whether a media query matches, kept current as the window is resized or a
 * phone is turned.
 *
 * For the few places the layout changes what is rendered, not only how it is
 * styled; everything else stays in the stylesheet's own media queries.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
