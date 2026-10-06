# Security

How livetrains is protected, what a full review of it found and fixed, and
what is left to the person deploying it.

## Reporting a vulnerability

Please report security problems privately rather than in a public issue: use
GitHub's private vulnerability reporting on this repository (Security →
Report a vulnerability), once it is enabled in the repository settings.

---

## 1. What there is to protect

livetrains has no accounts, no cookies, no payments and no personal data on
any server. Its API is read-only and serves public transit data. That leaves
four real concerns:

1. **Availability.** The server is one Node.js process whose trip planner is
   CPU-bound and runs on the same thread that answers everyone. Anything that
   lets one client monopolise that thread takes the app down for everyone.
2. **Untrusted data reaching the page.** Text and links come from other
   people's systems: the agency's feeds (alert text and links, stop and route
   names, operator websites), aircraft databases, map tile servers. None of it
   may become code running in the page.
3. **The supply chain.** npm dependencies, GitHub Actions, and the relay's
   remote import.
4. **The user's privacy.** Location is used, and must not leak further than
   it needs to.

## 2. Controls in place

### Server (`server/src`)

| Control | Where | Detail |
| --- | --- | --- |
| Per-client request budgets | `rateLimit.ts`, `routes/api.ts` | 600 API requests/min per client; trip plans and reachability maps also 60/min. 429 with `Retry-After`. Memory bounded to clients seen in the current window, swept every minute, hard-capped at 50,000 |
| Live stream limits | `routes/api.ts` | 8 open vehicle streams per client, 5,000 overall; slots released on disconnect |
| Input bounds | `routes/api.ts`, `planner/index.ts`, `gtfs/store.ts` | Coordinates must be on the Earth; radii, limits and search text are clamped; departure time within a year; walking pace 0.3–3 m/s; spatial scans clipped to where stops exist |
| Trusted proxy addresses only | `config.ts`, `index.ts` | `X-Forwarded-For` is ignored unless `TRUST_PROXY` says which proxies to believe, so a client cannot choose its own rate-limit bucket |
| Error hygiene | `routes/api.ts` | Unexpected failures answer "Internal server error"; detail goes to the log only |
| Security headers | `index.ts` | `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `frame-ancestors 'self'` / `X-Frame-Options`, `Permissions-Policy` (geolocation for itself only) |
| CORS | `index.ts` | GET/HEAD/OPTIONS only, no credentials; any origin by default (public data), narrowed with `CORS_ORIGINS` |
| Body limit | `index.ts` | 16 KB (the API takes no bodies) |
| Static files | `@fastify/static` 10 | Path traversal and encoded-separator tricks return 403 |
| Feed ingestion limits | `gtfs/archive.ts` | Download timeout (10 min) and size cap (1 GB); each zip entry's declared size checked before inflating (512 MB per file, 1 GB total); falls back to the cached archive on network failure |
| Upstream etiquette | `geocode.ts`, `planes.ts`, `config.ts` | Nominatim ≤ 1 request/s with caching; aircraft fetched once per 4 s for all clients; realtime polling never faster than 5 s; identifying User-Agents |

### Web client (`web/`)

| Control | Where | Detail |
| --- | --- | --- |
| Content-Security-Policy | `vite.config.ts` (written into `index.html` at build) | `script-src 'self'` plus the hash of the one inline theme script; `style-src 'self'`; `object-src 'none'`; `base-uri`/`form-action 'self'`. Applies on GitHub Pages too, which cannot send headers |
| No HTML from data | React, `safeUrl.ts` | All feed text is rendered as text. The only HTML sinks are static SVG strings and MapLibre's attribution, where the agency name is escaped and the aircraft credit stripped of markup |
| Safe links and images | `lib/safeUrl.ts` | Alert links, operator websites and aircraft photos are used only if they are http(s) (photos upgraded to https); `rel="noopener noreferrer"` on new-tab links; photos sent with no referrer |
| No URL-driven backend switching | `lib/api.ts`, `planeFeed.ts`, `dataSource.ts` | The API server, aircraft relay and data mode can be overridden only from `localStorage` (the console), never from a query parameter a link could carry |
| Location stays private | `lib/shareLink.ts` | "My location" is never written into a share link |
| Error boundary | `components/ErrorBoundary.tsx` | A rendering failure shows a reload button rather than a blank page |
| Service worker scope | `public/sw.js` | Caches only same-origin build assets and known map hosts; never realtime data or the API |

### Relay and CI

| Control | Detail |
| --- | --- |
| Relay is not an open proxy | Answers one path, asks only the two aircraft feeds, caps the radius, rounds the centre, caches 5 s; `ALLOWED_ORIGINS` limits which sites' pages may use it |
| Least-privilege CI tokens | `pages.yml` and `verify-feed.yml` both declare their permissions (`contents: read`, plus Pages deployment for the former) |
| Dependency updates | Dependabot groups npm updates weekly and Actions monthly |

---

## 3. Review findings (this pass)

Every finding below was reproduced or verified, fixed, and covered by a test
or a browser check where practical.

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | **High** | **One request froze the server.** A nearby-stop search sized its grid scan by the query alone; a degree of longitude shrinks to nothing at the poles, so `GET /api/stops/nearby?lat=90&lon=0` scanned ~10¹⁶ cells and every later request hung (confirmed). `/api/plan` and `/api/reverse-geocode` reached the same loop, and in the static site a share link like `?from=90,0&to=…` froze the visitor's trip planner | Scans clipped to the populated grid extent; coordinates validated (400); planner refuses impossible points. Regression tests added; the polar link now answers in about two seconds |
| 2 | **High** | **Known-vulnerable dependencies** (npm audit: 9 advisories, 3 critical): `@fastify/static` path traversal and route-guard bypass; `maplibre-gl` sanitiser bypass in the attribution control (which renders the tile server's credit as HTML); `fastify` DoS; `tinypool`/`vitest` (dev only); `brace-expansion`, `fast-uri`, `source-map-js`; and, published mid-review, `shell-quote` under `concurrently` (dev only) | Upgraded (`@fastify/static` 10, `maplibre-gl` 6 with its worker wired for Vite, `fastify` 5.12.5, `vitest` 5, audit fix, an npm override for `shell-quote`, which `concurrently` pins). `npm audit`: 0 vulnerabilities |
| 3 | Medium | **No limit on expensive requests.** Each trip plan is up to seven full RAPTOR searches on the request thread; a single looping client could deny service to everyone | Per-client budgets, with a tighter one for plans and reachability |
| 4 | Medium | **Unbounded live streams.** Any client could open unlimited SSE connections, each holding a socket, a listener and a per-update JSON serialisation | Per-client and global stream caps; one shared serialisation per update |
| 5 | Medium | **Spoofable client address.** `trustProxy: true` believed any `X-Forwarded-For`, which would have let a client pick its own rate-limit identity | Opt-in `TRUST_PROXY` |
| 6 | Medium | **Feed ingestion unbounded.** No download timeout (a stalled transfer hung startup forever), no size limits (a malicious or compromised feed could zip-bomb the server or the browser tab), and a network error at boot failed even with a cached archive | Timeout, declared-size checks before inflating, cached fallback; tests added |
| 7 | Low | **Unchecked planner inputs.** Walking pace, departure time and transfer counts were partly unbounded; an extreme `departAt` surfaced as an internal exception | Clamped or refused with a message |
| 8 | Low | **Internal error messages returned to clients** on unexpected 500s | Generic message; detail logged |
| 9 | Low | **No CSP or security headers** | CSP in the built page; headers from the server |
| 10 | Low | **Feed-supplied links used as given.** Alert and operator URLs went straight into `href`. React 19 already blocks `javascript:` links, but other schemes passed, and an operator URL that was not a valid URL threw during render and blanked the whole app | http(s)-only links via `safeWebUrl`; phone numbers reduced to dialable characters; error boundary added |
| 11 | Low | **Agency name rendered as HTML** in the map attribution | Escaped |
| 12 | Low | **Nominatim usage policy not respected** (every keystroke forwarded, no caching) — a terms-of-service problem that gets a server's address blocked | ≤ 1 request/s, 1 h cache, identifying User-Agent, defensive parsing |
| 13 | Low | `verify-feed.yml` inherited the repository's default token permissions | `contents: read` |
| 14 | Info | The live vehicle stream silently dropped Fastify's CORS headers, and the client opened it on the page's own origin rather than the configured API server | Stream hijacked properly with headers carried over; client uses the configured server |
| 15 | Info | The Deno relay imports its code from the `main` branch, so whoever can push to `main` controls what a redeployed relay runs | Documented, with how to pin it to a commit |

### Memory and robustness findings

| Finding | Fix |
| --- | --- |
| Walking-direction cache grew for the life of the page, and a failure was cached forever | LRU cap (300); failures retried after 5 minutes |
| Aircraft lookup cache unbounded; lookups had no timeout | LRU cap (200); 10 s timeout |
| The browser engine held up to four copies of the 19 MB timetable archive while downloading and caching it | Streams into one pre-sized buffer; the cache takes its copy directly |
| The console handle to the map kept a removed map (and its GPU buffers) reachable after a remount | Released on unmount |
| A zip entry stream error left the archive file open | Closed on every failure path |
| `undici` was a declared but unused server dependency | Removed |

---

## 4. Left to the operator, and recommendations

- **Behind a reverse proxy, set `TRUST_PROXY`** (e.g. `1`), or every client
  shares the proxy's rate-limit bucket. Terminate TLS at the proxy.
- **Set `CORS_ORIGINS`** if the API should only serve your own front end.
- **Restrict the relay** with `ALLOWED_ORIGINS`, and **pin `relay/deno.js`'s
  import to a commit SHA** so a redeploy runs exactly what was reviewed.
- **Pin GitHub Actions to commit SHAs** rather than version tags for
  stronger supply-chain guarantees; Dependabot will keep them current.
- **Run your own Valhalla** for real traffic. The public FOSSGIS server is a
  demo, and planning from "My location" sends the user's precise position to
  it (see [THIRD_PARTY.md](THIRD_PARTY.md#7-privacy-what-leaves-the-device)).
- **Tighten `connect-src`** in the CSP for a fixed deployment. It allows any
  https origin by design, so the configurable feeds and console overrides keep
  working.
- **Review third-party terms** (Metro Transit, Esri, adsb.lol/adsb.fi, adsbdb,
  OpenFreeMap) before a commercial or high-traffic deployment.
- **Add a LICENSE file** if the code is meant to be reused; without one it is
  all rights reserved by default.
- **Enable GitHub's Dependabot alerts and private vulnerability reporting** in
  the repository settings.
