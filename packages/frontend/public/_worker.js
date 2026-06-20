/**
 * Cloudflare Pages — Advanced Mode Worker.
 *
 * The Mention frontend is a static Expo export deployed to Cloudflare Pages via
 * `wrangler pages deploy packages/frontend/dist`. With a direct upload, a
 * `functions/` directory inside the uploaded output is NOT compiled as Pages
 * Functions — the correct mechanism is a single `_worker.js` at the root of the
 * deployed dir (Advanced Mode). This file lives in `public/` so `expo export`
 * copies it to `dist/_worker.js`.
 *
 * Purpose: ActivityPub content negotiation for LOCAL profile URLs. The fediverse
 * discovers a Mention profile two ways:
 *  - by acct handle (`@user@mention.earth`) → webfinger → actor (already works).
 *  - by profile URL (`https://mention.earth/@user`) → the server must return the
 *    AP actor (or HTML linking to it). The Expo SPA only serves `index.html`, so
 *    URL-based discovery was failing for LOCAL profiles.
 *
 * When a fediverse server requests a LOCAL profile URL with an ActivityPub
 * `Accept` header, we 302-redirect to the canonical actor at
 * `api.mention.earth/ap/users/<username>`. Every other request (human browsers,
 * federated profiles, all other routes) is served from static assets via
 * `env.ASSETS.fetch`, which also honors the `_redirects` SPA fallback.
 */

/** Canonical ActivityPub actor base for local users. */
const ACTOR_BASE = 'https://api.mention.earth/ap/users/';

/** Local profile path: a single segment after `@`, with no second `@`. */
const LOCAL_PROFILE_PATH = /^\/@([^/@]+)$/;

/**
 * Whether the `Accept` header asks for ActivityPub JSON. Mastodon may send
 * `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`, so a
 * case-insensitive substring match on the JSON media subtypes is sufficient.
 */
function wantsActivityPub(accept) {
  if (!accept) return false;
  const value = accept.toLowerCase();
  return value.includes('activity+json') || value.includes('ld+json');
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    const match = pathname.match(LOCAL_PROFILE_PATH);
    if (match && wantsActivityPub(request.headers.get('Accept'))) {
      const username = match[1];
      return new Response(null, {
        status: 302,
        headers: {
          Location: ACTOR_BASE + encodeURIComponent(username),
          // The redirect depends on the Accept header, so caches must vary on it.
          Vary: 'Accept',
        },
      });
    }

    // Serve the static export (and the `_redirects` SPA fallback) for everything
    // else: human browsers, federated profiles, and all other routes.
    return env.ASSETS.fetch(request);
  },
};
