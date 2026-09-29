import type { Accessibility } from '../lib/api.ts';

/**
 * Step-free access, stated plainly.
 *
 * Three states, and the third matters: most feeds leave accessibility unset
 * for a large share of stops, and "we don't know" must never be drawn as
 * either "yes" or "no". Unknown renders nothing at all, rather than a
 * confident guess in either direction.
 */
export function AccessibilityTag({
  value,
  subject,
  compact = false,
}: {
  value: Accessibility | undefined;
  subject: 'stop' | 'trip';
  compact?: boolean;
}) {
  if (!value) return null;
  const accessible = value === 'accessible';
  const long = accessible
    ? subject === 'stop'
      ? 'Step-free boarding'
      : 'Accessible vehicle'
    : subject === 'stop'
      ? 'No step-free boarding'
      : 'Vehicle not accessible';

  return (
    <span
      className={`access-tag${accessible ? ' access-tag--yes' : ' access-tag--no'}${compact ? ' access-tag--compact' : ''}`}
      title={long}
      aria-label={long}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {/* The International Symbol of Access, simplified to survive 12px. */}
        <circle cx="8.5" cy="2.4" r="1.6" fill="currentColor" />
        <path
          d="M7 5h2.2v3H12l1.6 4.4-1.3.5L11 9.7H7.6A1.6 1.6 0 0 1 6 8.1V5.9A.9.9 0 0 1 7 5Zm-2 2.6v1.2a3.4 3.4 0 1 0 5.5 3.1h1.2A4.6 4.6 0 1 1 5 7.6Z"
          fill="currentColor"
        />
      </svg>
      {!compact && <span>{long}</span>}
      {!accessible && compact && <span aria-hidden="true">✕</span>}
    </span>
  );
}
