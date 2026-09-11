import type { FeedStatus } from '../lib/api.ts';
import type { StreamStatus } from '../lib/vehicleTracker.ts';
import { relativeAge } from '../lib/format.ts';

/**
 * Feed health, stated plainly.
 *
 * A transit app that quietly shows stale positions is worse than one that
 * admits the feed is down: a rider standing at a stop needs to know whether
 * "3 min" is a live prediction or just the timetable.
 */
export function StatusBar({ status, stream }: { status: FeedStatus | null; stream: StreamStatus }) {
  if (!status) return null;

  const feedProblem = status.realtime.lastError;
  const tone = !stream.connected || feedProblem ? 'warn' : 'ok';

  return (
    <div className={`status-bar status-bar--${tone}`}>
      <span className={`status-bar__dot${stream.connected ? ' is-live' : ''}`} aria-hidden="true" />
      <span className="status-bar__text">
        {stream.connected ? (
          <>
            {stream.vehicleCount} vehicles live · updated {relativeAge(stream.lastUpdate)}
          </>
        ) : (
          (stream.error ?? 'Live feed disconnected')
        )}
      </span>
      {status.mock && <span className="status-bar__badge">demo data</span>}
      {feedProblem && (
        <span className="status-bar__badge status-bar__badge--warn" title={feedProblem}>
          feed error
        </span>
      )}
    </div>
  );
}
