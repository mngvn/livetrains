/**
 * Time handling for GTFS, which does not use ordinary calendar days.
 *
 * Two GTFS quirks drive everything here:
 *
 *  1. Times are "seconds after midnight of the service day" and may exceed
 *     24:00:00. A 12:40am train is `24:40:00` on the *previous* service day.
 *  2. Service days are in the agency's local timezone, which observes DST.
 *
 * So resolving "what is running right now" means checking yesterday, today and
 * tomorrow's service days, and trusting the seconds-after-midnight arithmetic
 * rather than wall-clock dates.
 */

export const SECONDS_PER_DAY = 86400;

/** A GTFS date as the integer YYYYMMDD, e.g. 20260911. */
export type ServiceDate = number;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Breaks a UTC instant into local wall-clock components for `timeZone`. */
function wallClock(epochSeconds: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** UTC offset in seconds that `timeZone` is observing at a given instant. */
function offsetSeconds(epochSeconds: number, timeZone: string): number {
  const w = wallClock(epochSeconds, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) / 1000;
  return asIfUtc - epochSeconds;
}

export function toServiceDate(year: number, month: number, day: number): ServiceDate {
  return year * 10000 + month * 100 + day;
}

export function splitServiceDate(date: ServiceDate): { year: number; month: number; day: number } {
  return {
    year: Math.floor(date / 10000),
    month: Math.floor((date % 10000) / 100),
    day: date % 100,
  };
}

/**
 * Epoch seconds at local midnight starting `date` in `timeZone`.
 *
 * Two passes: the first guess uses the offset at the naive instant, the second
 * corrects it when that guess landed on the far side of a DST transition.
 */
export function midnightEpoch(date: ServiceDate, timeZone: string): number {
  const { year, month, day } = splitServiceDate(date);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) / 1000;
  let guess = naive - offsetSeconds(naive, timeZone);
  guess = naive - offsetSeconds(guess, timeZone);
  return guess;
}

/** The service date containing `epochSeconds` in `timeZone`. */
export function serviceDateAt(epochSeconds: number, timeZone: string): ServiceDate {
  const w = wallClock(epochSeconds, timeZone);
  return toServiceDate(w.year, w.month, w.day);
}

/** Moves a service date forward or backward by whole days. */
export function shiftServiceDate(date: ServiceDate, days: number): ServiceDate {
  const { year, month, day } = splitServiceDate(date);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return toServiceDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Day of week for a service date, 0 = Sunday, matching calendar.txt columns. */
export function dayOfWeek(date: ServiceDate): number {
  const { year, month, day } = splitServiceDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The service days that could plausibly be running at `epochSeconds`.
 *
 * Yesterday is included because its after-midnight trips (times >= 24:00:00)
 * are still in service now; tomorrow is included so a query late in the evening
 * can still plan into the early morning. Each entry pairs the service date with
 * the seconds-after-*that day's* midnight corresponding to the query instant,
 * which is the value timetable lookups compare against.
 */
export function candidateServiceDays(
  epochSeconds: number,
  timeZone: string,
): { date: ServiceDate; secondsOfDay: number }[] {
  const today = serviceDateAt(epochSeconds, timeZone);
  return [-1, 0, 1].map((offset) => {
    const date = shiftServiceDate(today, offset);
    return { date, secondsOfDay: epochSeconds - midnightEpoch(date, timeZone) };
  });
}

/** Converts a service day plus seconds-after-midnight back to epoch seconds. */
export function epochFor(date: ServiceDate, secondsOfDay: number, timeZone: string): number {
  return midnightEpoch(date, timeZone) + secondsOfDay;
}
