import type { FeedStatus } from '../lib/api.ts';
import type { StreamStatus } from '../lib/vehicleTracker.ts';
import { clockTime } from '../lib/format.ts';

/**
 * Feed health, stated plainly and always on screen.
 *
 * A transit app that quietly shows stale positions is worse than one that
 * admits the feed is down: a rider standing at a stop needs to know whether
 * "3 min" is a live prediction or just the timetable. So the age of the data
 * is always visible, ticking, and every way it can go wrong is said in words
 * rather than left to a colour.
 */

/** Past this, the feed is quiet enough to say so. Keep in step with App. */
export const FEED_STALE_SECONDS = 90;

/** "8s", "2 min", "1 hr": an age short enough for a status line. */
function age(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} hr`;
}

/** The fleet, said like a person would. */
function fleetLine(count: number): string {
  if (count === 0) return 'No vehicles reporting right now';
  if (count === 1) return '1 vehicle moving right now';
  return `${count.toLocaleString()} vehicles moving right now`;
}

export function StatusBar({
  status,
  stream,
  now,
  agencyName,
  online = true,
  lastKnownAt = null,
}: {
  status: FeedStatus | null;
  stream: StreamStatus;
  /** Wall clock, epoch seconds, ticking once a second. */
  now: number;
  /** Who is not responding, when the feed is down. */
  agencyName: string;
  /** Whether the browser has a connection at all. */
  online?: boolean;
  /** When the vehicles on the map were last live, if they are not now. */
  lastKnownAt?: number | null;
}) {
  if (!status) return null;

  // No connection trumps every other message: it explains all of them.
  if (!online) {
    return (
      <div className="status-bar status-bar--offline" role="status">
        <span className="status-bar__dot" aria-hidden="true" />
        <span className="status-bar__text">
          Offline · timetable only
          {lastKnownAt ? ` · vehicles as of ${clockTime(lastKnownAt)}` : ''}
        </span>
      </div>
    );
  }

  const updatedAgo = stream.lastUpdate !== null ? now - stream.lastUpdate : null;
  // Not yet heard from at all is "connecting", not an outage.
  const connecting = !stream.connected && stream.error === null && stream.lastUpdate === null;
  const failing = !stream.connected && !connecting;
  const stale = !failing && updatedAgo !== null && updatedAgo > FEED_STALE_SECONDS;
  const retryIn =
    stream.nextRetryAt !== undefined && stream.nextRetryAt !== null
      ? Math.max(0, Math.ceil(stream.nextRetryAt / 1000 - now))
      : null;

  if (failing) {
    return (
      <div className="status-bar status-bar--down" role="status">
        <span className="status-bar__dot" aria-hidden="true" />
        <span className="status-bar__text">
          {agencyName} isn&rsquo;t responding.{' '}
          {retryIn !== null && retryIn > 0 ? (
            <>
              Retrying in <span className="status-bar__count">{retryIn}s</span>…
            </>
          ) : (
            'Retrying…'
          )}
        </span>
        {(lastKnownAt ?? stream.lastUpdate) !== null && (
          <span className="status-bar__age" title="When the positions on the map were last live">
            {clockTime((lastKnownAt ?? stream.lastUpdate)!)}
          </span>
        )}
      </div>
    );
  }

  if (connecting) {
    return (
      <div className="status-bar" role="status">
        <span className="status-bar__dot" aria-hidden="true" />
        <span className="status-bar__text">Connecting to the live feed…</span>
      </div>
    );
  }

  return (
    <div className={`status-bar${stale ? ' status-bar--stale' : ''}`}>
      <span className={`status-bar__dot${stale ? '' : ' is-live'}`} aria-hidden="true" />
      <span className="status-bar__text">
        {stale ? 'The live feed has gone quiet · positions may be out of date' : fleetLine(stream.vehicleCount)}
      </span>
      {status.mock && <span className="status-bar__badge">demo</span>}
      <span className="status-bar__age" aria-live="off">
        {updatedAgo === null ? 'Waiting for data' : `Updated ${age(updatedAgo)} ago`}
      </span>
    </div>
  );
}
