import { crashSummary, type Crash } from '../lib/crashMap.ts';

/**
 * Crashes the agency has reported, said in a line under the feed's status.
 *
 * The map marks each one, but a mark can be off screen or under the panel,
 * and "is anything wrong right now?" should not need a search of the map to
 * answer. Each line goes to its crash: the map moves to it and its stop
 * opens with what the agency said. Nothing is shown when nothing is
 * reported, which is most of the time.
 */

/** More than this many and the rest are a count: a list here would push the planner down. */
const SHOWN = 2;

/** The map's crash mark: the same spiked burst, drawn the same way. */
export function CrashIcon({ size = 16 }: { size?: number }) {
  const points = Array.from({ length: 20 }, (_, i) => {
    const r = i % 2 === 0 ? 7.6 : 5.2;
    const angle = (i * Math.PI) / 10 - Math.PI / 2;
    return `${(8 + r * Math.cos(angle)).toFixed(2)},${(8 + r * Math.sin(angle)).toFixed(2)}`;
  }).join(' ');
  return (
    <svg className="crash-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <polygon points={points} fill="var(--danger)" />
      <path d="M8 4.4v4.4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r="1" fill="#fff" />
    </svg>
  );
}

export function CrashNotice({
  crashes,
  onShow,
  onShowAll,
}: {
  crashes: Crash[];
  /** Take the map to this crash, or to the alert when it has no place. */
  onShow: (crash: Crash) => void;
  onShowAll: () => void;
}) {
  if (crashes.length === 0) return null;
  const rest = crashes.length - SHOWN;
  return (
    <div className="crash-notice" role="status" aria-label="Reported crashes">
      {crashes.slice(0, SHOWN).map((crash) => (
        <button
          key={crash.alert.id}
          type="button"
          className="crash-notice__item"
          onClick={() => onShow(crash)}
          title={crash.alert.header}
        >
          <CrashIcon />
          <span className="crash-notice__text">{crashSummary(crash)}</span>
          <span className="crash-notice__go">{crash.place ? 'Show' : 'Read'}</span>
        </button>
      ))}
      {rest > 0 && (
        <button type="button" className="crash-notice__item crash-notice__item--more" onClick={onShowAll}>
          <span className="crash-notice__text">
            and {rest} more reported {rest === 1 ? 'crash' : 'crashes'}
          </span>
          <span className="crash-notice__go">Alerts</span>
        </button>
      )}
    </div>
  );
}
