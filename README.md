# livetrains

A live transit map and door-to-door trip planner. Pick a destination, get the
fastest way there, and watch the actual bus or train move on the map while you
wait for it.

**Live at <https://mngvn.github.io/livetrains/>** — no install, no account.

Starts with **Metro Transit** in the Minneapolis–St Paul metro. Because it is
built on GTFS and GTFS-Realtime — open standards used by thousands of agencies
worldwide — adding another city is a config entry rather than a rewrite.

## What it does

**On the map**

- **Every bus and train, live.** Drawn from the agency's GTFS-Realtime feed and
  smoothly interpolated between updates, so the map reads as live rather than
  as a slideshow. Trains are square and buses round, each with an arrow for its
  heading, over a faint wash of the whole route network. Zoomed out, each
  vehicle throws a tapering beam of its route colour so a four-pixel dot is
  easy to find, and vehicles gather into counted groups (deep blue when mostly
  trains) until there is room to show them one by one. Both can be switched
  off in the legend.
- **Tap a vehicle** to see who runs it, how late it is, whether it is
  accessible, and the stops ahead with scheduled and predicted times. Its trip
  is outlined on the map — the road ahead in bold, the road behind faded — and
  a trail shows where it has actually been over the last twenty minutes.
- **Tap a stop** for its departure board (scheduled time struck through when
  the prediction differs, "not stopping" when the feed says so), step-free
  access, platform and station details, lifts and stairs from `pathways.txt`,
  its alerts, and every line that calls there — which light up on the map.
- **Search stops and routes** by what is on the sign: "16", "Route 21",
  "Blue", "Nicollet Mall", or the stop number off the pole.
- **Service alerts** everywhere they matter: on the stops and routes they
  actually affect (a single closed stop is not shown as a whole-route
  problem), marked in the route list, and all together in an Alerts tab that
  filters by kind and by route.
- **Satellite or street, flat or tilted, light or dark.** The aerial basemap is
  Esri's World Imagery, oversampled on high-density screens with crisp vector
  labels; 3D pitches the camera and extrudes buildings; dark mode swaps in a
  dark street map and follows the device by default. All keyless.

**Getting somewhere**

- **Door-to-door trip planning.** Ranked itineraries — walk, ride, transfer,
  walk — with live delays, cancellations and skipped stops folded in.
  Candidate trips are weighed with a quick walking estimate (a straight line
  corrected for street circuity), and the ones shown get their walking legs
  routed over real streets, so a path follows pavements and crossings rather
  than cutting through a building. Where an agency publishes `transfers.txt`
  it overrides geometry (Metro Transit currently does not publish one).
- **Time to leave.** "Leave in 6 min", worked back from the live prediction
  for that exact bus at the stop, less the walk. Ask for a reminder and it
  goes off two minutes before, as a notification and a banner, while the tab
  is open.
- **Saved trips, and how reliable they really are.** Save the trips you make
  often. While the app is open it notes how each of their buses and trains
  actually ran as they left, and shows "on time 8 in 10 · usually 2 min late"
  from what this device has seen.
- **Watch the trip.** Play any itinerary back: a traveller walks to the stop,
  waits on the platform, rides, changes and walks to the door, with the clock
  running, the camera following and the rest of the map dimmed. The waits are
  the point — they are most of what makes a trip feel long.
- **Share it.** Trips, stops and routes are links (`?from=…&to=…`, `?stop=`,
  `?route=`), and the address bar always describes what is on screen. "My
  location" is never put into a link.

**Around the edges**

- **Several operators in one feed** are grouped and named: routes by operator,
  "operated by" on every vehicle and route, and who runs what at a shared
  stop.
- **Offline.** A service worker keeps the app and the map you last looked at;
  the timetable is already cached, so stops, departures and planning keep
  working. The last vehicle positions seen are shown faded and dated, and old
  realtime predictions are dropped rather than presented as live.
- **Phones and desktops.** A side panel on a desktop, a bottom sheet on a
  phone; the camera always centres in the part of the map you can see.
- **A short first-run tour** that ends by playing a real trip across the
  cities, replayable from the legend.

No API key, no billing account, and no third-party signup: the transit feeds are
public and the basemap is open.

## Two ways to run it

The app has one codebase and two deployment shapes. The parser, the RAPTOR
planner and the realtime decoders are the same modules in both — there is no
second implementation to keep in step.

### Browser mode — no server at all

Metro Transit serves every feed with `Access-Control-Allow-Origin: *`, so a
browser can read them directly. In browser mode the whole engine runs in a Web
Worker in the visitor's own tab: it downloads the GTFS archive, parses it, polls
the realtime feeds and runs the trip planner locally.

That is what the hosted site is. It costs nothing to run, has no backend to
maintain, and keeps working as long as the agency publishes data.

The trade-off is a real first load: about 19 MB to download and several hundred
thousand stop times to parse, which takes a few seconds on a laptop and longer
on a phone. The archive is cached afterwards, so it happens roughly once a day.

```bash
npm install
npm run dev:browser     # browser mode against the real feed, no API server
```

### Server mode — a Node backend does the work

Better when many people share one deployment: the feed is parsed once in the
server rather than once per visitor, and clients get a small JSON API and an SSE
stream instead of a 19 MB download.

```bash
npm install
npm run dev             # API server + web client
```

Then open <http://localhost:5173>.

The first start downloads the agency's GTFS archive and caches it under
`data/gtfs/`. Subsequent starts reuse the cache and send a conditional request,
so they are fast.

### No network? Run the demo feed

```bash
LIVETRAINS_MOCK=1 npm run dev
```

This serves a synthetic Twin Cities-shaped feed — two light rail lines that
share a downtown transfer point, three bus routes crossing them, simulated
vehicles moving on the timetable, and invented delays. Nothing leaves the
process. It is also what the test suite runs against, so tests never depend on a
live feed or on service running at the moment you look.

To exercise **browser mode** offline, write the same synthetic feed out as real
GTFS and GTFS-Realtime files and point the client at them:

```bash
npm run fixtures        # writes fixtures/gtfs.zip and three .pb feeds
```

Serve `fixtures/` over HTTP with permissive CORS, then build with
`VITE_AGENCY_GTFS_URL` and friends pointing at it (see **Adding another city**,
which uses the same variables).

## How it fits together

The shared core is the same code in both modes:

```
  Metro Transit feeds              shared core                    UI
  ───────────────────              ───────────                    ──
  gtfs.zip ─────────► GtfsStore ──► PatternSet ──► Planner (RAPTOR)
   (schedule)          (typed        (RAPTOR           │
                       arrays)        routes)          │
                          │                            ├──► Trip planner
  vehiclepositions.pb ─┐  ├──► departuresForStops ─────┼──► Departure board
  tripupdates.pb ──────┼─►│                            │
  alerts.pb ───────────┘  RealtimeState ───────────────┴──► MapLibre map
                          (decode + hold)
```

Only the wiring around it differs:

```
  server mode    feeds ─► Node process ─► JSON API + SSE ─► browser
  browser mode   feeds ────────────────────────────────► Web Worker in the tab
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

`stop_times.txt` is the large one — 868,000 rows for Metro Transit, 43 MB of the
60 MB unpacked feed. Held as objects it would cost hundreds of megabytes and
stall the GC; held in parallel `Int32Array`s it costs roughly 10 MB. The loader
makes two passes over the text so the arrays are allocated once at exactly the
right size.

This matters twice over in browser mode, where the same parse happens in a
visitor's tab rather than once on a server — which is why it runs in a Web
Worker, off the thread that draws the map.

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

## Deploying

### GitHub Pages

`.github/workflows/pages.yml` builds the client in browser mode and publishes
it. It runs on pushes to `main`, and can be run by hand from the Actions tab.
No server, no secrets, no API keys.

**One-time setup:** Settings → Pages → Build and deployment → Source:
**GitHub Actions**. Creating the Pages site requires repository admin rights,
which the workflow token deliberately does not have, so this single step cannot
be automated. The workflow builds and uploads the site regardless and fails with
a link to the setting if it is still missing.

The build sets `VITE_BASE` so assets resolve under `/<repo>/` (or `/` behind a
custom domain), and `VITE_DATA_MODE=browser` so the engine runs client-side.

### Anywhere that runs Node

```bash
npm run build
SERVE_STATIC=1 npm start
```

One process then serves both the API and the built client on `PORT` (default
8080). Give it around 512 MB of memory: the parsed Metro Transit feed sits in
the tens of megabytes, and peak usage during parsing is higher.

### Pointing a static build at your own server

A page built in browser mode can be switched to a server at runtime, which is
useful for debugging a deployment without rebuilding. In the browser console:

```js
localStorage.setItem('livetrains.dataMode', 'server');
localStorage.setItem('livetrains.apiUrl', 'https://your-api.example.com');
location.reload();
```

Remove those keys to go back to browser mode.

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
| `PLANNER_MAX_WALK_METERS` | `1200` | Longest access/egress walk, measured as walking distance |
| `PLANNER_WALK_SPEED` | `1.33` | Walking speed, m/s (~3 mph) |
| `PLANNER_WALK_CIRCUITY` | `1.35` | Real walking distance ÷ straight-line distance, used to weigh candidate trips. `1` disables the correction |

### Walking directions

The legs of a shown itinerary are re-routed over the real street network, so
they follow pavements rather than cutting across blocks. This is a client-side
setting:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_WALK_ROUTER_URL` | FOSSGIS's public Valhalla | A Valhalla `/route` endpoint. Empty disables re-routing and keeps straight lines |

The default is [FOSSGIS's community Valhalla](https://valhalla1.openstreetmap.de/),
which is keyless and CORS-enabled — that is what makes real walking directions
possible from a static site with no server and no sign-up. **It is a demo
endpoint.** It is fine for one person's map and the wrong thing to point real
traffic at; if this gets an audience, run your own Valhalla and set the
variable. Results are cached for the life of the page, walks over 5km are not
routed, and anything that fails falls back to the straight line, so the app
works unchanged with no router at all.
| `PLANNER_MAX_TRANSFERS` | `3` | Transfer ceiling |
| `NOMINATIM_URL` | unset | Optional address search; local stop and landmark search always works |
| `LOG_LEVEL` | `warn` | Fastify log level |

### Web build (browser mode)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_DATA_MODE` | `server` | `browser` runs the engine client-side |
| `VITE_BASE` | `/` | Base path; Pages needs `/<repo>/` |
| `VITE_API_URL` | same origin | API server to use in server mode |
| `VITE_AGENCY_ID` | `metro-transit` | Which registered agency to load |
| `VITE_AGENCY_GTFS_URL` | unset | Serve any GTFS feed without a code change |

The `VITE_AGENCY_*` variables mirror the server's `AGENCY_*` set. A feed used in
browser mode must send permissive CORS headers; Metro Transit does, but not
every agency will.

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
| `GET /api/stops/:id` | Stop details, lines, station pathways, alerts and departures |
| `GET /api/vehicles?routeId&bbox` | Current vehicle positions |
| `GET /api/vehicles/stream` | Server-Sent Events stream of positions |
| `GET /api/vehicles/:id/trip` | The trip a vehicle is running: stops, times, shape |
| `GET /api/search?q` | Stops and routes by name, number or stop code |
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
npm run dev          # API server + web client, both watching
npm run dev:browser  # web client only, engine in the browser
npm test             # server and web test suites
npm run typecheck    # both packages
npm run build        # production build
npm run fixtures     # write the demo feed as real .zip / .pb files
npm run verify:feed  # load the real feed and plan a trip against it
```

Tests run entirely against the synthetic feed, so they need no network and do
not break overnight when the real feed stops running. `verify:feed` is the
complement — it exercises the real published data, and runs weekly in CI so an
upstream change surfaces as a failed job rather than a broken app.

## Attribution and terms

Schedule and realtime data © the operating agency — Metro Transit by default.
Check the agency's terms before deploying publicly; most, including Metro
Transit, publish these feeds openly for exactly this purpose.

Basemap tiles from [OpenFreeMap](https://openfreemap.org/), map data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. If the
basemap is unreachable the map falls back to a plain background and keeps
drawing vehicles, stops and routes — only the street imagery is lost.
