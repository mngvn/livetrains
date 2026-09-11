# livetrains

A live transit map and door-to-door trip planner. Pick a destination, get the
fastest way there, and watch the actual bus or train move on the map while you
wait for it.

Starts with **Metro Transit** in the Minneapolis–St Paul metro. Because it is
built on GTFS and GTFS-Realtime — open standards used by thousands of agencies
worldwide — adding another city is a config entry rather than a rewrite.

## What it does

- **Live vehicle map.** Every bus and train currently in service, drawn from the
  agency's GTFS-Realtime feed and smoothly interpolated between updates so the
  map reads as live rather than as a slideshow.
- **Door-to-door trip planning.** Enter a destination and get ranked itineraries
  — walk, ride, transfer, walk — with realtime delays folded into the times.
- **Departure boards.** Tap any stop for the next departures, counting down in
  realtime, with both directions of a stop merged the way a rider thinks of it.
- **Route browsing.** Every route, its shape, and only its vehicles on the map.
- **Service alerts** from the agency's alerts feed, attached to the stops and
  routes they affect.

No API key, no billing account, and no third-party signup: the transit feeds are
public and the basemap is open.

## Quick start

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>.

The first start downloads the agency's GTFS archive (~60 MB for Metro Transit)
and caches it under `data/gtfs/`. Subsequent starts reuse the cache and send a
conditional request, so they are fast.

### No network? Run the demo feed

```bash
LIVETRAINS_MOCK=1 npm run dev
```

This serves a synthetic Twin Cities-shaped feed — two light rail lines that
share a downtown transfer point, three bus routes crossing them, simulated
vehicles moving on the timetable, and invented delays. Nothing leaves the
process. It is also what the test suite runs against, so tests never depend on a
live feed or on service running at the moment you look.

### Production

```bash
npm run build
SERVE_STATIC=1 npm start
```

One process then serves both the API and the built client on `PORT` (default
8080).

## How it fits together

```
  Metro Transit                    server/                          web/
  ─────────────                    ───────                          ────
  gtfs.zip ─────────► GtfsStore ──► PatternSet ──► Planner (RAPTOR)
   (schedule)          (typed         (RAPTOR         │
                        arrays)        routes)        │
                           │                          ├──► /api/plan ──────► Trip planner
  vehiclepositions.pb ─┐   ├──► departuresForStops ───┴──► /api/stops/* ───► Departure board
  tripupdates.pb ──────┼─► RealtimePoller ───────────────► /api/vehicles ──► MapLibre map
  alerts.pb ───────────┘    (decode + hold)                  /stream (SSE)
```

### The routing

Trip planning uses **RAPTOR** (Delling, Pajor & Werneck, *Round-Based Public
Transit Routing*). Each round adds one more ride: round 1 is everything
reachable on a single vehicle, round 2 everything reachable with one transfer,
and so on. That structure is why it returns a natural spread of options trading
transfers against arrival time, and why it is fast without a priority queue.

Two details that matter in practice:

- **Patterns, not routes.** GTFS `route_id` is the wrong unit to route on — one
  bus route contains short-turns, branches and express variants that stop at
  different places. Patterns are derived from the stop sequences themselves, so
  every trip within one is interchangeable stop-for-stop.
- **Service days, not calendar days.** GTFS times are seconds after the service
  day's midnight and legitimately exceed 24:00:00 — a 12:40am train is `24:40:00`
  on the *previous* service day. Every query considers yesterday, today and
  tomorrow, so late-night service is found rather than silently dropped.

Realtime is applied in two passes: a per-trip delay array drives the routing
inner loop (an array index, not a string map probe), then per-stop predictions
refine the times once per leg when the itinerary is built.

### Memory

`stop_times.txt` is the large one — roughly 1.5 million rows for Metro Transit.
Held as objects it would cost hundreds of megabytes and stall the GC; held in
parallel `Int32Array`s it costs about 18 MB. The loader makes two passes over
the text so the arrays are allocated once at exactly the right size.

## Adding another city

GTFS is the same everywhere, so this is configuration, not code. Point the
server at any published GTFS feed:

```bash
AGENCY_ID=trimet \
AGENCY_NAME="TriMet (Portland)" \
AGENCY_TIMEZONE=America/Los_Angeles \
AGENCY_GTFS_URL=https://developer.trimet.org/schedule/gtfs.zip \
AGENCY_RT_VEHICLES=https://developer.trimet.org/ws/gtfs/VehiclePositions \
AGENCY_RT_TRIP_UPDATES=https://developer.trimet.org/ws/gtfs/TripUpdates \
AGENCY_BBOX=-123.2,45.2,-122.2,45.7 \
AGENCY_CENTER=-122.68,45.52 \
npm run dev
```

Or add a permanent entry to `server/src/agencies/index.ts`. Duluth Transit is
already defined there as a second example, deliberately kept honest: if adding a
city ever needs more than an entry in that file, the abstraction has broken and
should be fixed rather than worked around.

Feeds for most agencies are listed in the
[Mobility Database](https://mobilitydatabase.org/).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | API server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LIVETRAINS_MOCK` | off | Serve the synthetic demo feed; no network used |
| `SERVE_STATIC` | off in dev | Serve the built web client from the API server |
| `AGENCY_ID` | `metro-transit` | Which registered agency to serve |
| `REALTIME_POLL_SECONDS` | `15` | GTFS-Realtime polling interval |
| `GTFS_MAX_AGE_HOURS` | `24` | How long the cached GTFS archive is reused |
| `PLANNER_MAX_WALK_METERS` | `1200` | Longest access/egress walk |
| `PLANNER_WALK_SPEED` | `1.33` | Walking speed, m/s (~3 mph) |
| `PLANNER_MAX_TRANSFERS` | `3` | Transfer ceiling |
| `NOMINATIM_URL` | unset | Optional address search; local stop and landmark search always works |
| `LOG_LEVEL` | `warn` | Fastify log level |

`AGENCY_GTFS_URL` and the `AGENCY_*` variables above define an agency from the
environment.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/status` | Feed health: counts, load times, last realtime error |
| `GET /api/agency` | Agency name, timezone, map bounds |
| `GET /api/routes` | All routes, rail first |
| `GET /api/routes/:id` | One route's stops, shape and alerts |
| `GET /api/stops/nearby?lat&lon&radius` | Stops near a point, nearest first |
| `GET /api/stops/within?bbox=w,s,e,n` | Stops in a viewport |
| `GET /api/stops/:id` | Stop details plus its departure board |
| `GET /api/vehicles?routeId&bbox` | Current vehicle positions |
| `GET /api/vehicles/stream` | Server-Sent Events stream of positions |
| `GET /api/geocode?q` | Search stops, landmarks, coordinates |
| `GET /api/reverse-geocode?lat&lon` | Name a dropped pin |
| `GET /api/plan?fromLat&fromLon&toLat&toLon` | Ranked itineraries |
| `GET /api/alerts` | All active service alerts |

`/api/plan` also accepts `departAt` (epoch seconds), `arriveBy=true`, `maxWalk`,
`maxTransfers` and `walkSpeed`. An explicit `departAt` is honoured exactly,
including one in the past.

The vehicle stream is Server-Sent Events rather than WebSockets: the traffic is
one-directional and periodic, which is what SSE is for, and it survives proxies
and reconnects without a heartbeat protocol to maintain.

## Development

```bash
npm run dev         # API + web client, both watching
npm test            # server test suite
npm run typecheck   # both packages
npm run build       # production build
```

Tests run entirely against the synthetic feed, so they need no network and do
not break overnight when the real feed stops running.

## Attribution and terms

Schedule and realtime data © the operating agency — Metro Transit by default.
Check the agency's terms before deploying publicly; most, including Metro
Transit, publish these feeds openly for exactly this purpose.

Basemap tiles from [OpenFreeMap](https://openfreemap.org/), map data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. If the
basemap is unreachable the map falls back to a plain background and keeps
drawing vehicles, stops and routes — only the street imagery is lost.
