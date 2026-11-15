# Getting planes back on the live site

The planes on <https://mngvn.github.io/livetrains/> need a **relay**: a tiny
server that fetches aircraft positions from adsb.lol / adsb.fi and passes them
to the browser (those services don't let web pages read them directly). The
site finds its relays in the GitHub variable `PLANES_URL`.

**Where things stand:** the relays kept running out of their free monthly
allowance, which hosts count in requests. Every open map used to ask its
relay again every 15 seconds — 240 requests an hour, each. Now the map opens
one connection and the relay pushes the planes down it every 15 seconds, so a
visit costs about 2 requests an hour however long it lasts. The app can also
use several relays, moving on when one fails.

**For that to take effect, each relay has to be redeployed once** with the
new code, after this change is merged to `main` (see "Update a relay" just
below). Until then nothing breaks: the site notices an older relay and polls
it as before.

The rest of this page sets up a second free relay on Render, with Deno as the
fallback. If you already have both, "Update a relay" is all you need.

## Update a relay to the streaming version

- **Render:** it redeploys by itself when `main` changes. If Auto-Deploy is
  off, open the service and choose **Manual Deploy → Deploy latest commit**.
- **Deno Deploy:** open the playground and click **Deploy** again. (It loads
  `planes-worker.js` from `main` at the moment it is deployed, so an existing
  deployment keeps the old code until you do.)
- **A computer at home:** `git pull`, then restart `node relay/node-server.js`.

To check, open the relay's address with `?stream=1` on the end, e.g.
`https://livetrains-planes.onrender.com/planes/44.95/-93.23/37?stream=1`.

- **The page keeps loading and a new `data: {…}` block appears every 15
  seconds:** it is streaming. Done. (Firefox may offer to save a file
  instead of showing it; that is a stream too.)
- **One block of data and the page finishes loading:** that relay is still
  running the old code. Redeploy it.

## 1. Create a free relay on Render

1. Sign up at <https://render.com> with GitHub.
2. **New → Web Service**, and connect the `mngvn/livetrains` repository.
3. Fill in:
   - **Root Directory:** `relay`
   - **Start Command:** `node node-server.js`
   - **Instance Type:** Free
   - Leave everything else as it is.
4. Create it and wait until it shows **Live**. Its address looks like
   `https://livetrains-planes.onrender.com`.

## 2. Check it works

Open your Render address with `/planes/44.95/-93.23/37` on the end, e.g.
`https://livetrains-planes.onrender.com/planes/44.95/-93.23/37`.

- **Data containing `"ac":[`**: it works. Carry on.
- **`{"error": ...}`**: the error names each plane service and why it
  refused. `429` means rate-limited, `403` means blocked.
- **Slow first time:** free Render services sleep after 15 quiet minutes and
  take about a minute to wake. Reload after a minute.

## 3. Point the site at both relays

1. Go to <https://github.com/mngvn/livetrains/settings/variables/actions>.
2. Edit `PLANES_URL` and set it to the Render address, a **space**, then the
   Deno address that is already there, each with
   `/planes/{lat}/{lon}/{radius}` on the end (typed with the braces):

   ```
   https://livetrains-planes.onrender.com/planes/{lat}/{lon}/{radius} https://<your-deno-address>/planes/{lat}/{lon}/{radius}
   ```

   The first one listed is preferred. The app falls back to the next if it
   fails, and tries the first again every five minutes.

## 4. Rebuild the site

Go to <https://github.com/mngvn/livetrains/actions/workflows/pages.yml>, click
**Run workflow**, wait about 2 minutes, then reload the site. The legend
should show an **Aircraft** row and planes should be on the map.

## 5. When Deno's allowance resets

Open the Deno Deploy playground and click **Deploy** again, so it picks up the
newer, lighter relay code. (It loads `planes-worker.js` from `main` at the
moment it is deployed.)

## Optional

- **Keep other sites off your relays:** set the environment variable
  `ALLOWED_ORIGINS` to `https://mngvn.github.io` on Render (Environment tab)
  and on Deno.
- **No limits at all:** run the relay on a computer at home that stays on.
  With Node 20+ installed, run `node relay/node-server.js` from the
  repository. Then give it a public address for free with
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel): install
  Tailscale, sign in, and run `tailscale funnel --bg 8787`. Use the
  `https://<machine>.<tailnet>.ts.net` address it prints as another relay in
  `PLANES_URL`.

## The files here

| File | What it is |
| --- | --- |
| `planes-worker.js` | The relay itself. One file, no dependencies. Answers a poll, or streams with `?stream=1`. |
| `node-server.js` | Runs it on any Node host (Render, a home computer). |
| `deno.js` | Runs it on Deno Deploy: paste into a playground. |

Cloudflare Workers can run `planes-worker.js` too, but adsb.lol rate-limits
Cloudflare's shared servers (429) and adsb.fi blocks them (403), so it
doesn't work there for now.
