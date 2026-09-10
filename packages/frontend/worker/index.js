/**
 * Mention web shell Worker — the origin the static Expo export is served from,
 * and the reason this is a Worker rather than a Pages project.
 *
 * `mention.earth` is a proxied record in front of the AWS ALB; the backend serves
 * the apex itself and reverse-proxies every web-plane request to this origin
 * (`packages/backend/src/middleware/apexFrontendProxy.ts`), while the OG deep-link
 * renderer fetches the bare shell from it
 * (`packages/backend/src/routes/webShell.routes.ts`). Those two are the ONLY
 * callers this origin has.
 *
 * That is what the gate below encodes. Under Pages the same bytes sat at
 * `mention-frontend.pages.dev`, reachable by anyone, in no CORS allowlist — so a
 * browser that found it booted the shell and had every API call blocked. Pages
 * could not fix that: it serves assets and runs no code of its own. A Worker
 * runs first, so this origin can require the shared key the backend sends and
 * answer everything else 403. `shell.mention.earth` is a door, not a copy.
 *
 * IT FAILS CLOSED, DELIBERATELY. A Worker deployed without `SHELL_ACCESS_KEY`
 * serves 503 rather than serving the app: an unset secret is the one condition
 * under which failing open would silently restore the exact defect this exists to
 * remove, and a gate that stops gating when misconfigured is not a gate.
 *
 * WHAT IT DOES NOT DO: `not_found_handling = "single-page-application"` answers
 * ANY miss with `index.html`, including a stale hashed bundle, and a browser
 * handed `text/html` for a `.js` URL rejects it. That is already converted to a
 * real 404 by `apexFrontendProxy.ts` (`isContentHashedAsset` + `isHtmlContentType`),
 * which is the only path a browser reaches these bytes through. Repeating the
 * rule here would put one fact in two places and let them drift.
 */

/**
 * Header the backend presents on every request to this origin. Its value is the
 * shared secret; the name is public and carries nothing on its own. Compared
 * lowercase because `Headers.get` is case-insensitive but the literal here is not.
 */
const SHELL_ACCESS_HEADER = "x-mention-shell-key";

const encoder = new TextEncoder();

/**
 * Constant-time string comparison, so a caller cannot recover the key one byte at
 * a time by measuring how long a wrong answer takes.
 *
 * `crypto.subtle.timingSafeEqual` THROWS on unequal byte lengths rather than
 * returning false, so the length is checked first. That leaks the key's length,
 * which is not a secret worth protecting — the value is.
 */
function keyMatches(presented, configured) {
  const left = encoder.encode(presented);
  const right = encoder.encode(configured);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

/** A denial must never be cached — not by the edge, not by a browser, not by the backend. */
function denial(status, body) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const configured = env.SHELL_ACCESS_KEY;
    if (!configured) {
      // Loud and distinct from 403: this is the deployment being wrong, not the
      // caller. `deploy-frontends.yml` asserts the secret before it promotes a
      // version, so reaching this in production means that assertion was removed.
      return denial(503, "Shell access key is not configured on this Worker.");
    }

    const presented = request.headers.get(SHELL_ACCESS_HEADER);
    if (!presented || !keyMatches(presented, configured)) {
      return denial(403, "Not accessible directly. Use https://mention.earth.");
    }

    return env.ASSETS.fetch(request);
  },
};
