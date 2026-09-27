import { useEffect, useRef, useState } from 'react';
import { SPEEDS, type JourneyPlayback, type PlaybackState } from '../lib/journeyPlayback.ts';
import { clockTime } from '../lib/format.ts';

/**
 * The transport controls for a journey.
 *
 * Subscribes to the playback clock rather than being driven by React state,
 * and deliberately throttles what it shows: the traveller moves every frame,
 * but a caption and a clock that changed sixty times a second would be
 * unreadable, and re-rendering them that often would cost more than the
 * animation itself.
 */

/** Redraw the text about this often. Fast enough to feel live, slow enough to read. */
const CAPTION_HZ = 6;

export function JourneyPlayer({
  playback,
  onClose,
  panelHidden,
}: {
  playback: JourneyPlayback;
  onClose: () => void;
  /** With the side panel away, the map is the whole window to centre over. */
  panelHidden: boolean;
}) {
  const [state, setState] = useState<PlaybackState>(() => playback.state());
  const lastPaint = useRef(0);

  useEffect(() => {
    return playback.subscribe((next) => {
      const now = performance.now();
      // Always paint a change of playing state or a new journey, whenever it
      // lands; only the continuous parts are sampled.
      const structural = next.playing !== state.playing || next.journey !== state.journey;
      if (!structural && now - lastPaint.current < 1_000 / CAPTION_HZ) return;
      lastPaint.current = now;
      setState(next);
    });
    // `state` is read only to compare against the incoming value; resubscribing
    // whenever it changes would tear down the subscription every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback]);

  const { journey, position, playing, time, speed } = state;
  if (!journey || !position) return null;

  const fraction = journey.durationSeconds > 0 ? (time - journey.startTime) / journey.durationSeconds : 0;
  const remaining = Math.max(0, Math.round((journey.endTime - time) / 60));

  return (
    <section className={`journey${panelHidden ? ' is-wide' : ''}`} aria-label="Journey playback">
      <header className="journey__head">
        <span className="journey__dot" style={{ background: position.step.color }} aria-hidden="true" />
        <div className="journey__caption">
          <strong>{position.step.label}</strong>
          <em>{position.step.detail}</em>
        </div>
        <button type="button" className="journey__close" onClick={onClose} aria-label="Close playback">
          ×
        </button>
      </header>

      <div className="journey__transport">
        <button
          type="button"
          className="journey__play"
          onClick={() => playback.toggle()}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>

        <input
          className="journey__scrub"
          type="range"
          min={0}
          max={1000}
          value={Math.round(fraction * 1000)}
          onChange={(event) => playback.seekFraction(Number(event.target.value) / 1000)}
          aria-label="Position in journey"
          // The clock is the meaningful value here; the raw 0-1000 is an
          // implementation detail of how finely the slider can be dragged.
          aria-valuetext={`${clockTime(time)}, ${remaining} minutes remaining`}
        />

        <span className="journey__clock">{clockTime(time)}</span>
      </div>

      <div className="journey__footer">
        <span className="journey__remaining">
          {remaining === 0 ? 'Arrived' : `${remaining} min to go`}
        </span>
        <div className="journey__speeds" role="group" aria-label="Playback speed">
          {SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              className="journey__speed"
              aria-pressed={option === speed}
              onClick={() => playback.setSpeed(option)}
            >
              {option / 30}×
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
