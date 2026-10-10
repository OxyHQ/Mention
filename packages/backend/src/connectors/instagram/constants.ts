import type { NetworkId } from '@oxy.so/federation';
import { config } from '../../config';

/** The network id of the Instagram connector and of the actors it owns. */
export const INSTAGRAM_GRAPH_NETWORK_ID = 'instagram-graph' as const satisfies NetworkId;

/**
 * Instagram connector constants.
 *
 * Read-only and pull-only: Instagram has no API that accepts a post, a follow or
 * a reply from a third party, so everything here READS through Meta's Graph API
 * (Business Discovery) and imports into native posts. See the module docblock of
 * `InstagramGraphConnector.ts` for how it coexists with the kilogram.makeup
 * ActivityPub bridge.
 */

/**
 * The EFFECTIVE gate — `INSTAGRAM_GRAPH_ENABLED` AND both credentials — read at
 * call time rather than frozen at import, so a test (or a config reload) can flip
 * it without re-importing every module that asks.
 */
export function isInstagramGraphEnabled(): boolean {
  return config.instagramGraph.enabled;
}

/** The Graph API host. Fixed and public; every request is still SSRF-guarded. */
export const GRAPH_API_HOST = 'graph.facebook.com';

/** The network domain an Instagram identity lives on (`<u>@instagram.com`). */
export const INSTAGRAM_IDENTITY_DOMAIN = 'instagram.com';

/** Scheme of an `instagram-graph` actor URI: `instagram-graph:<ig-user-id>`. */
export const INSTAGRAM_GRAPH_ACTOR_URI_PREFIX = `${INSTAGRAM_GRAPH_NETWORK_ID}:`;

/** An Instagram user id (the Graph API `id` of an IG professional account). */
const IG_USER_ID_RE = /^\d{1,32}$/;

/**
 * An Instagram username: letters, digits, `.` and `_`, at most 30. Validated
 * strictly because it is interpolated into the Graph `fields` expression
 * (`business_discovery.username(<u>)`) — anything else could rewrite the query.
 */
const INSTAGRAM_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

export function isValidInstagramUsername(value: string | undefined | null): value is string {
  return typeof value === 'string' && INSTAGRAM_USERNAME_RE.test(value);
}

/** The IG user id inside an `instagram-graph:<id>` URI, or undefined. */
export function igUserIdFromActorUri(uri: string | undefined | null): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith(INSTAGRAM_GRAPH_ACTOR_URI_PREFIX))
    return undefined;
  const id = uri.slice(INSTAGRAM_GRAPH_ACTOR_URI_PREFIX.length);
  return IG_USER_ID_RE.test(id) ? id : undefined;
}

export function isInstagramGraphActorUri(uri: string | undefined | null): boolean {
  return igUserIdFromActorUri(uri) !== undefined;
}

/**
 * The Instagram username of an actor whose IDENTITY is on instagram.com — a
 * kilogram bridge actor (`networkAcct` `zuck@instagram.com`) or an
 * `instagram-graph` one. Undefined for everything else, including a malformed
 * username that could not be sent to the Graph API safely.
 */
export function instagramUsernameOfActor(
  actor: { networkAcct?: string | null } | null | undefined,
): string | undefined {
  const networkAcct = actor?.networkAcct?.trim();
  if (!networkAcct) return undefined;
  const at = networkAcct.lastIndexOf('@');
  if (at <= 0) return undefined;
  if (networkAcct.slice(at + 1).toLowerCase() !== INSTAGRAM_IDENTITY_DOMAIN) return undefined;
  const username = networkAcct.slice(0, at);
  return isValidInstagramUsername(username) ? username : undefined;
}

// ── Budget and cadence ───────────────────────────────────────────────────────
//
// Meta allows roughly 200 Graph calls per hour per token and reports the
// consumed share in `x-app-usage`. One Business Discovery call returns one page
// of media, so each sync below costs one call per page.

/**
 * The call-token bucket every Graph call must draw from BEFORE it is sent
 * (`usageBudget.ts`). Refill {@link GRAPH_CALLS_PER_HOUR} plus a full
 * {@link GRAPH_CALL_BUCKET_CAPACITY} burst stays under Meta's ~200/hour even in
 * the worst hour.
 */
export const GRAPH_CALLS_PER_HOUR = 150;
export const GRAPH_CALL_BUCKET_CAPACITY = 30;

/** Background calls may not drain the bucket below this: the rest is for readers. */
export const BACKGROUND_TOKEN_FLOOR = 15;

/** Above this `x-app-usage` percentage, background (non-interactive) calls stop. */
export const BACKGROUND_USAGE_CEILING_PCT = 75;

/** Above this, even a profile view stops calling — leave headroom for recovery. */
export const INTERACTIVE_USAGE_CEILING_PCT = 95;

/** Meta's usage window; an observation decays to zero across it. */
export const USAGE_WINDOW_MS = 60 * 60 * 1000;

/** First throttle backoff after error code 4/17/32/613; doubles per strike. */
export const THROTTLE_BACKOFF_BASE_MS = 15 * 60 * 1000;

/** Throttle backoff ceiling. */
export const THROTTLE_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;

/** After a code-190 (invalid token) answer, stop calling for this long. */
export const TOKEN_INVALID_PAUSE_MS = 60 * 60 * 1000;

/** Media per Graph page. Carousels expand to 20 children each, so keep it modest. */
export const GRAPH_MEDIA_PAGE_SIZE = 25;

/** Posts imported by a profile-view sync (one page). */
export const PROFILE_VIEW_SYNC_LIMIT = 20;

/** Posts inspected by one periodic sync of one actor (stops at the first known). */
export const PERIODIC_SYNC_LIMIT = 12;

/** Minimum interval between two Graph syncs of the same actor from profile views. */
export const PROFILE_VIEW_SYNC_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** A "not a business account" answer is re-asked at most this often. */
export const NOT_BUSINESS_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** A sync lease older than this belongs to a dead worker and may be reclaimed. */
export const SYNC_LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * A sync stops starting new work this long after it began, so a live worker
 * always finishes (and releases) well inside {@link SYNC_LEASE_TTL_MS}: a lease
 * reclaimed from a worker that is still downloading would run the same imports
 * twice.
 */
export const SYNC_DEADLINE_MS = 20 * 60 * 1000;

/**
 * A single sync never removes more than this many posts as "deleted on
 * Instagram"; more than that from one listing is an anomaly, not a clean-up.
 */
export const MAX_RECONCILE_DELETIONS = 10;

/** A sync cut short by its deadline may resume after this (not the full cooldown). */
export const DEADLINE_RETRY_MS = 15 * 60 * 1000;

/** A claimed source key (media being re-hosted) expires after this. */
export const SOURCE_KEY_CLAIM_TTL_MS = 30 * 60 * 1000;

/** A followed Instagram actor is re-synced by the periodic job at most this often. */
export const PERIODIC_SYNC_DUE_MS = 2 * 60 * 60 * 1000;

/** Actors per periodic run — ≤ 10 calls per 30 min keeps the job near 10% of budget. */
export const PERIODIC_SYNC_BATCH = 10;

/** Actors synced at once by the periodic job. */
export const PERIODIC_SYNC_CONCURRENCY = 2;
