/**
 * livetrains aircraft relay, for Deno Deploy.
 *
 * The same relay as planes-worker.js, run on Deno Deploy instead of
 * Cloudflare. The aircraft feeds turn away requests from Cloudflare's shared
 * servers (adsb.lol rate-limits them, adsb.fi blocks them); Deno Deploy asks
 * from elsewhere.
 *
 * Paste this whole file into a Deno Deploy playground. It loads the relay
 * itself from this repository, so it always runs the version on main. To
 * accept requests only from your own site, set the environment variable
 * ALLOWED_ORIGINS (e.g. https://mngvn.github.io).
 */
import relay from 'https://raw.githubusercontent.com/mngvn/livetrains/main/relay/planes-worker.js';

Deno.serve((request) => relay.fetch(request, { ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS') ?? '' }, {}));
