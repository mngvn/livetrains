import type { Itinerary, Leg } from './api.ts';
import { distance } from './format.ts';

/**
 * A planned trip, re-cut as something that can be played back.
 *
 * An itinerary is a list of legs with clock times. That is the right shape for
 * reading and the wrong shape for animating, because the interesting parts of
 * a journey are the ones the legs do not mention: the eight minutes on a
 * platform between arriving on foot and the train turning up. Those gaps are
 * most of what makes a trip feel long, so the timeline makes them explicit as
 * `wait` steps rather than letting the traveller teleport across them.
 *
 * Every step carries its own geometry and a cumulative distance table, so
 * position at an arbitrary instant is a lookup and a lerp rather than a walk
 * from the beginning.
 */

export type StepKind = 'walk' | 'ride' | 'wait';

export interface JourneyStep {
  kind: StepKind;
  /** Unix seconds. */
  startTime: number;
  endTime: number;
  /** [lon, lat] along the step, at least one point. */
  path: [number, number][];
  /** Metres from the start of the step to each point in `path`. */
  cumulative: number[];
  lengthMeters: number;
  /** What the rider is doing, in the present tense. */
  label: string;
  /** Extra line under the label: a headsign, a distance, a countdown. */
  detail: string;
  /** Route colour for a ride; a neutral tone for walking and waiting. */
  color: string;
}

export interface Journey {
  steps: JourneyStep[];
  startTime: number;
  endTime: number;
  durationSeconds: number;
}

export interface JourneyPosition {
  lon: number;
  lat: number;
  /** Degrees clockwise from north; holds its last value while waiting. */
  bearing: number;
  stepIndex: number;
  step: JourneyStep;
  /** Progress through the whole journey, 0 to 1. */
  progress: number;
}

const WALK_COLOR = '#64748b';
const WAIT_COLOR = '#94a3b8';

/** Metres between two lon/lat points, flat-earth but accurate at city scale. */
function metersBetween(a: [number, number], b: [number, number]): number {
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const x = (b[0] - a[0]) * 111_320 * Math.cos(midLat);
  const y = (b[1] - a[1]) * 110_574;
  return Math.hypot(x, y);
}

function bearingBetween(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad);
  const x =
    Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) -
    Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/** Drops consecutive duplicate points, which would make bearings undefined. */
function cleanPath(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    out.push([point[0], point[1]]);
  }
  return out;
}

function measure(path: [number, number][]): { cumulative: number[]; lengthMeters: number } {
  const cumulative = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += metersBetween(path[i - 1], path[i]);
    cumulative.push(total);
  }
  return { cumulative, lengthMeters: total };
}

function describeLeg(leg: Leg): { label: string; detail: string; color: string } {
  if (leg.type === 'walk') {
    const minutes = Math.max(1, Math.round(leg.durationSeconds / 60));
    return {
      label: `Walk to ${leg.to.name}`,
      detail: `${distance(leg.distanceMeters)} · about ${minutes} min`,
      color: WALK_COLOR,
    };
  }
  const name = leg.route.shortName || leg.route.longName || 'the service';
  return {
    label: `Ride ${name} to ${leg.to.name}`,
    detail: leg.headsign ? `towards ${leg.headsign} · ${leg.numStops} stops` : `${leg.numStops} stops`,
    color: `#${leg.route.color}`,
  };
}

/** The point a leg ends at, for the traveller to stand on while waiting. */
function endPoint(leg: Leg): [number, number] {
  const path = cleanPath(leg.geometry as [number, number][]);
  return path.length > 0 ? path[path.length - 1] : [leg.to.lon, leg.to.lat];
}

/**
 * Cuts an itinerary into playable steps.
 *
 * Returns null for an itinerary with nothing to animate, so callers can offer
 * playback only where it means something.
 */
export function buildJourney(itinerary: Itinerary): Journey | null {
  const steps: JourneyStep[] = [];

  for (let i = 0; i < itinerary.legs.length; i++) {
    const leg = itinerary.legs[i];
    let path = cleanPath(leg.geometry as [number, number][]);
    // A leg whose geometry collapsed to a point still has to take its time, so
    // the rest of the clock does not slide forward by its duration.
    if (path.length === 0) path = [[leg.to.lon, leg.to.lat]];
    const { cumulative, lengthMeters } = measure(path);
    const { label, detail, color } = describeLeg(leg);

    steps.push({
      kind: leg.type === 'walk' ? 'walk' : 'ride',
      startTime: leg.departureTime,
      endTime: Math.max(leg.arrivalTime, leg.departureTime),
      path,
      cumulative,
      lengthMeters,
      label,
      detail,
      color,
    });

    // The gap before the next leg is time spent standing still, and it is the
    // part of a trip riders most want to see before committing to it.
    const next = itinerary.legs[i + 1];
    if (next && next.departureTime > leg.arrivalTime) {
      const at = endPoint(leg);
      const minutes = Math.max(1, Math.round((next.departureTime - leg.arrivalTime) / 60));
      const waitingFor =
        next.type === 'transit'
          ? next.route.shortName || next.route.longName || 'the next service'
          : 'to set off';
      steps.push({
        kind: 'wait',
        startTime: leg.arrivalTime,
        endTime: next.departureTime,
        path: [at],
        cumulative: [0],
        lengthMeters: 0,
        label: next.type === 'transit' ? `Wait for ${waitingFor}` : 'Wait',
        detail: `${minutes} min at ${leg.to.name}`,
        color: WAIT_COLOR,
      });
    }
  }

  if (steps.length === 0) return null;
  const startTime = steps[0].startTime;
  const endTime = steps[steps.length - 1].endTime;
  if (!(endTime > startTime)) return null;

  return { steps, startTime, endTime, durationSeconds: endTime - startTime };
}

/**
 * Where the traveller is at an instant.
 *
 * Times outside the journey clamp to its ends rather than returning null: a
 * scrubber dragged past the end should show someone standing at their
 * destination, not nobody standing anywhere.
 */
export function positionAt(journey: Journey, time: number): JourneyPosition {
  const clamped = Math.min(Math.max(time, journey.startTime), journey.endTime);
  const progress = (clamped - journey.startTime) / journey.durationSeconds;

  let index = journey.steps.findIndex((step) => clamped < step.endTime);
  if (index === -1) index = journey.steps.length - 1;
  const step = journey.steps[index];

  const span = step.endTime - step.startTime;
  const fraction = span > 0 ? Math.min(Math.max((clamped - step.startTime) / span, 0), 1) : 1;
  const point = pointAlong(step, fraction);

  return { ...point, stepIndex: index, step, progress };
}

/** Interpolates a position and heading a fraction of the way along a step. */
function pointAlong(step: JourneyStep, fraction: number): { lon: number; lat: number; bearing: number } {
  if (step.path.length === 1 || step.lengthMeters === 0) {
    const [lon, lat] = step.path[0];
    return { lon, lat, bearing: 0 };
  }

  const target = step.lengthMeters * fraction;
  // Steps have tens of points, so a scan is cheaper than a binary search and
  // very much cheaper than the allocation either would save.
  let i = 1;
  while (i < step.cumulative.length - 1 && step.cumulative[i] < target) i++;

  const from = step.path[i - 1];
  const to = step.path[i];
  const segment = step.cumulative[i] - step.cumulative[i - 1];
  const t = segment > 0 ? (target - step.cumulative[i - 1]) / segment : 0;

  return {
    lon: from[0] + (to[0] - from[0]) * t,
    lat: from[1] + (to[1] - from[1]) * t,
    bearing: bearingBetween(from, to),
  };
}

/**
 * The path travelled so far, for drawing a trail behind the traveller.
 *
 * Returned as one line per step rather than one line overall, so a ride and
 * the walk that preceded it keep their own colours.
 */
export function trailAt(journey: Journey, time: number): { path: [number, number][]; color: string }[] {
  const here = positionAt(journey, time);
  const { stepIndex } = here;
  const out: { path: [number, number][]; color: string }[] = [];

  for (let i = 0; i <= stepIndex; i++) {
    const step = journey.steps[i];
    if (step.kind === 'wait' || step.path.length < 2) continue;
    if (i < stepIndex) {
      out.push({ path: step.path, color: step.color });
      continue;
    }
    // The step in progress is cut at the traveller.
    const span = step.endTime - step.startTime;
    const fraction = span > 0 ? Math.min(Math.max((time - step.startTime) / span, 0), 1) : 1;
    const target = step.lengthMeters * fraction;
    const partial: [number, number][] = [step.path[0]];
    for (let p = 1; p < step.path.length && step.cumulative[p] < target; p++) partial.push(step.path[p]);
    partial.push([here.lon, here.lat]);
    // At the instant a step begins the traveller is still on its first point,
    // which would make a line of zero length — a stray dot on the map rather
    // than a trail. Nothing has been travelled yet, so draw nothing.
    const [tailX, tailY] = partial[partial.length - 2];
    if (partial.length > 2 || tailX !== here.lon || tailY !== here.lat) {
      out.push({ path: partial, color: step.color });
    }
  }
  return out;
}
