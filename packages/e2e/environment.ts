/**
 * Environment contract for the browser release gate.
 *
 * Every value is resolved once, here, so a misconfigured run fails loudly at
 * startup instead of quietly measuring the wrong thing. That matters more than
 * usual for this suite: its whole job is to answer "does THIS build work", and
 * the cheapest way to break it is to point it somewhere that always passes.
 */

/** Resolves an origin from the environment, normalising it to bare scheme+host. */
function readOrigin(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    throw new Error(
      `${name} is required. It has no default on purpose: without it the gate would ` +
        'test whatever is already live and pass regardless of the release under test.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL (received ${JSON.stringify(value)}).`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} must be http or https (received ${JSON.stringify(value)}).`);
  }
  return parsed.origin;
}

/**
 * The immutable Cloudflare Pages deployment holding the build being gated. Its
 * bytes are what the browser actually executes — see `fixtures.ts`.
 */
export const CANDIDATE_ORIGIN = readOrigin('MENTION_E2E_CANDIDATE_ORIGIN');

/**
 * The origin the browser runs at. This is NOT interchangeable with the candidate
 * origin, and the difference is the reason this suite is shaped the way it is:
 *
 *   * the production build hardcodes `https://api.mention.earth` as its API
 *     (`packages/frontend/config.ts` ignores `EXPO_PUBLIC_API_URL` when
 *     `NODE_ENV=production`), and
 *   * that API answers every request with a fixed
 *     `access-control-allow-origin: https://mention.earth`
 *     (`packages/backend/src/utils/allowedOrigins.ts` allowlists exactly the one
 *     production frontend origin).
 *
 * So a browser parked on a `*.pages.dev` preview origin has EVERY API response
 * blocked by CORS: the app boots into a permanently empty shell and no feed
 * assertion can mean anything. Widening the production allowlist to admit
 * preview origins would be a credentialed-CORS loosening of production, which is
 * exactly what `AGENTS.md` § CORS says not to do.
 */
export const APP_ORIGIN = readOrigin('MENTION_E2E_APP_ORIGIN', 'https://mention.earth');

/** Backend origin that serves the canonical ActivityPub actor documents. */
export const API_ORIGIN = readOrigin('MENTION_E2E_API_ORIGIN', 'https://api.mention.earth');

/** A local handle that exists in production, used by the profile flow. */
export const PROFILE_HANDLE = process.env.MENTION_E2E_PROFILE_HANDLE?.trim() || 'nate';

if (CANDIDATE_ORIGIN === APP_ORIGIN) {
  throw new Error(
    'MENTION_E2E_CANDIDATE_ORIGIN must differ from MENTION_E2E_APP_ORIGIN. Pointing both at ' +
      'the live site turns every assertion below into a test of the release that already shipped.',
  );
}
