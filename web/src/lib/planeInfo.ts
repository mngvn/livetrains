import type { Plane } from '@shared/planes.ts';

/**
 * How an aircraft is named and described, on the map and in its panel.
 *
 * Written for someone standing at a bus stop looking up, not for a pilot:
 * "Delta 1554", "3,400 ft and descending", "210 mph" — not "DAL1554, FL034,
 * 182kt GS". The codes are still shown, smaller, for anyone who wants them.
 */

/** The jet the map draws, nose up in a 40×40 box, for the legend and panels. */
export const PLANE_PATH =
  'M20 4.5c.8 0 1.5.7 1.5 1.5v8.7L35 23v2.6l-13.5-3.6v7.4l5 3.8v2l-6.5-1.6-6.5 1.6v-2l5-3.8v-7.4L5 25.6V23l13.5-8.3V6c0-.8.7-1.5 1.5-1.5Z';

/** The silhouette the map draws: an airliner, a light aircraft, a helicopter. */
export type PlaneShape = 'jet' | 'light' | 'heli';

/** ICAO type designators of common light aircraft, for feeds that omit the category. */
const LIGHT_TYPES = /^(C1\d\d|C2\d\d|C3\d\d|P28|P32|PA\d|SR2\d|BE\d|M20|DA[24]\d|RV\d|AA5|G1\d\d|CH\d|TBM|PC12|AT\d|C77R)/;
/** And of helicopters. */
const ROTOR_TYPES = /^(EC\d|AS\d|H\d\d|R22|R44|R66|B06|B407|B412|B429|A109|A119|A139|S76|MD\d|EN28|BK17)/;

export function planeShape(plane: Pick<Plane, 'category' | 'typeCode'>): PlaneShape {
  const category = plane.category ?? '';
  if (category === 'A7') return 'heli';
  // A1 light, B1 glider, B4 ultralight, B6 drone.
  if (/^(A1|B1|B4|B6)$/.test(category)) return 'light';
  const type = plane.typeCode?.toUpperCase() ?? '';
  if (ROTOR_TYPES.test(type)) return 'heli';
  if (!category && LIGHT_TYPES.test(type)) return 'light';
  return 'jet';
}

/** The short name drawn beside a plane: its callsign, else its tail number. */
export function planeLabel(plane: Pick<Plane, 'callsign' | 'registration' | 'id'>): string {
  return plane.callsign ?? plane.registration ?? plane.id.replace(/^~/, '').toUpperCase();
}

/** "3,400 ft", "On the ground", or nothing when the height is not reported. */
export function planeHeight(plane: Pick<Plane, 'altitude' | 'onGround'>): string {
  if (plane.onGround) return 'On the ground';
  if (plane.altitude === undefined) return '';
  // To the nearest hundred, as a pilot would say it.
  const feet = Math.round(plane.altitude / 100) * 100 || plane.altitude;
  return `${feet.toLocaleString('en-US')} ft`;
}

/** "Climbing", "Descending", "Level", from the vertical rate. */
export function planeTrend(plane: Pick<Plane, 'verticalRate' | 'onGround'>): 'climbing' | 'descending' | 'level' | null {
  if (plane.onGround || plane.verticalRate === undefined) return null;
  // Under a few hundred feet a minute is a plane holding its height.
  if (plane.verticalRate > 300) return 'climbing';
  if (plane.verticalRate < -300) return 'descending';
  return 'level';
}

/** Ground speed in the units the rest of the app uses. */
export function planeSpeedMph(plane: Pick<Plane, 'groundSpeed'>): number | null {
  return plane.groundSpeed === undefined ? null : Math.round(plane.groundSpeed * 1.15078);
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** "heading northwest". */
export function compassWord(degrees: number): string {
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

/**
 * The carriers seen at Twin Cities airports, by ICAO prefix, for naming a
 * flight before (or without) a route lookup. Regional airlines fly under a
 * mainline brand, and riders know the brand.
 */
const AIRLINES: Record<string, { name: string; brand?: string }> = {
  DAL: { name: 'Delta' },
  EDV: { name: 'Endeavor Air', brand: 'Delta Connection' },
  SKW: { name: 'SkyWest' },
  RPA: { name: 'Republic Airways' },
  GJS: { name: 'GoJet' },
  ENY: { name: 'Envoy', brand: 'American Eagle' },
  ASH: { name: 'Mesa Airlines', brand: 'United Express' },
  JIA: { name: 'PSA Airlines', brand: 'American Eagle' },
  QXE: { name: 'Horizon Air', brand: 'Alaska' },
  SCX: { name: 'Sun Country' },
  UAL: { name: 'United' },
  AAL: { name: 'American' },
  SWA: { name: 'Southwest' },
  ASA: { name: 'Alaska' },
  FFT: { name: 'Frontier' },
  NKS: { name: 'Spirit' },
  JBU: { name: 'JetBlue' },
  AAY: { name: 'Allegiant' },
  ACA: { name: 'Air Canada' },
  JZA: { name: 'Jazz', brand: 'Air Canada Express' },
  WJA: { name: 'WestJet' },
  KLM: { name: 'KLM' },
  AFR: { name: 'Air France' },
  ICE: { name: 'Icelandair' },
  DLH: { name: 'Lufthansa' },
  BAW: { name: 'British Airways' },
  AMX: { name: 'Aeroméxico' },
  VIV: { name: 'Viva Aerobus' },
  FDX: { name: 'FedEx' },
  UPS: { name: 'UPS' },
  GTI: { name: 'Atlas Air' },
  ABX: { name: 'ABX Air' },
  ATN: { name: 'Air Transport International' },
  EJA: { name: 'NetJets' },
  LXJ: { name: 'Flexjet' },
};

export interface FlightName {
  /** "Delta 1554", "N1588J", "Life Link III". */
  title: string;
  /** The airline, when the callsign names one. */
  airline?: string;
  /** "Delta Connection", when a regional flies under someone else's name. */
  brand?: string;
}

/**
 * Names a flight from its callsign alone.
 *
 * Airline callsigns are three letters and a number: DAL1554 is Delta's 1554.
 * A US tail number (N…) is a private or charter aircraft, flying under its
 * registration. Anything else is shown as transmitted.
 */
export function flightName(plane: Pick<Plane, 'callsign' | 'registration' | 'id'>): FlightName {
  const callsign = plane.callsign;
  const match = callsign ? /^([A-Z]{3})(\d[0-9A-Z]{0,3})$/.exec(callsign) : null;
  if (match) {
    const airline = AIRLINES[match[1]];
    if (airline) return { title: `${airline.name} ${match[2]}`, airline: airline.name, brand: airline.brand };
  }
  return { title: planeLabel(plane) };
}
