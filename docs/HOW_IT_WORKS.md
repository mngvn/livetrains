# How livetrains works

A complete tour of the app: where every piece of data comes from, what happens
to it, and how it ends up as a moving map, a departure board or a trip plan.
It is written to be read top to bottom, but each section stands on its own.

- Companion documents: [THIRD_PARTY.md](THIRD_PARTY.md) (every external
  service, dataset and library, with licences and what is sent where) and
  [SECURITY.md](SECURITY.md) (the security model and the hardening pass).
- Live: <https://mngvn.github.io/livetrains/>

---

## Contents

1. [What it is](#1-what-it-is)
2. [The architecture in one picture](#2-the-architecture-in-one-picture)
3. [A map of the repository](#3-a-map-of-the-repository)
4. [The data it runs on](#4-the-data-it-runs-on)
5. [Loading the timetable](#5-loading-the-timetable)
6. [Realtime: positions, predictions and alerts](#6-realtime-positions-predictions-and-alerts)
7. [Trip planning](#7-trip-planning)
8. [Stops, departures, vehicles and search](#8-stops-departures-vehicles-and-search)
9. [Two backends, one interface](#9-two-backends-one-interface)
10. [The front end](#10-the-front-end)
11. [Aircraft overhead](#11-aircraft-overhead)
12. [Offline and storage](#12-offline-and-storage)
13. [Performance and memory](#13-performance-and-memory)
14. [Security in brief](#14-security-in-brief)
15. [Testing, CI and deployment](#15-testing-ci-and-deployment)
16. [Glossary](#16-glossary)

---

## 1. What it is

livetrains is a live transit map and door-to-door trip planner, starting with
Metro Transit in Minneapolis–St Paul. It shows every bus and train moving in
real time, gives full-day departure boards for any stop, plans trips with live
delays folded in, explains why a vehicle is late, shades how far you can get
from a stop in 10/20/30 minutes, and — as a quiet extra — draws the aircraft
flying over the city.

Three properties shape almost every design decision:

- **No keys, no accounts, no bill.** Every data source is open and keyless,
  so anyone can clone and deploy it.
- **It can run with no server at all.** The whole transit engine — GTFS
  parser, RAPTOR router, realtime decoders — runs in a Web Worker in the
  visitor's own browser tab. The public site is just static files on GitHub
  Pages.
- **Any city is configuration, not code.** It reads GTFS and GTFS-Realtime,
  the open standards thousands of agencies publish, so pointing it at another
  agency is a set of environment variables.

The codebase is TypeScript end to end: a Node/Fastify server (`server/`) and a
React + MapLibre client (`web/`), in one npm workspace: about 27,000 lines of
TypeScript and 4,000 of CSS, with around 340 unit tests.

---

## 2. The architecture in one picture

```
                         ┌──────────────────────────── shared core (server/src) ───────────────────────────┐
  Metro Transit          │                                                                                  │
  ─────────────          │   gtfs/archive  ──►  gtfs/csv  ──►  gtfs/store (GtfsStore, typed arrays)          │
  gtfs.zip  (daily) ─────┼──►  unzip           parse            │                                             │
                         │                                      ├──► planner/patterns ──► planner/raptor      │
  vehiclepositions.pb ─┐ │                                      │    planner/transfers     planner/index      │
  tripupdates.pb ──────┼─┼──►  realtime/decode ──► realtime/state ─┤                         (Planner)          │
  alerts.pb ───────────┘ │     (protobuf)          (RealtimeState)  ├──► departures, queries, reachability     │
     (every 15 s)        │                                          └──► network, geocode, summaries           │
                         └──────────────────────────────────────────────────────────────────────────────────┘
                                        │                                              │
                       ┌────────────────┘                                              └───────────────┐
                       ▼                                                                               ▼
          SERVER MODE (server/src/index.ts)                                    BROWSER MODE (web/src/engine)
          Node + Fastify: JSON API + SSE stream                                Web Worker in the visitor's tab
                       │                                                                               │
                       └──────────────────────────────►  web/src/lib/dataSource.ts  ◄──────────────────┘
                                                      (one interface, two backends)
                                                                  │
                                                                  ▼
                                    React app (App.tsx) + MapLibre GL map (TransitMap.tsx)
                                    VehicleTracker / PlaneTracker animate at 60 fps outside React
```

The same modules run in both places. Vite's config contains a small plugin
(`resolveTsFromJs`) that lets the browser build import the server's `.ts`
files directly, so there is no second implementation of the parser,
the router or the decoders to keep in step.

---

## 3. A map of the repository

```
livetrains/
├── server/src/
│   ├── index.ts            Fastify bootstrap, CORS, security headers, static hosting, shutdown
│   ├── config.ts           Every environment variable, parsed and clamped
│   ├── service.ts          TransitService: owns the loaded feed and everything derived from it
│   ├── routes/api.ts       The HTTP API, rate limits, SSE vehicle stream
│   ├── rateLimit.ts        Per-client request budgets and stream counting
│   ├── agencies/           Agency registry (Metro Transit, Duluth) + the AgencyDefinition type
│   ├── gtfs/
│   │   ├── archive.ts      Download with ETag + timeout, unzip with size limits (yauzl)
│   │   ├── csv.ts          Cursor-based CSV reader that reuses one row object
│   │   ├── store.ts        GtfsStore: the parsed timetable in typed arrays, spatial grid, calendar
│   │   └── time.ts         Service days, DST-correct midnights, the >24:00:00 rule
│   ├── realtime/
│   │   ├── poller.ts       Polls the three GTFS-Realtime feeds (server mode)
│   │   ├── decode.ts       Protobuf → plain objects, with the "was it actually sent?" checks
│   │   ├── state.ts        RealtimeState: vehicles, trip updates, alerts, expiry
│   │   └── vehicleDelay.ts How late a vehicle is, from position + prediction + timetable
│   ├── planner/
│   │   ├── patterns.ts     Stop patterns (RAPTOR "routes") and per-day active trips
│   │   ├── transfers.ts    The walking-transfer graph (CSR), honouring transfers.txt
│   │   ├── walk.ts         Street circuity model for walking estimates
│   │   ├── raptor.ts       Round-based earliest-arrival search
│   │   └── index.ts        Planner: access/egress, realtime overlay, itineraries, ranking, arrive-by
│   ├── departures.ts       Departure boards, stop grouping, stop importance, major stops
│   ├── queries.ts          Route detail, stop detail, vehicle trip, transit search
│   ├── reachability.ts     "Everywhere within N minutes" from a stop
│   ├── network.ts          The whole route network as simplified GeoJSON
│   ├── geocode.ts          Stop/landmark search, coordinates, optional Nominatim
│   ├── planes.ts           Aircraft relay for server mode (adsb.lol → adsb.fi)
│   ├── summaries.ts, tiers.ts, geo.ts, log.ts
│   ├── shared/             Types and logic imported by the browser too
│   │   ├── api.ts          The wire contract (type-only)
│   │   ├── lines.ts        Rail / branded line / bus tiers
│   │   └── planes.ts       Aircraft type, feed readers, dead reckoning
│   ├── mock/               Synthetic Twin Cities feed, vehicle simulator, simulated aircraft, fixtures writer
│   └── verifyFeed.ts       Loads the real feed and plans a trip (weekly CI job)
├── web/
│   ├── index.html          Shell + the pre-paint theme script
│   ├── vite.config.ts      Shared-module resolver, CSP plugin, worker + chunk settings
│   ├── public/sw.js        Service worker (offline shell and map tiles)
│   └── src/
│       ├── main.tsx        Fonts, styles, service worker registration, error boundary
│       ├── App.tsx         All app state and wiring
│       ├── engine/         The in-browser backend: worker.ts, client.ts, protocol.ts, gtfsSource.ts
│       ├── components/     TransitMap, mapLayers, mapStyle, basemaps, mapIcons, panels, search, …
│       └── lib/            vehicleTracker, planeTracker, walkRouter, journey, ride, lateness,
│                           networkHealth, reliability, savedTrips, leaveReminder, shareLink, …
├── relay/                  planes-worker.js (Cloudflare Worker) and deno.js (Deno Deploy)
├── .github/workflows/      pages.yml (build + deploy), verify-feed.yml (weekly real-feed check)
└── docs/                   This document, THIRD_PARTY.md, SECURITY.md
```

---

## 4. The data it runs on

### 4.1 Static GTFS — the timetable

GTFS (General Transit Feed Specification) is a zip of CSV files. Metro
Transit publishes one at `https://svc.metrotransit.org/mtgtfs/gtfs.zip`:
about 19 MB compressed, 60 MB unpacked. The app reads eleven files and
ignores the rest (`GTFS_FILES` in `gtfs/store.ts`):

| File | What the app takes from it |
| --- | --- |
| `agency.txt` | Operators (one feed can carry several: Metro Transit's names Maple Grove Transit, SouthWest Transit, the University of Minnesota…), their URL and phone, and the feed's timezone |
| `stops.txt` | Stops and stations, stop codes, platform codes, wheelchair boarding, parent stations; entrances and nodes are remembered only to place pathways |
| `pathways.txt` | Elevators, stairs, escalators and walkways inside stations, for the step-free access section of a stop |
| `routes.txt` | Route names, mode (`route_type`, including the extended 100–1700 range), colours, sort order, operator |
| `trips.txt` | Each trip's route, service, direction, headsign, shape and wheelchair accessibility |
| `stop_times.txt` | The big one (≈868,000 rows): every stop time of every trip, plus pickup/drop-off restrictions |
| `calendar.txt`, `calendar_dates.txt` | Which services run on which dates, and the exceptions (holidays) |
| `shapes.txt` | The drawn path of each trip |
| `transfers.txt` | Agency-stated transfer rules (forbidden, timed, minimum time). Metro Transit does not publish one today; the code honours it where an agency does |
| `feed_info.txt` | Feed version, for the status endpoint |

### 4.2 GTFS-Realtime — what is happening now

Three Protocol Buffers feeds, each a complete snapshot, re-published by Metro
Transit roughly every 15 seconds:

| Feed | URL | Gives |
| --- | --- | --- |
| Vehicle positions | `…/mtgtfs/vehiclepositions.pb` | Where each vehicle is, its bearing and speed, the trip it is running, the stop it is at or approaching, occupancy |
| Trip updates | `…/mtgtfs/tripupdates.pb` | Per-stop predicted times or delays, skipped stops, cancelled trips |
| Service alerts | `…/mtgtfs/alerts.pb` | Detours, closures, elevator outages: header, description, cause, effect, active periods, and exactly which routes/stops/trips they inform |

All four Metro Transit URLs send `Access-Control-Allow-Origin: *`, which is
the single fact that makes the serverless browser mode possible. A weekly CI
job checks that it is still true.

### 4.3 Everything else

| Data | Source | Used for |
| --- | --- | --- |
| Street map vector tiles, glyphs | OpenFreeMap (OpenStreetMap data) | The app's own blue-grey basemap, labels, 3D building footprints |
| Aerial imagery | Esri World Imagery | The satellite basemap |
| Walking paths | FOSSGIS's public Valhalla (OpenStreetMap data) | Real street routes for the walking legs of shown itineraries |
| Aircraft positions | adsb.lol, falling back to adsb.fi (community ADS-B receivers) | Planes over the map |
| Aircraft and flight-route details | adsbdb.com | Type, registration, owner, photo, scheduled origin/destination of a tapped plane |
| Address search (optional, server mode only) | Any Nominatim server (`NOMINATIM_URL`) | Free-text addresses beyond the built-in stop/landmark index |

Full details, terms and privacy implications: [THIRD_PARTY.md](THIRD_PARTY.md).

---

## 5. Loading the timetable

### 5.1 Download and cache

**Server** (`gtfs/archive.ts → downloadGtfs`): the archive is kept at
`data/gtfs/<agency>.zip` with its ETag beside it. If the copy is younger than
`GTFS_MAX_AGE_HOURS` (24) it is used outright; otherwise a conditional request
is sent and a `304` keeps the cached file. Downloads stream to a `.part` file
and are renamed only when complete, so a failed transfer never leaves a
truncated archive that looks valid. The download has a ten-minute timeout and
a 1 GB ceiling, and if the network fails while a cached copy exists, the
cached copy is used rather than failing to boot.

**Browser** (`engine/gtfsSource.ts`): the archive is stored in the Cache
Storage API (`livetrains-gtfs-v1`) with the app's own `x-livetrains-cached-at`
header, so freshness never depends on whatever caching headers the agency
sends. A day-old copy is reused; offline, a stale copy beats no app. Download
progress is reported every 250 KB to the loading screen's little train. When
the server declares a length, bytes stream straight into one pre-sized buffer
rather than being collected in chunks and joined.

### 5.2 Unzipping

The server uses `yauzl` (streaming, entry by entry); the browser uses
`fflate`'s `unzipSync` with a filter so only the eleven wanted files are ever
inflated (`shapes.txt` alone is 15 MB). Directory prefixes inside the zip are
ignored because some agencies nest the feed in a folder. Both sides check the
**declared** uncompressed size of each entry before inflating it — no file
over 512 MB, no more than 1 GB in total — so a malformed or hostile archive
(a "zip bomb") fails with a message instead of exhausting memory.

### 5.3 Parsing CSV

`gtfs/csv.ts` is a purpose-built RFC 4180 reader. It walks the text with an
index cursor, handles quoted fields with doubled quotes, CRLF and BOMs, and
hands the caller **one reused row object** per line. On a multi-million-row
file that keeps the parse out of the garbage collector's way; a general CSV
library allocates several times more.

### 5.4 GtfsStore: the timetable in typed arrays

`GtfsStore.load(files)` builds the in-memory timetable. Stops, routes and
agencies (thousands) stay as objects. Trips and stop times (hundreds of
thousands) are **parallel typed arrays**:

```
tripRoute[t], tripService[t], tripDirection[t], tripWheelchair[t]     one entry per trip
stopTimeStart[t] .. stopTimeStart[t+1]                                 the slice of trip t's stop times
stopTimeStop[i], stopTimeArrival[i], stopTimeDeparture[i],             one entry per stop time
stopTimePickup[i], stopTimeDropOff[i]
```

`stop_times.txt` is read **twice**: the first pass only counts rows per trip,
so every array is allocated once at exactly the right size; the second fills
them. Each trip's slice is then sorted by `stop_sequence` (GTFS does not
promise order), skipping the sort where it is already in order. Held as
objects this data would cost hundreds of megabytes; as `Int32Array`s it is
around 10–20 MB.

`load` also **consumes** its input: each file's text is deleted from the map
as soon as it is parsed, and `shapes.txt` is parsed before `stop_times.txt`,
so the two largest files are never held as text at the same time. On a phone,
that transient peak — not the finished store — is what gets a tab killed.

Other indexes built at load:

- **Stations and pathways.** Platform stops inherit wheelchair boarding from
  their station when they say nothing (as the spec defines); pathways are
  grouped under the station they belong to.
- **Transfer rules** from `transfers.txt`, keyed by a packed `(from, to)`
  integer. Rules scoped to particular routes or trips are skipped, because
  applying them to every connection between two stops would forbid or force
  connections the feed never spoke about.
- **Routes at each stop**, for badges and filtering.
- **A spatial grid** of 0.01° cells (~1.1 km) for nearby-stop search. Queries
  scan only the cells the radius touches *and* only cells inside the grid's
  populated extent — the latter is what stops a query near the poles (where a
  degree of longitude shrinks to nothing) from scanning trillions of columns.

### 5.5 Service days and time

GTFS times are "seconds after the service day's midnight" and legitimately
exceed 24:00:00 — a 12:40 am train is `24:40:00` on the *previous* service
day. `gtfs/time.ts` resolves that:

- `midnightEpoch(date, tz)` finds the instant of local midnight with a
  two-pass correction for days that cross a DST change.
- `candidateServiceDays(now)` returns yesterday, today and tomorrow, each with
  "now" expressed in that day's own seconds-after-midnight frame. Every
  departure, plan and delay calculation considers all three, so late-night
  service is found rather than silently dropped.
- `activeServices(date)` evaluates `calendar.txt` day-of-week bitmasks and
  date ranges plus `calendar_dates.txt` exceptions, memoised per date.

---

## 6. Realtime: positions, predictions and alerts

### 6.1 Polling

`realtime/poller.ts` (server) and the worker's `poll()` (browser) fetch the
three feeds concurrently every `REALTIME_POLL_SECONDS` (15; never under 5),
each with a 20-second timeout. Each feed is applied **independently** — a
failing alerts feed never costs live vehicle positions. A slow poll never
stacks up behind itself. Repeated failures are logged for the first few, then
once a minute. After five minutes without a successful trip-update snapshot,
all predictions are dropped and the app falls back to the timetable and says
so: a ten-minute-old delay presented as live is worse than no prediction.

### 6.2 Decoding

`realtime/decode.ts` uses MobilityData's official `gtfs-realtime-bindings`
(protobuf.js). Two protobuf subtleties are handled deliberately:

- **Defaults masquerade as data.** protobuf.js puts a field's default on the
  message *prototype*, so an unsent bearing reads as 0 (north), unsent
  occupancy reads as `EMPTY`, an unsent `int64 time` reads as 1970, and an
  unsent delay reads as "exactly on time". The decoder only trusts a field if
  it is an own property (`sent()`), and treats a zero timestamp as absent.
- **Wrong content.** A common failure is an HTML error page served from a
  `.pb` URL; the decoder recognises markup/JSON and says so plainly instead of
  surfacing a wire-format error.

Vehicles are enriched from the timetable (route, colour, mode, headsign,
direction, accessibility). Vehicles parked at 0,0 before they log on are
dropped.

### 6.3 RealtimeState

Each poll **replaces** the previous snapshot (GTFS-Realtime feeds are full
snapshots, not deltas; merging would leave buses on the map after they go out
of service). It keeps a trip→vehicle index for matching legs and departures
to live vehicles, and a `tripUpdateVersion` counter that caches downstream
(the planner's realtime overlay, the server's shared SSE frame) key on.

**How late is a vehicle?** (`realtime/vehicleDelay.ts`) GTFS-Realtime never
says directly. The answer is measured at an *anchor* stop: the stop the
vehicle names, otherwise the first non-skipped stop still ahead of it. An
absolute predicted time is preferred to a stated delay (it is what the
producer actually believes); it is compared with the scheduled time at that
stop on whichever service day puts the timetable closest to the prediction,
so a bus straddling midnight is judged against the right day.

**Which alerts apply where** (`state.ts`): alerts keep their *informed
entities* intact. An entity naming a stop applies at that stop whatever route
it also names; one naming only a route applies wherever that route goes; one
naming a route *and a different stop* is a closure elsewhere on the line and
does not apply here. (Flattening these, as an earlier version did, put news of
one closed stop on every stop the route serves.)

---

## 7. Trip planning

### 7.1 Patterns, not routes

GTFS `route_id` is the wrong unit to route on: one bus route contains
short-turns, branches and express variants that stop at different places.
`planner/patterns.ts` groups trips by their exact stop sequence (plus
direction) into **patterns**, within which every trip is interchangeable
stop-for-stop and ordered by departure — which is what lets RAPTOR
binary-search for "the first trip leaving after T". Per service date, the
active trips of each pattern are computed once and memoised.

### 7.2 Walking: the transfer graph and the circuity model

People do not walk in straight lines. `planner/walk.ts` multiplies
straight-line distance by a **circuity factor of 1.35** (gridded North
American cities cluster around 1.3–1.4). Limits are walking distances, so
candidate stops are searched within the *smaller* straight-line radius that
corresponds to them.

`planner/transfers.ts` builds every footpath between stops within 800 m of
walking into a flat CSR structure (`offset`, `target`, `seconds`, `meters`)
so RAPTOR's relaxation loop touches contiguous memory. It:

- lets `transfers.txt` win over geometry (type 3 drops a pair however close;
  stated pairs are added however far; minimum times are respected; timed
  transfers cost no slack),
- always links platforms of the same station,
- keeps only the 12 nearest neighbours per stop to bound dense downtown grids,
- adds 45 seconds of slack to every connection.

### 7.3 RAPTOR

`planner/raptor.ts` implements RAPTOR (Delling, Pajor & Werneck, *Round-Based
Public Transit Routing*). Round *k* finds everything reachable with *k* rides:

1. **Collect** the patterns serving any stop improved last round, starting each
   from its earliest improved position.
2. **Ride** each pattern stop by stop. At each stop, try to alight (if the
   current trip allows drop-off and the stop is not skipped), and try to board
   an earlier trip (binary search per service day, then walk forward past
   cancelled, non-boarding or realtime-delayed trips).
3. **Walk** the transfer graph out of every stop improved by riding.

Labels are pruned against both the best arrival at that stop and the best
known arrival at the destination. All times are absolute epoch seconds; each
candidate service day contributes its own midnight. The rider's request is
honoured up to 6 transfers.

**Realtime in the inner loop.** `Planner.buildOverlay()` projects the trip
updates onto per-trip arrays — `delay: Int32Array`, `cancelled: Uint8Array`,
and a map of skipped stops — rebuilt only when `tripUpdateVersion` changes.
The routing loop does an array index, not a string-map probe. Finer per-stop
predictions are applied once per leg when the itinerary is built.

### 7.4 From labels to an itinerary

`Planner.search()` takes the best destination arrival from each round (the
natural trade-off set: fastest, and fewest changes) and walks the labels
backwards into legs. Ride legs use absolute predicted times where the feed
has them, carry the live vehicle id if one is running the trip, and draw the
trip's GTFS shape clipped to the boarded segment. The access walk is shifted
to finish just as the vehicle arrives, so "leave at" means leave, not "leave
now and stand at the stop for twenty minutes".

**Ranking** drops anything that is later *and* has more transfers *and* more
walking than something already kept, collapses identical-looking options, and
caps the list at five. A walk-only option is always offered for trips under
2 km and never pruned.

**Arrive-by** runs the forward search from six hours before the deadline,
then bisects the departure time with six more searches (to within ~6
minutes), reusing one implementation instead of writing reverse RAPTOR.

**Guard rails.** Coordinates must be on the Earth, a departure time within a
year of today, and walking pace between 0.3 and 3 m/s; anything else gets a
plain message rather than a search.

### 7.5 Real walking directions

The planner's walking estimate is right for *choosing* among thousands of
candidates and wrong for *drawing* one. After a plan is shown,
`lib/refineWalks.ts` asks a Valhalla router (`lib/walkRouter.ts`, default
FOSSGIS's public instance) for each walking leg under 5 km, decodes the
precision-6 polyline, and re-times the itinerary: walks before a ride are
pinned to its departure and run backwards, walks after run forwards, and a
walk that no longer makes its connection is flagged by keeping the later
boarding. Results are cached (least-recently-used, 300 walks; failures retried
after five minutes). Any failure leaves the straight line, so the app works
unchanged with no router at all.

### 7.6 How far can I get?

`reachability.ts` runs the same RAPTOR search from one stop with no
destination (budget 5–60 minutes, two transfers, stops within 250 m counted as
"here") and returns the arrival time at every stop. The client
(`lib/isochrone.ts`) spends the rest of each stop's budget walking (with the
same 1.35 circuity, up to 800 m) over a grid of 160 m cells, taking the best
time per cell and banding into 10/20/30 minutes. A grid reads as a map of the
network's reach; overlapping circles would read as a weather chart.

---

## 8. Stops, departures, vehicles and search

**Departure boards** (`departures.ts`). A "stop" as a rider thinks of it is
often several GTFS stops: both sides of a street, every platform of a
station. `groupedStopIndices` merges a stop's parent station's children and
same-named stops within 150 m. For each grouped stop, pattern and candidate
service day, a binary search finds the first trip not yet gone; each
departure carries scheduled and expected time, live/timetable flag, the
vehicle running it, accessibility, and is **kept but marked** when cancelled
or skipping the stop ("nobody waits for a bus that is not coming"). A vehicle
standing at the stop (the feed's `STOPPED_AT`, or naming the stop and within
40 m) heads the board as "At stop now". `day=1` returns the rest of the
service day, capped at 600 rows.

**Stop importance.** Every stop is classed for the map: *major* (on a rail or
branded line, a station, or served by ≥ 6 routes), *interchange* (two lines,
or a line plus three more routes, or ≥ 8 routes — drawn as a larger hollow
ring), and *onLine* (shown from the widest view).

**Line tiers** (`shared/lines.ts`): `rail` (any train), `branded` (buses sold
as a line — "METRO", "BRT", "Rapid", "… Line"), and `bus`. Decided by name,
not colour, because Metro Transit gives expresses and suburban operators
colours of their own.

**Vehicle trip** (`queries.ts → vehicleTrip`): the trip a selected vehicle is
running, stop by stop, scheduled against predicted. Stops without a
prediction take the delay of the nearest predicted stop before them (how
GTFS-Realtime defines propagation).

**Route network** (`network.ts`): one representative shape per route and
direction (the longest pattern), simplified with Ramer–Douglas–Peucker at
~11 m and rounded to five decimals — the faint underlay that makes moving dots
read as a network. Built once and held.

**Search.** `searchTransit` finds routes by number or name ("16", "Route 21",
"blue line") and stops by every word of the query or by the code on the pole,
collapsing both sides of a street into one result. The trip planner's place
search (`geocode.ts`) scores stops and a short list of landmarks (Mall of
America, MSP terminals, stadiums…) by exact/prefix/word/contains matches,
biased towards the map centre, and parses raw `lat, lon`. In server mode an
optional Nominatim backend tops this up with street addresses, at most one
request a second, cached.

---

## 9. Two backends, one interface

`web/src/lib/dataSource.ts` defines a `DataSource` interface — `plan`,
`stopBoard`, `route`, `vehicleTrip`, `search`, `geocode`, `reachable`,
`alerts`, … — with two implementations. Everything above it is written once.
Which one is used is decided by the build (`VITE_DATA_MODE`) and can be
overridden from the console (`localStorage.livetrains.dataMode`), so a
deployed static page can be pointed at a server for debugging.

### 9.1 Server mode

`server/src/index.ts` starts Fastify, registers CORS and the API, and starts
listening **before** the feed finishes loading so health checks come up at
once; API calls answer `503` with a reason until it is ready. With
`SERVE_STATIC=1` the same process serves the built client, with a single-page
fallback so deep links work.

| Endpoint | Returns |
| --- | --- |
| `GET /api/status` | Feed health: counts, load times, last realtime error |
| `GET /api/agency` | Agency name, timezone, map bounds |
| `GET /api/routes`, `/api/routes/:id` | All routes (rail first); one route's stops, shape and alerts |
| `GET /api/network` | Every route's simplified shape (GeoJSON) |
| `GET /api/stops/nearby`, `/within`, `/major` | Stops near a point, in a viewport, network-wide landmarks |
| `GET /api/stops/:id` (`?day=1`) | Stop detail, station pathways, alerts, departures |
| `GET /api/stops/:id/reachable` | Arrival times everywhere reachable from a stop |
| `GET /api/vehicles`, `/api/vehicles/:id/trip` | Current positions; a vehicle's whole trip |
| `GET /api/vehicles/stream` | Server-Sent Events: a `vehicles` frame on every poll, keep-alive every 25 s |
| `GET /api/search`, `/api/geocode`, `/api/reverse-geocode` | Transit search, place search, naming a dropped pin |
| `GET /api/plan` | Ranked itineraries (`departAt`, `arriveBy`, `maxWalk`, `maxTransfers`, `walkSpeed`) |
| `GET /api/alerts`, `/api/planes` | All alerts, with the position of each stop they name; aircraft over the area (relayed, cached 4 s) |

The vehicle stream uses SSE rather than WebSockets: the traffic is
one-directional and periodic, and SSE survives proxies and reconnects with no
heartbeat protocol. The unfiltered frame is serialised once per update and
shared by every viewer. Each client may hold a bounded number of streams.

Every API request counts against a per-client budget (600/min), and trip
plans and reachability maps against a tighter one (60/min) — see
[SECURITY.md](SECURITY.md).

### 9.2 Browser mode

`web/src/engine/worker.ts` is the whole server in a Web Worker: it downloads
and parses the timetable, builds the planner, polls the realtime feeds and
answers the same methods. `engine/client.ts` gives the page a promise-based
`request(method, params)` over `postMessage`, and **queues** requests made
before the timetable is ready, so the first screen fills in by itself once
loading completes. The worker pushes a `vehicles` message after every poll —
its equivalent of the SSE stream — including whether the vehicle feed itself
answered and when the next poll is due (for the "retrying in…" countdown).

The trade-off is a real first load: ~19 MB to download and several hundred
thousand stop times to parse — a few seconds on a laptop, longer on a phone,
roughly once a day thanks to the cache. Parsing in a worker keeps the map and
the loading animation smooth meanwhile.

---

## 10. The front end

React 19 renders the chrome around the map; the map's contents are
**never** rendered through React. Anything that moves every frame — vehicles,
aircraft, the journey traveller — is pushed straight into MapLibre GeoJSON
sources from small classes that run their own `requestAnimationFrame` loops.
Routing 60 state updates a second through the component tree would cost far
more than the animation.

### 10.1 The map (`TransitMap.tsx`, `mapLayers.ts`, `mapStyle.ts`, `basemaps.ts`)

- **MapLibre GL JS 6**, WebGL, with its tile worker built as its own Vite entry
  and registered with `setWorkerUrl`.
- **The basemap is the app's own style**, drawn from OpenFreeMap's
  OpenMapTiles vector tiles in a few quiet values of one blue-grey, so the
  only colour on the map is the agency's. A satellite style uses Esri World
  Imagery with crisp vector labels on top (declared at half tile size on
  high-density screens for genuinely sharper imagery, capped at zoom 19 where
  Esri's Twin Cities tiles end). If a style cannot load, the map falls back to
  a plain background and keeps drawing all transit data.
- **Layers, bottom to top:** isochrone, network casing/line/highlight, route
  shape, the selected vehicle's trip (drawn on end to end, then split into
  faded behind / bold ahead), its 20-minute trail, the itinerary, stops (three
  classes) and labels, approach links, endpoints, aircraft (trail, way ahead,
  icon, label), vehicle groups, vehicles (dot, glyph, label, hit area), and
  the journey traveller.
- **Selection dims everything else**: choosing a vehicle, stop, route or plan
  sets a focus; `syncSelectionFocus` rewrites paint properties so unrelated
  lines, stops and vehicles step back.
- **Marker size** follows zoom all the way out. A phone shows the whole metro
  about two zoom levels further out than a laptop, so markers keep
  shrinking below zoom 11 instead of stopping at a floor that would turn every
  bus on a phone into a blob.
- **Grouping** (`lib/grouping.ts`): below zoom 12, vehicles that would pile up
  on screen gather into counted discs. The merge distance follows the drawn
  marker size (14 px at metro scale, 22 px near street level), and the discs
  grow with their count and shrink with zoom. A tidying pass then merges any
  two groups whose discs would touch and folds in any lone vehicle whose plate
  would land on a disc, so counts never run together and a tap inside a disc
  always opens the group. Only *membership* is recomputed
  (twice a second, faster while the camera moves); ungrouped vehicles stay on
  the per-frame layer and keep gliding — map-side clustering would make them
  step once a second.
- **Credits** (`components/attribution.ts`): MapLibre's compact attribution is
  shown on arrival and folded into its (i) five seconds after the basemap
  (and with it the OpenStreetMap credit) has arrived and the first-run tour is
  out of the way, or at the first touch of the map, as the OpenStreetMap
  Foundation's attribution guidelines allow; after that only the rider's taps
  open or close it, even when the control is rebuilt for a new aircraft
  credit. On a wide screen it sits just beside the planner rather than under
  it, so the (i) is always in view and one tap away.
- **Approach links** (`lib/approach.ts`): zoomed in, a line ties each vehicle
  to the stop it is pulling into (the feed's word if given, else the nearest
  stop ahead on its route within 300 m), turning green while it stands there.
- **3D**: pitch 55°, rotation enabled, buildings extruded from the vector
  tiles' `render_height`.
- **Camera padding** follows the panels (measured with `ResizeObserver`), so
  the camera always centres in the part of the map you can see.
- **On a phone** the planner and the detail panel take turns in one bottom
  sheet, capped at half the visible height (`--phone-sheet-height`, in
  dynamic viewport units so browser toolbars do not eat into the map, and
  never under 300 px) and see-through: an 88% tint of the panel colour over a
  light blur of the map beneath, solid for anyone who asks their system for
  reduced transparency.

### 10.2 Moving vehicles (`lib/vehicleTracker.ts`)

Reports arrive every 10–20 seconds. Drawing them as they land makes buses hop
several blocks at a time, so each vehicle glides at constant speed from where
it is *drawn* towards where it last *reported*, timed to arrive slightly
after the next report is due (×1.2). When that report lands the vehicle is
still moving and simply turns towards the new target — one continuous glide.
The cadence is measured from the gap between messages (smoothed, clamped), not
assumed. Headings rotate the short way round. A feed repeating the same
report does not restart the glide. Vehicles missing from a message are kept
for a 60-second grace period; a position older than three minutes is drawn
greyed ("stale"), never dropped. Each vehicle keeps a 20-minute trail of
reports, which also feeds the delay history used by "why is it late?".

### 10.3 Panels and features

- **Stop panel**: the full-day departure board, refreshed every 30 s, with a
  colour spine per route (filled for live, hollow for timetable, struck through
  for cancelled), keyboard navigation, a per-stop route/mode filter remembered
  in `localStorage`, step-free access from `pathways.txt`, alerts, lines
  through the stop (lit up on the map), and the reachability shading.
- **Vehicle panel**: operator, delay, accessibility, occupancy, the stops ahead
  scheduled vs predicted, "ride this bus".
- **Why is it late?** (`lib/lateness.ts`): for vehicles ≥ 3 min late, evidence
  in the order a rider finds convincing — an agency alert on the line, bunching
  (caught up with the vehicle in front within 700 m along the line), the delay
  growing or steady over its trail, or that it set out late — and an honest
  "nothing explains it" otherwise.
- **Network status** (`lib/networkHealth.ts`): per line, the worse of what its
  vehicles say (median delay; how many are > 5 min late) and what its
  line-wide alerts say: Suspended / Severe delays / Disrupted / Minor delays /
  Good service / Not running now. Trip-cancellation notices are not mistaken
  for a suspended line.
- **Alerts**: everywhere they matter, plus an Alerts tab filtered by kind and
  route; elevator/ramp outages are promoted to "Accessibility" even when filed
  as generic notices. While the tab is open the map draws what it lists
  (`lib/alertMap.ts`): one dot per alerted stop in its worst alert's tone,
  clustered at network scale, upcoming ones faded, and lines with a
  route-wide alert brought forward.
- **Leave reminder** (`lib/leaveReminder.ts`): "Leave in 6 min", re-derived
  every 30 s from the live prediction for that exact trip at the boarding stop,
  minus the walk, minus a minute's slack. An armed reminder fires two minutes
  before, as a banner, a tab-title change and (if permitted) a system
  notification.
- **Saved trips and reliability** (`lib/savedTrips.ts`, `lib/reliability.ts`):
  up to 12 saved trips in `localStorage`. While the app is open, once a
  minute, the departures at each saved boarding stop are read and how each
  watched bus or train actually left is recorded to IndexedDB (kept 120 days),
  summarised as "on time 8 in 10 · usually 2 min late" (on time = from 1 min
  early to 5 min late; shown after 5 observations).
- **Ride along** (`lib/ride.ts`, `RideBanner.tsx`): follow the vehicle you are
  on; the banner counts stops down, says "get ready", "your stop is next",
  "get off here", vibrates and notifies for the last two, and the camera
  follows the vehicle (pausing for 10 s whenever you move the map).
- **Journey playback** (`lib/journey.ts`, `lib/journeyPlayback.ts`): any
  itinerary re-cut as walk / wait / ride steps with cumulative-distance tables
  (so position at any instant is a lookup and a lerp), played at 30×, 90× or
  240× with the camera following and everything else dimmed. The waits are
  explicit steps because they are most of what makes a trip feel long.
- **Share links** (`lib/shareLink.ts`): `?from=lat,lon&fromName=…&to=…`,
  `?stop=`, `?route=`. The address bar always describes what is on screen
  (`replaceState`, so tapping around does not fill the back button). "My
  location" is never written into a link.
- **Theme** (`lib/theme.ts`, `lib/sun.ts`): dark by default; "Auto" computes the
  sun's elevation at the agency's location (NOAA low-precision formula) and
  goes dark below −3°, whatever the phone's own setting. An inline script in
  `index.html` applies a best guess before first paint.
- **Onboarding**: a four-card first-run tour that ends by playing a real trip
  (Target Field to Union Depot on the Green Line), replayable from the legend.

---

## 11. Aircraft overhead

**Why a relay.** adsb.lol and adsb.fi publish what volunteers' ADS-B receivers
hear, keyless, in the same readsb "v2" JSON — but send no CORS headers, so a
page cannot read them. In server mode the API relays them (`planes.ts`: one
fetch shared by every client, cached 4 s, concurrent requests share the one in
flight, the feed that last answered is tried first, and a minute-old answer is
served during an upstream blip). On a static host, a one-file relay
(`relay/planes-worker.js`) runs on Cloudflare Workers or Deno Deploy. It
answers exactly one path, `/planes/{lat}/{lon}/{radius}`, caps the radius at
100 nm, rounds the centre to two decimals so a city's visitors share a cached
answer for five seconds, and can be restricted to the site's own origin.

**The area** (`shared/planes.ts → planeArea`) is the circle covering the
agency's bounding box plus 15 nm, so a plane is already on the map as it
crosses into view. Ground vehicles and obstacles (ADS-B category C) and
positions older than a minute are discarded on read.

**Motion** (`lib/planeTracker.ts`): buses are interpolated with a feed's worth
of lag; at jet speeds that would be a mile behind. Aircraft report ground
speed and track, so they are **dead-reckoned**: drawn where the last report
says they are *now*, carried forward along their track for up to 25 s. When a
new report lands, the gap between guess and truth is blended away over 2 s, so
a turning plane bends round instead of teleporting. Polling (every 10 s) runs
only while the tab is visible and backs off from 20 s to 2 min after errors.
The device's clock skew is corrected using the feed's own `now`.

**Drawing**: thin yellow silhouettes (jet, light aircraft or helicopter, from
the emitter category or type code) beneath the transit, fainter the higher
they fly; parked aircraft only appear zoomed in on the airport; planes step
back whenever the map is about a bus, stop or trip, and disappear during
journey playback.

**The plane panel** looks the tapped aircraft up on adsbdb (airframe by ICAO
hex; scheduled route by airline callsign), names the flight the way a person
would ("Delta 1554", "Descending into Minneapolis, 3,100 ft"), and only shows
a route if the plane is plausibly on it (within 60 km of an end, or not far off
the great circle between them) because flight numbers get reused.
**Where it is going** (`lib/planeBound.ts`) is, in order of certainty: its
published destination; a guess that it is landing (low, descending, pointed at
one of eight local airports); or the city that lies along its heading. The
map draws the way ahead as a dashed great circle.

---

## 12. Offline and storage

**Service worker** (`web/public/sw.js`, production builds only):

| Request | Strategy | Cache |
| --- | --- | --- |
| The page (navigations) | Network first, last copy offline | `livetrains-shell-v1` |
| Hashed build assets (`/assets/…`) | Cache first (names change every build) | `livetrains-shell-v1`, pruned to the current build |
| Map tiles, styles, glyphs, imagery | Stale-while-revalidate, CORS/same-origin responses only | `livetrains-map-v1`, capped at 3,000 entries |
| Realtime feeds, the timetable, the API, walking directions | Never touched | — |

After load the page tells the worker exactly which files it used, so the first
visit's scripts are cached too and files from older builds are dropped.
Realtime is deliberately excluded: an old vehicle position must never be
served as a current one. Instead the app saves the last live fleet to
IndexedDB every 30 s and, on the next visit (within three hours), draws it
faded and dated until live positions replace it.

**Everything the app stores on the device** (nothing is ever sent anywhere):

| Where | Key | What |
| --- | --- | --- |
| Cache Storage | `livetrains-gtfs-v1` | The timetable archive (browser mode) |
| Cache Storage | `livetrains-shell-v1`, `livetrains-map-v1` | App shell and map tiles (service worker) |
| IndexedDB `livetrains` | `observations` | Reliability history for saved trips |
| IndexedDB `livetrains` | `kv` → `lastVehicles` | Last-known vehicle positions |
| localStorage | `livetrains.savedTrips` | Saved trips |
| localStorage | `livetrains.theme`, `.basemap`, `.three`, `.group`, `.planes`, `.panelHidden`, `.onboarded` | Preferences |
| localStorage | `livetrains.boardFilter.<stopId>` | Per-stop departure-board filters |
| localStorage | `livetrains.dataMode`, `.apiUrl`, `.planesUrl` | Developer overrides (set from the console) |

---

## 13. Performance and memory

| Technique | Where | Why |
| --- | --- | --- |
| Parallel typed arrays, two-pass sizing | `gtfs/store.ts` | Hundreds of MB as objects → ~10–20 MB |
| Reused row object in the CSV reader | `gtfs/csv.ts` | Keeps a multi-million-row parse out of the GC |
| Files dropped as they are parsed; shapes before stop times | `GtfsStore.load` | Halves the transient peak that kills phone tabs |
| Only wanted zip entries inflated | `gtfsSource.ts`, `archive.ts` | Skips megabytes of unused files |
| One pre-sized download buffer; no extra copy for the cache | `gtfsSource.ts` | Several fewer 19 MB copies at peak |
| Parse and route in a Web Worker | `engine/worker.ts` | The map never freezes |
| Patterns + binary search + target pruning | `planner/` | Fast RAPTOR without a priority queue |
| Realtime overlay as arrays, rebuilt per snapshot | `Planner.buildOverlay` | Array index in the inner loop |
| CSR transfer graph, 12 neighbours per stop | `planner/transfers.ts` | Contiguous memory; bounded in dense grids |
| Grid index clipped to the populated extent | `GtfsStore.nearbyStops` | Cost follows results, never the query's span |
| Memoised active services/trips per date (bounded) | `store.ts`, `patterns.ts` | Consecutive queries reuse the same days |
| Network geometry simplified and held | `network.ts` | Hundreds of thousands of points → a few thousand |
| Shared SSE frame | `routes/api.ts` | One serialisation per update, not per viewer |
| Animation outside React; groups recomputed at 2–8 Hz | trackers, `TransitMap.tsx` | 60 fps without re-rendering the tree |
| Bounded caches (walks, aircraft lookups, Nominatim, rate-limit windows, tile cache) | various | Long sessions do not grow without limit |
| MapLibre and React in their own chunks | `vite.config.ts` | Cached across app deploys |

Give a server deployment about 512 MB: the parsed Metro Transit feed sits in
the tens of megabytes and peak usage during parsing is higher.

---

## 14. Security in brief

The app holds no accounts, cookies or personal data, and its API is
read-only. The risks are availability (one client exhausting a
single-threaded server), untrusted data from third-party feeds reaching the
page, and the supply chain. The defences — per-client rate limits, input
bounds on every coordinate and number, a Content-Security-Policy, link
sanitising, zip-bomb limits, security headers, dependency hygiene — and the
findings of the latest review are in [SECURITY.md](SECURITY.md).

---

## 15. Testing, CI and deployment

**Tests** (Vitest, ~340 across both packages) run entirely against a
**synthetic feed** (`server/src/mock/`): two light-rail lines sharing a
downtown transfer point, three bus routes crossing them, service past
midnight, two operators, stations with pathways, a vehicle simulator that
places a vehicle on every trip that should be running and interpolates it
along the timetable with stable pseudo-random delays, invented alerts, and a
few simulated aircraft on fixed loops. Tests never depend on the network or on
service running at the moment you look. `npm run fixtures` writes the same
feed out as a real `gtfs.zip` and `.pb` files to exercise browser mode
end to end offline.

**CI** (`.github/workflows/`):

- `pages.yml` — on pushes to `main`: install, typecheck, test, build the client
  in browser mode, publish to GitHub Pages.
- `verify-feed.yml` — weekly: checks the real Metro Transit feeds still answer
  with CORS, that at least one aircraft feed answers and adsbdb still sends
  CORS, then loads the real feed and plans Minneapolis → St Paul, requiring
  every realtime feed to produce data. An upstream change becomes a failed job
  rather than a broken app.
- Dependabot opens grouped dependency updates.

**Deploying**: GitHub Pages (static, browser mode, no secrets), or any Node
host (`npm run build && SERVE_STATIC=1 npm start`). The aircraft relay deploys
separately to Cloudflare Workers or Deno Deploy. Configuration is documented
in the [README](../README.md#configuration).

---

## 16. Glossary

| Term | Meaning |
| --- | --- |
| **GTFS** | General Transit Feed Specification: a zip of CSV files describing a transit timetable |
| **GTFS-Realtime** | Protocol Buffers feeds of live vehicle positions, trip updates and alerts |
| **Service day** | The day a trip belongs to in GTFS; times count from its midnight and may exceed 24:00 |
| **Pattern** | A group of trips with exactly the same stop sequence — RAPTOR's unit of routing |
| **RAPTOR** | Round-Based Public Transit Routing: an earliest-arrival search organised by number of rides |
| **CSR** | Compressed sparse row: an adjacency list stored as an offsets array plus flat target arrays |
| **Circuity** | Real walking distance ÷ straight-line distance (1.35 here) |
| **Isochrone** | The area reachable within a time budget |
| **SSE** | Server-Sent Events: a one-way HTTP stream of messages from server to browser |
| **ADS-B** | Automatic Dependent Surveillance–Broadcast: positions aircraft transmit, received by volunteers |
| **Dead reckoning** | Estimating current position from the last known position, speed and track |
| **CSP** | Content-Security-Policy: a browser-enforced allow-list of where scripts and other resources may come from |
