import type { EngineStatus } from '../lib/dataSource.ts';

/**
 * First-load screen.
 *
 * In browser mode the app really is doing something substantial before it can
 * answer anything: downloading a ~19MB timetable and parsing several hundred
 * thousand stop times. A bare spinner for twenty seconds reads as broken, so
 * this reports the actual phase and a real progress bar, and says plainly that
 * it only happens once.
 */

const PHASE_LABEL: Record<string, string> = {
  downloading: 'Downloading the timetable',
  unpacking: 'Unpacking the timetable',
  parsing: 'Reading schedules',
  indexing: 'Building the trip planner',
  ready: 'Ready',
};

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function LoadingScreen({
  status,
  mode,
  onRetry,
}: {
  status: EngineStatus;
  mode: 'browser' | 'server';
  onRetry: () => void;
}) {
  if (status.state === 'failed') {
    return (
      <div className="boot-error">
        <h1>livetrains</h1>
        <p>{status.error ?? 'The transit feed could not be loaded.'}</p>
        <p className="boot-error__hint">
          {mode === 'browser' ? (
            <>
              The app loads Metro Transit&rsquo;s public feed directly from your browser. If the
              agency&rsquo;s server is unreachable, there is nothing to fall back to.
            </>
          ) : (
            <>
              Start the API with <code>npm run dev</code>, or run it against the built-in demo feed
              with <code>LIVETRAINS_MOCK=1 npm run dev</code>.
            </>
          )}
        </p>
        <button type="button" className="chip chip--primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  const progress = status.progress;
  const phase = progress?.phase ?? 'downloading';
  const label = progress?.detail ?? PHASE_LABEL[phase] ?? 'Loading';

  // Only the download reports a byte count; the parsing phases are CPU-bound
  // with no meaningful fraction to show, so they get an indeterminate bar.
  const fraction =
    phase === 'downloading' && progress?.loaded !== undefined && progress.total
      ? Math.min(1, progress.loaded / progress.total)
      : null;

  return (
    <div className="boot-loading">
      <h1 className="boot-loading__brand">livetrains</h1>

      <div className="boot-loading__bar" role="progressbar" aria-label={label}>
        <div
          className={`boot-loading__fill${fraction === null ? ' is-indeterminate' : ''}`}
          style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
        />
      </div>

      <p className="boot-loading__phase">{label}</p>

      {phase === 'downloading' && progress?.loaded !== undefined && (
        <p className="boot-loading__detail">
          {megabytes(progress.loaded)}
          {progress.total ? ` of ${megabytes(progress.total)}` : ''}
        </p>
      )}

      {mode === 'browser' && (
        <p className="boot-loading__note">
          Metro Transit&rsquo;s full timetable is loading straight into your browser — no server in
          between. It is saved afterwards, so this wait only happens once a day.
        </p>
      )}
    </div>
  );
}
