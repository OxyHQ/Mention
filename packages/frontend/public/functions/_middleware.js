/**
 * Cloudflare Pages Function — ActivityPub content negotiation for profile URLs.
 *
 * The fediverse discovers a Mention profile two ways:
 *  - by acct handle (`@user@mention.earth`) → webfinger → actor (already works).
 *  - by profile URL (`https://mention.earth/@user`) → the server must return the
 *    AP actor (or HTML linking to it). The Expo SPA only serves `index.html`, so
 *    URL-based discovery was failing for LOCAL profiles.
 *
 * This middleware performs server-side content negotiation: when a fediverse
 * server requests a LOCAL profile URL with an ActivityPub `Accept` header, it
 * 302-redirects to the canonical actor at `api.mention.earth/ap/users/<username>`.
 * Every other request (human browsers, federated profiles, all other routes) is
 * passed through to the SPA untouched.
 *
 * Lives in `public/functions/` so `expo export` copies it to `dist/functions/`,
 * which is the directory Cloudflare Pages executes when `dist/` is deployed.
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

export async function onRequest(context) {
  const { request, next } = context;
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

  return next();
}
