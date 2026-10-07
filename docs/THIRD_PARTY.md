# Third-party services, data and software

Everything livetrains depends on that it did not write: the services it talks
to at runtime, the data it shows, the hosting and CI it runs on, and every
library it ships or builds with — with what each is used for, what is sent to
it, its terms or licence, and what happens when it is unavailable.

See [HOW_IT_WORKS.md](HOW_IT_WORKS.md) for how the pieces fit together and
[SECURITY.md](SECURITY.md) for the security model.

> Licences and terms below are summarised from the projects' own pages and
> package metadata at the time of writing. They change; check the source
> before relying on any of them for a commercial or high-traffic deployment.

---

## 1. At a glance

| Service | Used for | Called from | When | Key? |
| --- | --- | --- | --- | --- |
| **Metro Transit** (`svc.metrotransit.org`) | Timetable (GTFS) and live vehicles, predictions, alerts (GTFS-Realtime) | Browser worker (static site) or server | Timetable ~daily; realtime every 15 s | No |
| **OpenFreeMap** (`tiles.openfreemap.org`) | Vector tiles and fonts for the street basemap, labels and 3D buildings | Browser | As the map is viewed | No |
| **Esri World Imagery** (`server.arcgisonline.com`) | Aerial imagery | Browser | Only with the Satellite basemap | No |
| **FOSSGIS Valhalla** (`valhalla1.openstreetmap.de`) | Real walking paths for planned trips | Browser | Once per walking leg of a shown plan | No |
| **adsb.lol** (`api.adsb.lol`), fallback **adsb.fi** (`opendata.adsb.fi`) | Aircraft positions | Server, or the relay (never the browser directly) | Every 10 s per visible tab, cached 4–5 s upstream | No |
| **adsbdb** (`api.adsbdb.com`) | Aircraft type/registration/photo and scheduled route | Browser | Only for a plane someone taps | No |
| Aircraft photo hosts (linked by adsbdb) | Thumbnail in the plane panel | Browser | Only for a tapped plane with a photo | No |
| **Nominatim** (any instance, `NOMINATIM_URL`) | Optional street-address search | Server only | Off unless configured; ≤ 1 request/s | No |
| **Cloudflare Workers** or **Deno Deploy** | Hosting the aircraft relay for the static site | Browser → relay | Every 10 s per visible tab | Free account |
| **GitHub** (Pages, Actions, raw.githubusercontent.com) | Hosting the site, CI, and the Deno relay's source import | — | — | — |

The app has **no analytics, no tracking, no cookies, no accounts and no ads.**
Fonts are self-hosted; no font or script is loaded from a CDN.

---

## 2. Runtime services in detail

### 2.1 Metro Transit — GTFS and GTFS-Realtime

- **Endpoints**: `https://svc.metrotransit.org/mtgtfs/gtfs.zip`,
  `…/vehiclepositions.pb`, `…/tripupdates.pb`, `…/alerts.pb`
  (`server/src/agencies/index.ts`).
- **What it provides**: the full timetable (stops, routes, trips, stop times,
  calendars, shapes, station pathways, operators) and the live feeds.
- **What is sent**: plain GET requests — the visitor's IP address and browser
  headers in browser mode, the server's in server mode. Nothing about the user.
- **Terms**: Metro Transit publishes these feeds openly, with no key or
  registration, for developers to build on. Displaying "Schedule and realtime
  data © Metro Transit" is part of the agency definition and shown in the map
  attribution. Review Metro Transit's current developer terms before a public
  or commercial deployment.
- **CORS**: every feed sends `Access-Control-Allow-Origin: *`; this is what
  lets the static site work with no server. Checked weekly by CI.
- **If unavailable**: the timetable falls back to the cached copy (server disk
  or browser Cache Storage); realtime shows the timetable, says the feed is
  down, counts down to the next retry, and drops predictions older than five
  minutes rather than presenting them as live.
- **Other agencies**: any GTFS publisher can be configured (`AGENCY_*` /
  `VITE_AGENCY_*`). Duluth Transit Authority is defined as a second example.
  Feeds for most agencies are listed in the
  [Mobility Database](https://mobilitydatabase.org/). A feed used in browser
  mode must send permissive CORS headers.

### 2.2 OpenFreeMap — the street basemap

- **Endpoints**: `https://tiles.openfreemap.org/planet` (TileJSON + vector
  tiles in the OpenMapTiles schema) and
  `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf` (Noto Sans
  glyphs for map labels).
- **Used for**: the app's own basemap style (`web/src/components/mapStyle.ts`),
  labels on the satellite view, and building footprints for 3D mode.
- **What is sent**: tile requests, which reveal roughly which area of the map
  is being looked at, plus IP and browser headers.
- **Data and licence**: map data © OpenStreetMap contributors, under the Open
  Database License (ODbL); OpenFreeMap is a free, keyless public tile host.
  Attribution is supplied by the tile source and shown in the map corner:
  open on arrival, then folded into an (i) that one tap reopens, as the
  OpenStreetMap Foundation's attribution guidelines allow.
- **If unavailable**: the map falls back to a plain background and keeps
  drawing every vehicle, stop and route; only the street imagery is lost.
  Previously viewed tiles are served from the service worker's cache.

### 2.3 Esri World Imagery — the satellite basemap

- **Endpoint**:
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
  (`web/src/components/basemaps.ts`). Only requested when the user picks
  Satellite.
- **Attribution shown**: "Imagery © Esri, Maxar, Earthstar Geographics, and the
  GIS User Community".
- **Terms**: Esri publishes this service for use with attribution; its terms of
  use govern usage volume, commercial use and offline caching. The service
  worker caches tiles the user has viewed (capped at 3,000 entries across all
  map hosts). Check Esri's current terms before a high-traffic or commercial
  deployment.

### 2.4 FOSSGIS Valhalla — walking directions

- **Endpoint**: `https://valhalla1.openstreetmap.de/route` (configurable with
  `VITE_WALK_ROUTER_URL`; empty turns it off) — `web/src/lib/walkRouter.ts`.
- **What is sent**: for each walking leg of a shown itinerary, the start and end
  coordinates (to six decimal places) and "pedestrian". **If the trip starts at
  "My location", the first leg's start is the user's current position**, so
  this is the one place a precise location leaves the device. Results are
  cached in memory for the session.
- **Terms**: a public demo server run by FOSSGIS e.V. for the OpenStreetMap
  community, keyless and CORS-enabled, with a fair-use policy; routes are
  derived from OpenStreetMap data (ODbL). It is fine for one person's map and
  the wrong thing to point real traffic at — for an audience, run your own
  Valhalla and set the variable.
- **If unavailable**: walking legs stay as the planner's straight-line estimate.

### 2.5 adsb.lol and adsb.fi — aircraft positions

- **Endpoints**: `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}` and
  `https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{radius}`, tried in
  that order (`server/src/planes.ts`, `relay/planes-worker.js`; override with
  `PLANES_FEEDS`).
- **What is sent**: the centre and radius of the agency's area (fixed, not the
  user's position) and an identifying User-Agent. The browser never contacts
  these directly; the server or the relay does.
- **Data and licence**: both are networks of volunteers' ADS-B receivers, so
  coverage is what they hear. adsb.lol's data is published under the ODbL;
  adsb.fi publishes an open-data API under its own terms. The map credits
  whichever answered.
- **Why a relay**: neither sends CORS headers, so a page cannot read them.
  Server mode relays at `/api/planes`; the static site needs the included
  relay (below). Without one, the static site simply has no planes.

### 2.6 adsbdb — aircraft and route details

- **Endpoints**: `https://api.adsbdb.com/v0/aircraft/{icao-hex}` and
  `https://api.adsbdb.com/v0/callsign/{callsign}` (`web/src/lib/planeLookup.ts`).
- **What is sent**: the transponder address and callsign of a plane the user
  tapped. Nothing is looked up unless a plane is tapped.
- **What comes back**: manufacturer, type, registration, registered owner, a
  photo thumbnail URL, and the route the flight number is scheduled to fly.
  Routes are what a flight number *usually* flies, so the app only shows one if
  the plane is actually near it.
- **Photos** are loaded from whatever host adsbdb links to, over https, with
  `referrerPolicy="no-referrer"`.
- **If unavailable**: the panel shows what the position feed itself says.

### 2.7 Nominatim — optional address search

- Off by default. With `NOMINATIM_URL` set, the **server** (never the browser)
  sends search text that the local stop/landmark index could not satisfy.
- The app follows the public server's usage policy: at most one request a
  second for the whole application, an identifying User-Agent, and answers
  cached for an hour. Results are OpenStreetMap data (ODbL, attribution
  required). Heavy use should go to your own Nominatim instance.

### 2.8 The aircraft relay hosts

- `relay/planes-worker.js` runs as a **Cloudflare Worker** (free tier: 100,000
  requests/day ≈ 280 hours of someone watching the map) or, because
  Cloudflare's shared egress is rate-limited by adsb.lol and blocked by
  adsb.fi, on **Deno Deploy** via `relay/deno.js`, which imports the relay from
  `raw.githubusercontent.com` (see SECURITY.md on pinning that import).
- The relay answers one path only, caches five seconds, caps the radius, and
  can be restricted to the site's origin with `ALLOWED_ORIGINS`.

### 2.9 Links the user may follow

Opened only on a click, in a new tab: the agency's alert pages and operator
websites (from the feeds; only http/https addresses are linked), the aircraft's
full track on `globe.adsb.lol`, and the credits for adsb.lol, adsb.fi,
OpenStreetMap and OpenFreeMap.

---

## 3. Data and attribution summary

| Data | Owner / licence | Attribution shown |
| --- | --- | --- |
| Schedule and realtime | Metro Transit (or the configured agency) | "Schedule and realtime data © Metro Transit" |
| Basemap, labels, buildings | © OpenStreetMap contributors, ODbL, via OpenFreeMap | From the tile source |
| Aerial imagery | Esri, Maxar, Earthstar Geographics, GIS User Community | Yes, on the satellite view |
| Walking paths | OpenStreetMap (ODbL) via FOSSGIS Valhalla | Covered by the OSM credit |
| Aircraft positions | adsb.lol (ODbL) / adsb.fi | "Aircraft adsb.lol (ODbL)" or "Aircraft adsb.fi" |
| Aircraft and routes | adsbdb.com | In the plane panel |
| Landmarks | Hand-written list in `server/src/geocode.ts` | — |

---

## 4. Hosting, build and CI

| Service | Role |
| --- | --- |
| GitHub repository | Source, issues, Dependabot updates |
| GitHub Actions | `pages.yml` (typecheck, test, build, deploy), `verify-feed.yml` (weekly real-feed check) |
| GitHub Pages | Hosts the static, browser-mode site |
| npm registry | Dependencies, locked by `package-lock.json` |

GitHub Actions used: `actions/checkout@v7`, `actions/setup-node@v7`,
`actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`,
`actions/deploy-pages@v5` — all first-party GitHub actions, running on the
Node 24 actions runtime. The project itself builds and tests on Node 22.

---

## 5. Software dependencies

### 5.1 Shipped to users or run in production

| Package | Version | Licence | Where | Used for |
| --- | --- | --- | --- | --- |
| `react`, `react-dom` | 19.3 | MIT | web | UI |
| `maplibre-gl` | 6.12 | BSD-3-Clause | web | WebGL map rendering |
| `fflate` | 0.8 | MIT | web (and server tests) | Unzipping the timetable in the browser; writing fixtures |
| `@fontsource/inter`, `@fontsource/inter-tight` | 5.3 | OFL-1.1 (fonts by Rasmus Andersson) | web | Self-hosted typefaces (Latin subsets, bundled into the build) |
| `fastify` | 5.12 | MIT | server | HTTP server |
| `@fastify/cors` | 11.3 | MIT | server | CORS headers |
| `@fastify/static` | 10.1 | MIT | server | Serving the built client with `SERVE_STATIC` |
| `gtfs-realtime-bindings` | 1.1 | Apache-2.0 | server + web | Official GTFS-Realtime protobuf definitions (MobilityData) |
| `protobufjs` | 7.6 | BSD-3-Clause | server + web (via the above) | Protobuf decoding |
| `yauzl` | 3.4 | MIT | server | Streaming zip reader |

`gtfs-realtime-bindings` also declares `protobufjs-cli` (a code generator)
as a runtime dependency, which pulls documentation tooling into a server
install; none of it is used at runtime or shipped to browsers.

### 5.2 Build, test and development only

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| `typescript` | 5.9 | Apache-2.0 | Type checking and server build |
| `vite`, `@vitejs/plugin-react` | 8.3 / 6.1 | MIT | Client dev server and bundler |
| `vitest` | 5.0 | MIT | Unit tests (both packages) |
| `tsx` | 4.x | MIT | Running TypeScript directly in development and scripts |
| `concurrently` | 9.x | MIT | Running server and client together in development |
| `playwright` | 1.63 | Apache-2.0 | Browser checks during development |
| `@types/*` | — | MIT | Type definitions |

### 5.3 The whole production tree

181 third-party packages are installed for production (`npm ls --omit=dev`,
excluding the two workspace packages). Their licences: MIT 115, ISC 20, BSD-3-Clause 19, BSD-2-Clause 10, Apache-2.0 7,
BlueOak-1.0.0 5 (glob, minimatch and friends), OFL-1.1 2 (fonts),
Unlicense 1, Python-2.0 1 (`argparse`), MIT-or-Apache-2.0 1 — all permissive.
`npm audit` reports no known vulnerabilities as of this pass.

The project's own code currently has **no licence file**, which by default
means all rights reserved; add one if others are meant to reuse it.

---

## 6. Browser features used

| Feature | Used for | Permission prompt? |
| --- | --- | --- |
| Web Workers (module) | The transit engine; MapLibre's tile worker | No |
| WebGL | Map rendering | No |
| Fetch, Streams | Feeds and timetable download with progress | No |
| Cache Storage | Timetable archive; service worker caches | No |
| Service Worker | Offline shell and tiles | No |
| IndexedDB | Reliability history, last-known vehicles | No |
| localStorage | Preferences, saved trips, per-stop filters, developer overrides | No |
| EventSource | Live vehicle stream in server mode | No |
| Geolocation | "My location" and the map's locate button | **Yes**, only when used |
| Notifications | Leave reminders and ride-along alerts | **Yes**, only when the user arms one |
| Vibration | Ride-along "get off" taps | No |
| Web Share / Clipboard | Sharing links | No (user gesture) |
| ResizeObserver, matchMedia | Panel-aware camera padding, phone layout, reduced motion | No |

---

## 7. Privacy: what leaves the device

| Recipient | What it receives | When |
| --- | --- | --- |
| The site host (GitHub Pages or your server) | Page and asset requests; in server mode, every API query, including plan coordinates | Always |
| Metro Transit | Feed requests (IP, browser headers) | Browser mode, continuously while open |
| OpenFreeMap / Esri | Tile requests revealing the area being viewed | While the map is viewed |
| FOSSGIS Valhalla | Start/end coordinates of walking legs — **including the current position when planning from "My location"** | When a plan is shown |
| Aircraft relay (Cloudflare/Deno) | The agency area (fixed) | Every 10 s while visible and planes are on |
| adsbdb, photo host | A tapped aircraft's address and callsign | When a plane is tapped |
| Nominatim (server mode, if enabled) | Search text, from the server | When local search finds too little |

Location is never put into share links, never stored, and never sent to the
app's own server in browser mode (planning happens in the tab). Saved trips
and reliability history stay on the device.
