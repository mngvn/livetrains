import { positionAt, type Journey, type JourneyPosition } from './journey.ts';

/**
 * The clock that drives journey playback.
 *
 * Kept out of React state on purpose. The traveller moves every animation
 * frame, and routing sixty state updates a second through the component tree
 * would re-render the whole app to move one dot. Instead this owns the time,
 * runs the frame loop, and notifies subscribers — the map updates its layers
 * imperatively, exactly as the live vehicle layer already does, and the
 * controls sample at a rate a human can read.
 */

export type PlaybackListener = (state: PlaybackState) => void;

export interface PlaybackState {
  journey: Journey | null;
  playing: boolean;
  /** Where the traveller is now, or null when nothing is loaded. */
  position: JourneyPosition | null;
  /** Unix seconds into the journey's own clock. */
  time: number;
  speed: number;
}

/**
 * How many seconds of journey pass per second of watching, by default.
 *
 * A half-hour trip plays in about twenty seconds, which is long enough to
 * follow and short enough to watch twice.
 */
export const DEFAULT_SPEED = 90;
export const SPEEDS = [30, 90, 240] as const;

export class JourneyPlayback {
  private journey: Journey | null = null;
  private playing = false;
  private time = 0;
  private speed: number = DEFAULT_SPEED;
  private frame: number | null = null;
  private lastFrameMs = 0;
  private readonly listeners = new Set<PlaybackListener>();

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => {
      this.listeners.delete(listener);
    };
  }

  state(): PlaybackState {
    return {
      journey: this.journey,
      playing: this.playing,
      position: this.journey ? positionAt(this.journey, this.time) : null,
      time: this.time,
      speed: this.speed,
    };
  }

  /**
   * Points the player at a journey, or at nothing.
   *
   * Always rewinds: loading a trip and resuming halfway through the previous
   * one would put the traveller somewhere they have never been.
   */
  load(journey: Journey | null): void {
    this.journey = journey;
    this.time = journey ? journey.startTime : 0;
    this.playing = false;
    this.stopFrames();
    this.emit();
  }

  play(): void {
    if (!this.journey || this.playing) return;
    // Pressing play at the end replays rather than doing nothing, which is
    // what someone who has just watched it to the end is asking for.
    if (this.time >= this.journey.endTime) this.time = this.journey.startTime;
    this.playing = true;
    this.lastFrameMs = performance.now();
    this.startFrames();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.stopFrames();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.emit();
  }

  /** Scrubs to a fraction of the way through, pausing as it goes. */
  seekFraction(fraction: number): void {
    if (!this.journey) return;
    const clamped = Math.min(Math.max(fraction, 0), 1);
    this.time = this.journey.startTime + this.journey.durationSeconds * clamped;
    this.pause();
    this.emit();
  }

  dispose(): void {
    this.stopFrames();
    this.listeners.clear();
  }

  private startFrames(): void {
    if (this.frame !== null) return;
    const step = (now: number) => {
      this.frame = null;
      if (!this.playing || !this.journey) return;

      const elapsed = (now - this.lastFrameMs) / 1_000;
      this.lastFrameMs = now;
      // A backgrounded tab delivers one enormous frame on return. Capping the
      // step means the journey resumes where it paused rather than jumping to
      // the end.
      this.time += Math.min(elapsed, 0.25) * this.speed;

      if (this.time >= this.journey.endTime) {
        this.time = this.journey.endTime;
        this.playing = false;
        this.emit();
        return;
      }
      this.emit();
      this.startFrames();
    };
    this.frame = requestAnimationFrame(step);
  }

  private stopFrames(): void {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}
