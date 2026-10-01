/**
 * Where the sun is, roughly: enough to know whether it is dark outside.
 *
 * The "auto" theme follows the sun at the agency's own location rather than
 * the device's dark-mode setting, because the question it answers is "is it
 * dark at the bus stop?" — and a phone left in light mode at 9pm in January
 * is still looking at a dark street.
 *
 * NOAA's low-precision solar position: good to a fraction of a degree, which
 * at the horizon is a minute or two. Nobody needs the theme to change on the
 * exact second of sunset.
 */

const RAD = Math.PI / 180;

/** The sun's elevation above the horizon in degrees; negative is below it. */
export function solarElevation(date: Date, lat: number, lon: number): number {
  // Days since J2000.0, in UTC.
  const days = date.getTime() / 86_400_000 - 10_957.5;
  const meanLongitude = (280.46 + 0.9856474 * days) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * days) % 360) * RAD;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * days) * RAD;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));

  // Greenwich mean sidereal time, in degrees, then local hour angle.
  const sidereal = (280.46061837 + 360.98564736629 * days) % 360;
  const hourAngle = (sidereal + lon) * RAD - rightAscension;

  const sinElevation =
    Math.sin(lat * RAD) * Math.sin(declination) + Math.cos(lat * RAD) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinElevation))) / RAD;
}

/**
 * Whether it is dark enough outside for the dark map.
 *
 * Switched at the end of civil twilight's first half rather than at sunset:
 * at the moment the sun touches the horizon a street is still perfectly
 * light, and a sudden black map would look like a mistake.
 */
export function isDarkOutside(date: Date, lat: number, lon: number): boolean {
  return solarElevation(date, lat, lon) < -3;
}
