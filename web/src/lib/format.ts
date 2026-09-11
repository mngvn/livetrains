import type { Mode } from './api.ts';

/** Formats an epoch-second timestamp as a local clock time. */
export function clockTime(epochSeconds: number, timeZone?: string): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

/**
 * The countdown riders actually read: "Due", "3 min", "11:42 AM".
 *
 * Anything past an hour becomes a clock time, because "73 min" is harder to act
 * on than the time it will actually show up.
 */
export function countdown(epochSeconds: number, now = Date.now() / 1000, timeZone?: string): string {
  const seconds = epochSeconds - now;
  if (seconds < 30) return 'Due';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return clockTime(epochSeconds, timeZone);
}

/** A duration in minutes, or hours and minutes past an hour. */
export function duration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Distance in the units a walking rider thinks in. */
export function distance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export interface DelayText {
  label: string;
  tone: 'early' | 'ontime' | 'late' | 'none';
}

/** Describes a delay, rounding to the minute riders care about. */
export function delayText(delaySeconds: number | null | undefined): DelayText {
  if (delaySeconds === null || delaySeconds === undefined) return { label: 'Scheduled', tone: 'none' };
  const minutes = Math.round(delaySeconds / 60);
  if (minutes === 0) return { label: 'On time', tone: 'ontime' };
  if (minutes < 0) return { label: `${Math.abs(minutes)} min early`, tone: 'early' };
  return { label: `${minutes} min late`, tone: 'late' };
}

/** Human label for a GTFS mode. */
export function modeLabel(mode: Mode): string {
  switch (mode) {
    case 'tram':
      return 'Light rail';
    case 'metro':
      return 'Subway';
    case 'rail':
      return 'Train';
    case 'bus':
      return 'Bus';
    case 'ferry':
      return 'Ferry';
    case 'cable':
    case 'funicular':
      return 'Cable';
    default:
      return 'Transit';
  }
}

/** An inline SVG glyph per mode, used on route badges and map markers. */
export function modeIcon(mode: Mode): string {
  switch (mode) {
    case 'tram':
    case 'metro':
    case 'rail':
      return 'M4 2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 2v3h8V4H4Zm1 5.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z';
    case 'ferry':
      return 'M8 1 3 4v3l5-2 5 2V4L8 1Zm-6 9 1.5 4h9L14 10l-6 2-6-2Z';
    default:
      return 'M4 1h8a2 2 0 0 1 2 2v7a2 2 0 0 1-1 1.7V13a1 1 0 0 1-2 0v-1H5v1a1 1 0 0 1-2 0v-1.3A2 2 0 0 1 2 10V3a2 2 0 0 1 2-2Zm0 2v4h8V3H4Zm1 5.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z';
  }
}

/**
 * Picks black or white text for a coloured badge.
 *
 * Agencies supply a text colour in GTFS, but plenty get it wrong or leave it at
 * the default white on a pale background. Computing the contrast from relative
 * luminance keeps route badges readable whatever the feed says.
 */
export function readableTextColor(hex: string): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return '#ffffff';
  const channel = (offset: number) => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? '#10151f' : '#ffffff';
}

/** Occupancy as a short phrase rather than a protobuf enum name. */
export function occupancyLabel(occupancy: string | undefined): string | null {
  switch (occupancy) {
    case 'EMPTY':
      return 'Empty';
    case 'MANY_SEATS_AVAILABLE':
      return 'Seats available';
    case 'FEW_SEATS_AVAILABLE':
      return 'Few seats left';
    case 'STANDING_ROOM_ONLY':
      return 'Standing room only';
    case 'CRUSHED_STANDING_ROOM_ONLY':
      return 'Very crowded';
    case 'FULL':
      return 'Full';
    case 'NOT_ACCEPTING_PASSENGERS':
      return 'Not boarding';
    default:
      return null;
  }
}

/** "4 min ago" for feed freshness. */
export function relativeAge(epochSeconds: number | null): string {
  if (epochSeconds === null) return 'never';
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} hr ago`;
}
