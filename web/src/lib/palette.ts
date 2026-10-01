/**
 * The colours of livetrains.
 *
 * One idea runs through all of it: colour means something. Routes wear their
 * agency's official line colours, a signal green means "live", amber and red
 * mean "late" and "trouble" — and everything else is a grey with a slight
 * blue cast, so that the colours that do appear carry the whole message.
 *
 * Dark is the primary theme: transit maps read beautifully on a dark ground,
 * and a near-black with a touch of blue lets warm route colours sit forward
 * rather than glare. The light theme keeps the same rules on a paper ground.
 *
 * The stylesheet's custom properties mirror these values; the map's own
 * layers, which cannot read CSS, take them from here.
 */
export interface Palette {
  /** The ground everything sits on. */
  bg: string;
  /** Panels, one step up. */
  surface: string;
  /** Inputs and rows, two steps up. */
  surface2: string;
  /** 1px rules. */
  rule: string;
  text: string;
  muted: string;
  faint: string;
  /** Live data, on time. */
  live: string;
  /** Late, or a warning. */
  late: string;
  /** Cancelled, closed, severe. */
  danger: string;

  // --- The basemap ---------------------------------------------------------
  land: string;
  landcover: string;
  water: string;
  waterLabel: string;
  building: string;
  roadMajor: string;
  roadMid: string;
  roadMinor: string;
  rail: string;
  placeLabel: string;
  neighbourhoodLabel: string;
  streetLabel: string;
  /** Halo around map text: the ground colour, so labels knock out what is under them. */
  halo: string;
  /** The faint halftone on bare ground. */
  textureDot: string;

  // --- Overlays drawn by the app -------------------------------------------
  stopFill: string;
  stopStroke: string;
  stopLabel: string;
  /** The gap drawn around bold lines, so crossings read like a route diagram. */
  casing: string;
  badge: string;
  badgeText: string;
}

export const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: {
    bg: '#0B0E14',
    surface: '#10141B',
    surface2: '#171C25',
    rule: '#242A35',
    text: '#EDF0F5',
    muted: '#8E97A8',
    faint: '#5E6677',
    live: '#3FE0A0',
    late: '#F5A524',
    danger: '#F0443A',

    land: '#0B0E14',
    landcover: '#0D1118',
    water: '#0A1523',
    waterLabel: '#3B5068',
    building: '#10141B',
    roadMajor: '#252C3A',
    roadMid: '#1C222E',
    roadMinor: '#161B25',
    rail: '#242A37',
    placeLabel: '#9AA3B4',
    neighbourhoodLabel: '#596274',
    streetLabel: '#4F5869',
    halo: '#0B0E14',
    textureDot: '#151A23',

    stopFill: '#0B0E14',
    stopStroke: '#E2E7EF',
    stopLabel: '#D2D8E2',
    casing: '#0B0E14',
    badge: '#1B212C',
    badgeText: '#E6EAF0',
  },
  light: {
    bg: '#E9ECF0',
    surface: '#F6F7F9',
    surface2: '#ECEFF3',
    rule: '#D0D5DD',
    text: '#0B0E14',
    muted: '#4E5768',
    faint: '#7A8395',
    live: '#0B8F5E',
    late: '#B26100',
    danger: '#C8102E',

    land: '#E9ECF0',
    landcover: '#E2E6EB',
    water: '#C7D2DF',
    waterLabel: '#6F8099',
    building: '#DDE1E7',
    roadMajor: '#FFFFFF',
    roadMid: '#FAFBFC',
    roadMinor: '#F4F6F8',
    rail: '#C9CED7',
    placeLabel: '#3F4757',
    neighbourhoodLabel: '#7A8395',
    streetLabel: '#7F8899',
    halo: '#E9ECF0',
    textureDot: '#DCE0E6',

    stopFill: '#FFFFFF',
    stopStroke: '#0B0E14',
    stopLabel: '#1A202B',
    casing: '#E9ECF0',
    badge: '#FFFFFF',
    badgeText: '#0B0E14',
  },
};
