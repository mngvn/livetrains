/**
 * livetrains aircraft relay, for Deno Deploy.
 *
 * The same relay as planes-worker.js, run on Deno Deploy instead of
 * Cloudflare. The aircraft feeds turn away requests from Cloudflare's shared
 * servers (adsb.lol rate-limits them, adsb.fi blocks them); Deno Deploy asks
 * from elsewhere.
 *
 * Paste this whole file into a Deno Deploy playground. It loads the relay
 * itself from this repository, as it stood on main when the deployment was
 * made. To accept requests only from your own site, set the environment
 * variable ALLOWED_ORIGINS (e.g. https://mngvn.github.io).
 *
 * Importing from a branch means trusting whoever can push to it. For a
 * deployment you want to stay exactly as reviewed, replace `main` in the URL
 * with a commit SHA: https://raw.githubusercontent.com/mngvn/livetrains/<sha>/relay/planes-worker.js
 */
import relay from 'https://raw.githubusercontent.com/mngvn/livetrains/main/relay/planes-worker.js';

Deno.serve((request) => relay.fetch(request, { ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS') ?? '' }, {}));
