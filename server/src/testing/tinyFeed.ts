import { GtfsStore } from '../gtfs/store.js';

/**
 * The smallest feed that parses, for tests about one narrow thing.
 *
 * Four stops on a single trip. Three of them sit within a short walk of each
 * other so a transfer graph links them; `far` is kilometres away so it is
 * linked only when the feed explicitly says it should be.
 *
 *   a ── 33m ── b
 *   │
 *  31m
 *   │
 *   c                    far, 3.3km south
 */
export const TINY_STOPS = {
  a: { lat: 44.98, lon: -93.27 },
  b: { lat: 44.9803, lon: -93.27 },
  c: { lat: 44.98, lon: -93.2704 },
  far: { lat: 44.95, lon: -93.27 },
} as const;

export function tinyFeedFiles(transfers?: string): Map<string, string> {
  const files = new Map<string, string>([
    ['agency.txt', 'agency_id,agency_name,agency_timezone\na,A,America/Chicago\n'],
    [
      'stops.txt',
      ['stop_id,stop_name,stop_lat,stop_lon']
        .concat(
          Object.entries(TINY_STOPS).map(
            ([id, { lat, lon }]) => `${id},Stop ${id.toUpperCase()},${lat},${lon}`,
          ),
        )
        .join('\n'),
    ],
    ['routes.txt', 'route_id,route_short_name,route_type\nr,1,3\n'],
    ['trips.txt', 'route_id,service_id,trip_id\nr,svc,t\n'],
    [
      'stop_times.txt',
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
        't,08:00:00,08:00:00,a,1\nt,08:10:00,08:10:00,far,2\n',
    ],
    [
      'calendar.txt',
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
        'svc,1,1,1,1,1,1,1,20200101,20400101\n',
    ],
  ]);
  if (transfers !== undefined) files.set('transfers.txt', transfers);
  return files;
}

export function tinyStore(transfers?: string): GtfsStore {
  return GtfsStore.load(tinyFeedFiles(transfers));
}

/** Header for a transfers.txt body, so tests only write the rows. */
export const TRANSFER_HEADER = 'from_stop_id,to_stop_id,transfer_type,min_transfer_time';
