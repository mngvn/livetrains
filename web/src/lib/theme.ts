import { useCallback, useEffect, useState } from 'react';

/**
 * Light, dark, or whatever the device is set to.
 *
 * "System" is the default and the only choice most people ever need: it
 * follows the phone into dark mode at sunset. The explicit choices exist for
 * the rider who wants a dark map at noon, or a light one at night to read in
 * a bright bus shelter.
 *
 * The choice is applied as `data-theme` on the root element, which the
 * stylesheet's tokens key off. An inline script in index.html applies the
 * saved choice before first paint, so a dark-mode rider is never flashed
 * with a white loading screen.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** Keep in step with the inline script in index.html. */
const STORAGE_KEY = 'livetrains.theme';

/** The browser chrome colour for each theme, matching `--surface`. */
const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#ffffff', dark: '#151c2b' };

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private browsing; follow the system.
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(choice: ThemeChoice, resolved: ResolvedTheme): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  // The theme actually showing, for styling third-party widgets (the map's
  // own controls) that have no tokens of their own to follow.
  root.dataset.scheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
}

export function useTheme(): {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice());
  const [system, setSystem] = useState<ResolvedTheme>(() => systemTheme());

  // Follow the device as it changes, not only as it was at load.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = () => setSystem(query.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = choice === 'system' ? system : choice;

  useEffect(() => apply(choice, resolved), [choice, resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      if (next === 'system') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A preference that cannot be saved still applies for this visit.
    }
  }, []);

  return { choice, resolved, setChoice };
}
