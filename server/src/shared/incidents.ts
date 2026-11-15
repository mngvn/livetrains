import type { ServiceAlert } from './api.js';

/**
 * Which alerts are reports of a crash.
 *
 * The agency says so in one of two ways: by filing the alert's cause as an
 * accident, or only in its wording ("…canceled from 4th St & 15th Ave today
 * due to collision"). Both count. The words are kept few and literal on
 * purpose: an alert about something else that is shown as a crash is worse
 * than a crash shown as an ordinary alert.
 */
const IN_HEADER = /\b(crash(?:es|ed)?|collisions?|collided|accident)\b/i;
const IN_DESCRIPTION = /\b(crash(?:es|ed)?|collisions?|collided)\b/i;

export function isCrashAlert(alert: Pick<ServiceAlert, 'cause' | 'header' | 'description'>): boolean {
  if (alert.cause === 'ACCIDENT') return true;
  return IN_HEADER.test(alert.header) || IN_DESCRIPTION.test(alert.description);
}
