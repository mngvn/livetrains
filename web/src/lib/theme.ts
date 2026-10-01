import { useCallback, useEffect, useState } from 'react';
import { isDarkOutside } from './sun.ts';

/**
 * Dark, light, or whichever it is outside.
 *
 * Dark is the default: it is the theme the app is designed on, and the one
 * a network map reads best in. "Auto" follows the sun at the agency's own
 * location — dark from just after sunset to just before sunrise — because
 * what matters is whether it is dark at the bus stop, not what a phone's
 * appearance setting happens to say. Light is there for reading in a bright
 * shelter at noon.
 *
 * The resolved theme is applied as `data-theme` on the root element, which
 * the stylesheet's tokens key off. An inline script in index.html applies a
 * best guess before first paint, so nobody is flashed with the wrong ground.
 */
export type ThemeChoice = 'dark' | 'auto' | 'light';
export type ResolvedTheme = 'light' | 'dark';

/** Keep in step with the inline script in index.html. */
const STORAGE_KEY = 'livetrains.theme';

/** The browser chrome colour for each theme, matching `--bg`. */
const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#e9ecf0', dark: '#0b0e14' };

/** How often "auto" looks out of the window. */
const AUTO_CHECK_MS = 60_000;

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'auto' || stored === 'dark') return stored;
  } catch {
    // Private browsing; the default.
  }
  return 'dark';
}

function apply(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
}

export function useTheme(location: { lat: number; lon: number } | null): {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice());
  const lat = location?.lat;
  const lon = location?.lon;
  const outside = useCallback((): ResolvedTheme => {
    if (lat === undefined || lon === undefined) {
      // Before the agency is known: the local clock is a fair guess.
      const hour = new Date().getHours();
      return hour >= 19 || hour < 7 ? 'dark' : 'light';
    }
    return isDarkOutside(new Date(), lat, lon) ? 'dark' : 'light';
  }, [lat, lon]);
  const [sky, setSky] = useState<ResolvedTheme>(outside);

  useEffect(() => {
    if (choice !== 'auto') return;
    setSky(outside());
    const timer = window.setInterval(() => setSky(outside()), AUTO_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [choice, outside]);

  const resolved: ResolvedTheme = choice === 'auto' ? sky : choice;

  useEffect(() => apply(resolved), [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A preference that cannot be saved still applies for this visit.
    }
  }, []);

  return { choice, resolved, setChoice };
}
