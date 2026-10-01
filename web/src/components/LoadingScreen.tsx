import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { EngineStatus } from '../lib/dataSource.ts';

/**
 * First-load screen.
 *
 * In browser mode the app really is doing something substantial before it can
 * answer anything: downloading a ~19MB timetable and parsing several hundred
 * thousand stop times. A bare spinner for twenty seconds reads as broken, so
 * this shows the work as a journey: one line across the screen, stations
 * along it, and a train running from end to end as the timetable loads.
 */

/**
 * Where each phase sits along the line, as a fraction of the whole.
 *
 * The download is most of the wait and the only phase with a real byte count,
 * so it gets most of the track. The others are CPU-bound with no fraction to
 * report; the train creeps through their stretch rather than stopping dead,
 * which is what a stalled bar would look like.
 */
const PHASES: Record<string, { from: number; to: number; label: string }> = {
  downloading: { from: 0, to: 0.66, label: 'Loading timetables' },
  unpacking: { from: 0.66, to: 0.74, label: 'Loading timetables' },
  parsing: { from: 0.74, to: 0.9, label: 'Reading the schedules' },
  indexing: { from: 0.9, to: 0.99, label: 'Building the trip planner' },
  ready: { from: 1, to: 1, label: 'Ready' },
};

/** Stations on the progress line: the phase boundaries. */
const STATIONS = [0, 0.66, 0.9, 1];

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The welcome, one letter at a time.
 *
 * Split so each glyph can be given its own delay — a single animated element
 * would rise as a block, which reads as a slide transition rather than as
 * something arriving. Spaces are kept as their own spans so the rhythm of the
 * words survives, and the whole thing is exposed to a screen reader as one
 * string rather than as thirteen separate letters.
 */
function AnimatedWelcome({ text }: { text: string }) {
  return (
    <h1 className="boot-loading__welcome" aria-label={text}>
      {[...text].map((character, index) => (
        <span
          key={`${character}-${index}`}
          className="boot-loading__letter"
          aria-hidden="true"
          // Each letter follows the one before it by a fixed beat, so the line
          // reads left to right at the speed someone would say it.
          style={{ animationDelay: `${index * 40}ms` }}
        >
          {character === ' ' ? ' ' : character}
        </span>
      ))}
    </h1>
  );
}

/** A light-rail car side-on, nose to the right: the direction of travel. */
function TrainGlyph() {
  return (
    <svg className="boot-track__train" viewBox="0 0 40 18" width="40" height="18" aria-hidden="true">
      <path d="M2 3h27.5c4.5 0 8.5 4 8.5 8.5V14H2Z" className="boot-track__train-body" />
      <path d="M6 6h5v4H6Zm8 0h5v4h-5Zm8 0h5v4h-5Zm8.5 0h1.8c1.9 0 3.5 1.6 3.9 4h-5.7Z" className="boot-track__train-window" />
      <circle cx="9" cy="15.5" r="2" className="boot-track__train-wheel" />
      <circle cx="30" cy="15.5" r="2" className="boot-track__train-wheel" />
    </svg>
  );
}

/**
 * How far along the line the train is, eased so it never jumps.
 *
 * The download reports bytes, so its position is exact. Between progress
 * messages, and through the phases that report nothing, the train keeps
 * creeping towards the end of its current stretch — closing a fixed share of
 * the remaining gap each tick, so it slows as it nears the next station
 * rather than overshooting it.
 */
function useTrackPosition(status: EngineStatus): number {
  const progress = status.progress;
  const phase = PHASES[progress?.phase ?? 'downloading'] ?? PHASES.downloading;
  const exact =
    progress?.phase === 'downloading' && progress.loaded !== undefined && progress.total
      ? phase.from + (phase.to - phase.from) * Math.min(1, progress.loaded / progress.total)
      : null;
  const target = useRef({ floor: phase.from, ceiling: phase.to, exact });
  target.current = { floor: phase.from, ceiling: phase.to, exact };
  const [position, setPosition] = useState(phase.from);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPosition((current) => {
        const { floor, ceiling, exact: known } = target.current;
        const next = known ?? current + (ceiling - Math.max(current, floor)) * 0.035;
        // Never backwards: a cached timetable can skip phases out of order.
        return Math.min(ceiling, Math.max(current, floor, next));
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  return status.state === 'ready' ? 1 : position;
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
  const position = useTrackPosition(status);

  if (status.state === 'failed') {
    return (
      <div className="boot-error">
        <p className="boot-error__sign">Service suspended</p>
        <h1>Metro Transit isn&rsquo;t responding</h1>
        <p>{status.error ?? 'The timetable could not be loaded.'}</p>
        <p className="boot-error__hint">
          {mode === 'browser' ? (
            <>
              livetrains loads Metro Transit&rsquo;s public feed straight into your browser. When the
              agency&rsquo;s server cannot be reached there is nothing in between to fall back on.
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
  const phaseId = progress?.phase ?? 'downloading';
  const phase = PHASES[phaseId] ?? PHASES.downloading;
  // A saved timetable says so; otherwise the phase's own words.
  const label = progress?.detail && /saved/i.test(progress.detail) ? progress.detail : phase.label;
  const percent = Math.round(position * 100);

  return (
    <div className="boot-loading">
      <AnimatedWelcome text="Welcome to livetrains" />

      <div
        className="boot-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{ '--progress': position } as CSSProperties}
      >
        <div className="boot-track__line" />
        <div className="boot-track__fill" />
        {STATIONS.map((at) => (
          <span
            key={at}
            className={`boot-track__station${position >= at - 0.001 ? ' is-passed' : ''}`}
            style={{ left: `${at * 100}%` }}
          />
        ))}
        <div className="boot-track__vehicle">
          <TrainGlyph />
        </div>
      </div>

      <p className="boot-loading__phase">{label}</p>

      <p className="boot-loading__detail">
        {phaseId === 'downloading' && progress?.loaded !== undefined
          ? `${megabytes(progress.loaded)}${progress.total ? ` of ${megabytes(progress.total)}` : ''}`
          : `${percent}%`}
      </p>

      {mode === 'browser' && (
        <p className="boot-loading__note">
          Metro Transit&rsquo;s full timetable loads straight into your browser, with no server in
          between. It is kept afterwards, so this wait happens at most once a day.
        </p>
      )}
    </div>
  );
}
