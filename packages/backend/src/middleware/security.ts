import rateLimit from "express-rate-limit";
import slowDown from "express-slow-down";
import type { RequestHandler } from "express";
import { Request } from "express";
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { RedisStore } from "./rateLimitStore";
import { hashedIpKey } from "../utils/ipKey";
import { getValidatedFeedSource, isExpensiveFeedRequest } from './feedThrottleDescriptor';

// Realistic thresholds for global slow-down. The shared global rate limiter is
// owned by @oxyhq/core/server; this file only contains app-specific throttles.
const AUTHENTICATED_LIMIT_PER_WINDOW = 5000; // per 15 min
const UNAUTHENTICATED_LIMIT_PER_WINDOW = 600; // per 15 min

/**
 * Generate a rate limit key based on user authentication status.
 * Uses user ID for authenticated users, IP address for unauthenticated users.
 *
 * Route-local limiters mounted after authentication use the user ID. The
 * app-wide slow-down runs before route composition, so it intentionally falls
 * back to an HMAC of the caller IP when no earlier middleware populated a user.
 */
function generateRateLimitKey(req: Request, prefix: string): string {
  const authReq = req as AuthRequest;
  if (authReq.user?.id) {
    return `${prefix}:user:${authReq.user.id}`;
  }
  // Anonymous callers key by an HMAC of the (IPv6-subnet-normalized) IP so the
  // raw address never lands in a Redis key name.
  return `${prefix}:${hashedIpKey(req)}`;
}

/**
 * Get rate limit max value based on authentication status
 */
function getRateLimitMax(req: Request, authenticatedLimit: number, unauthenticatedLimit: number): number {
  const authReq = req as AuthRequest;
  return authReq.user?.id ? authenticatedLimit : unauthenticatedLimit;
}

/**
 * Shared predicate for requests that must never be slowed down.
 *
 * Exemptions:
 *  - OPTIONS preflight: CORS checks must always succeed instantly.
 *  - File uploads: large multipart bodies are inherently low-frequency and
 *    counting them against the API budget breaks media posting.
 *  - Image proxy / optimization ('/images/'): a single feed render pulls many
 *    images through our origin; these must not consume the API budget.
 *  - Media streaming / proxy ('/media/'): range-seeking generates many
 *    sub-requests per asset that should not count as API calls.
 *  - Health / liveness probes ('/health'): load balancer + ECS probes hit this
 *    constantly and must never be throttled.
 */
function isRateLimitExempt(req: Request): boolean {
  if (req.method === 'OPTIONS') {
    return true;
  }
  const path = req.path;
  return (
    path.startsWith('/files/upload') ||
    path.includes('/images/') ||
    path.includes('/media/') ||
    path.startsWith('/health')
  );
}

// Brute force protection middleware. Mirrors the rate limiter's auth-aware
// threshold and shares the same exemption predicate.
const bruteForceProtection: RequestHandler = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: (req: Request) => getRateLimitMax(req, AUTHENTICATED_LIMIT_PER_WINDOW, UNAUTHENTICATED_LIMIT_PER_WINDOW),
  delayMs: () => 500, // add 500ms delay per request above limit
  // Key per-user (fallback to IP) for the same reason as the rate limiter:
  // shared ALB IPs must not lump distinct authenticated users together.
  keyGenerator: (req: Request) => generateRateLimitKey(req, 'brute-force'),
  skip: isRateLimitExempt,
});

// Rate limiter for feed endpoints (per user: 100 requests/minute)
const feedStore = new RedisStore({ 
  prefix: 'rate-limit:feed:',
  windowMs: 60 * 1000 // 1 minute
});
export const feedRateLimiter = rateLimit({
  store: feedStore,
  windowMs: 60 * 1000, // 1 minute
  max: (req: Request) => {
    const authReq = req as AuthRequest;
    // Authenticated users: 100 requests per minute
    // Unauthenticated users: 50 requests per minute
    return authReq.user?.id ? 100 : 50;
  },
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    return hashedIpKey(req);
  },
  message: "Too many feed requests. Please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for feed endpoints (per IP: 10 requests/second)
const feedIPStore = new RedisStore({ 
  prefix: 'rate-limit:feed-ip:',
  windowMs: 1000 // 1 second
});
export const feedIPRateLimiter = rateLimit({
  store: feedIPStore,
  windowMs: 1000, // 1 second
  max: 10, // 10 requests per second per IP
  keyGenerator: (req: Request) => hashedIpKey(req),
  message: "Too many requests from this IP. Please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for the AI translation endpoints.
 *
 * These are the only routes where a cheap request buys EXPENSIVE work: a call can
 * trigger an Alia inference, and translation is free to every user, so nothing
 * else bounds the spend. `POST /posts/:id/translate` is cached per post+language,
 * so a determined caller is bounded by the number of posts — but
 * `POST /posts/translate-draft` takes arbitrary text and therefore CANNOT be
 * cached: every call is an inference. That is the endpoint this exists for.
 *
 * Deliberately tighter than the feed limiters: translating is a deliberate human
 * action, not something a scrolling client does dozens of times a minute.
 */
const translationStore = new RedisStore({
  prefix: 'rate-limit:translate:',
  windowMs: 60 * 1000,
});
export const translationRateLimiter = rateLimit({
  store: translationStore,
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    return hashedIpKey(req);
  },
  message: 'Too many translation requests. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for the routes that CREATE or EDIT a post.
 *
 * A post write is the network's main spam surface — it fans out to followers,
 * federates, and gets signed onto a chain — so it earns a bound of its own on top
 * of the app-wide limiter. Deliberately generous: a human composing normally never
 * comes close, a thread of many posts still fits, and the MCP/API clients that
 * post on a user's behalf keep working. It exists to stop a loop, not to police
 * enthusiasm.
 */
const postWriteStore = new RedisStore({
  prefix: 'rate-limit:post-write:',
  windowMs: 60 * 1000,
});
export const postWriteRateLimiter = rateLimit({
  store: postWriteStore,
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    return hashedIpKey(req);
  },
  message: 'Too many posts in a short time. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for the statistics/insights router.
 *
 * EVERY handler there reaches Mongo, so the whole router is the
 * `js/missing-rate-limiting` surface, not just the one route CodeQL's dataflow
 * happened to reach: `getPostInsights` runs three parallel `countDocuments`, the
 * public per-day heatmap aggregates a caller-chosen window of up to 366 days,
 * and the shared overview aggregation is cached only per `(user, days)` — which
 * a caller varies for free.
 *
 * Deliberately NOT the general `apiRateLimiter`: that one's store is keyed
 * `rate-limit:api:` and its `user:<id>` key is byte-identical to the one
 * `createOxyRateLimit` writes from `runtimeApp.ts` under the SAME prefix, so the
 * two already share a counter with mismatched windows (60s vs 15min). Mounting
 * more routes onto it would widen an existing collision rather than bound
 * anything. 200/minute matches the generosity it was reaching for; a profile
 * visit spends a handful.
 */
const statisticsStore = new RedisStore({
  prefix: 'rate-limit:statistics:',
  windowMs: 60 * 1000,
});
export const statisticsRateLimiter = rateLimit({
  store: statisticsStore,
  windowMs: 60 * 1000,
  max: 200,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    return hashedIpKey(req);
  },
  message: 'Too many statistics requests. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for `GET /lanes/mine`.
 *
 * The only lanes route whose cost scales with the CALLER'S OWN HISTORY and is not
 * cached: `countPostsByLane` runs a `$group` aggregation that walks one index
 * entry per lane-bearing post the caller has ever written, with no page and no
 * cache. Every other route on that router is a point lookup or a bounded list, so
 * this is a bound on one aggregation rather than a limiter on a surface.
 *
 * Its OWN store prefix, deliberately. `rate-limit-redis` keys are
 * `<prefix><key>`, so two limiters sharing a prefix share a counter — the exact
 * collision `rate-limit:api:` already suffers between `apiRateLimiter` and
 * `createOxyRateLimit`, where two windows (60s vs 15min) decrement one budget.
 * Reusing `statisticsRateLimiter` would repeat it.
 *
 * 120/minute: a management screen spends one request per visit, so this bounds
 * the aggregation without being reachable by ordinary use.
 */
const lanesStore = new RedisStore({
  prefix: 'rate-limit:lanes:',
  windowMs: 60 * 1000,
});
/**
 * `PUT /profile/settings/:userId` — the settings of an account the caller
 * OPERATES. Every OTHER route on the profile router resolves its target from the
 * authenticated subject; this one takes an id, and answering it costs a
 * membership read against Oxy. So a caller who is a member of nothing can still
 * spend one upstream round trip per request, which is what this bounds.
 *
 * Its OWN store prefix, for the reason spelled out above `lanesStore`: two
 * limiters sharing a prefix share a counter. The prefix is written as a LITERAL
 * because `rateLimitPrefixUniqueness.test.ts` resolves prefixes by reading
 * SOURCE — built through a factory, every store reads as the default and the
 * guard fails.
 *
 * 30/minute: configuring a channel is a handful of requests per sitting.
 */
const operatedAccountSettingsStore = new RedisStore({
  prefix: 'rate-limit:operated-account-settings:',
  windowMs: 60 * 1000,
});
export const operatedAccountSettingsRateLimiter = rateLimit({
  store: operatedAccountSettingsStore,
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    return authReq.user?.id ? `user:${authReq.user.id}` : hashedIpKey(req);
  },
  message: 'Too many account settings requests. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

export const lanesRateLimiter = rateLimit({
  store: lanesStore,
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    return hashedIpKey(req);
  },
  message: 'Too many lane requests. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The two COMPLIANCE limiters behind the Lanes routers.
 *
 * Distinct in kind from {@link lanesRateLimiter} above, and the difference is
 * worth stating because it decides the budgets. That one bounds a real cost —
 * `GET /lanes/mine` aggregates over the caller's whole post history, uncached.
 * These two bound nothing in particular: every route they cover is a point
 * lookup or an already-bounded list. They exist because CodeQL's
 * `js/missing-rate-limiting` reports a route with no limiter in its chain, that
 * check reads only the PR's diff rather than the repo's baseline, and this branch
 * would otherwise be the first to merge with it red.
 *
 * So the budgets are deliberately generous: the failure mode to avoid is
 * throttling somebody's ordinary CRUD in order to quiet a scanner. Reads are
 * 300/minute and writes 120/minute — two writes a second, sustained, which no
 * human interface produces.
 *
 * TWO rather than one: reads and writes are separated, so a write path can be
 * tightened later without touching the read path it shares a router with.
 *
 * TWO rather than one per route: CodeQL is satisfied by a limiter being in the
 * chain, and one counter per route would be a dozen Redis keys expressing a
 * distinction nothing acts on.
 *
 * **Each carries its OWN prefix.** Two limiters sharing one share a Redis key
 * whenever their key generators agree — and every generator here keys an
 * authenticated caller as `user:<id>` — which halves both budgets and lets the
 * first arrival silently fix the window for the rest. `rateLimitPrefixUniqueness`
 * enforces this across the tree.
 */
/**
 * Everything about a compliance limiter EXCEPT its store.
 *
 * The store is deliberately NOT built here, and this is load-bearing rather than
 * stylistic: `rateLimitPrefixUniqueness` resolves prefixes by reading the source,
 * so a `new RedisStore({ prefix })` behind a parameter is invisible to it — both
 * would read as the default `rate-limit:` and the guard would report a collision
 * it could not attribute. A helper that hides the prefix from the scanner defeats
 * a check that has already caught a real one, so each store below is constructed
 * inline with a LITERAL.
 */
function complianceOptions(max: number, message: string) {
  return {
    windowMs: 60 * 1000,
    max,
    keyGenerator: (req: Request) => {
      const authReq = req as AuthRequest;
      if (authReq.user?.id) {
        return `user:${authReq.user.id}`;
      }
      return hashedIpKey(req);
    },
    message,
    standardHeaders: true,
    legacyHeaders: false,
  };
}

/** Reads on the lanes routers — the public tab list and the caller's own lists. */
export const laneReadRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:lanes-read:', windowMs: 60 * 1000 }),
  ...complianceOptions(300, 'Too many lane requests. Please slow down.'),
});

/** Writes on the lanes router: create, rename, delete, mute, unmute, and a lane move. */
export const laneWriteRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:lanes-write:', windowMs: 60 * 1000 }),
  ...complianceOptions(120, 'Too many lane changes. Please slow down.'),
});

/**
 * `GET /channels/:oxyUserId/writers` — anonymously reachable, and the one route
 * here whose cost scales with a channel's whole publishing history: the writers
 * list is an aggregation over every public post that channel has published.
 * Cheap per call (the scan is index-covered) but unbounded in call rate, and an
 * unauthenticated caller keys to a hashed IP.
 *
 * Its OWN store prefix, for the reason spelled out above `lanesStore`: two
 * limiters sharing a prefix share a counter. The prefix is a LITERAL because
 * `rateLimitPrefixUniqueness.test.ts` resolves prefixes by reading SOURCE.
 */
export const channelWritersRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:channel-writers:', windowMs: 60 * 1000 }),
  ...complianceOptions(120, 'Too many channel writer requests. Please slow down.'),
});

/**
 * Rate limiter for `POST /statistics/post/:postId/view`.
 *
 * The only WRITE on the statistics router, and the only route there that reaches
 * Mongo on every single call: a counted view is a `findOneAndUpdate`, and a view
 * the dedupe window rejects still costs the read-back that produces the response.
 * Unbounded, that is one DB round trip per request for as fast as a caller can
 * issue them.
 *
 * Dedicated rather than folded into `feedRateLimiter`: these budgets are
 * unrelated, and sharing one would mean a viewer who opens many posts starts
 * getting throttled while SCROLLING. It is also tighter than the general
 * `apiRateLimiter` the router carries, because that one has to accommodate the
 * read endpoints too.
 *
 * 120/minute is two post-detail opens per second sustained for a full minute.
 * The client fires this once per open (`app/(app)/p/[id].tsx`), so a person
 * reading — even one tapping quickly through a thread — is nowhere near it,
 * while a loop reaches it in seconds. Deliberately looser than
 * `postWriteRateLimiter` (60/min): opening posts to read is a more frequent act
 * than composing them.
 */
const postViewStore = new RedisStore({
  prefix: 'rate-limit:post-view:',
  windowMs: 60 * 1000,
});
export const postViewRateLimiter = rateLimit({
  store: postViewStore,
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    return hashedIpKey(req);
  },
  message: 'Too many post views in a short time. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Request throttling for expensive feed operations (For You feed with ranking)
const feedThrottleStore = new RedisStore({ 
  prefix: 'rate-limit:feed-throttle:',
  windowMs: 60 * 1000 // 1 minute
});
export const feedThrottle: RequestHandler = slowDown({
  store: feedThrottleStore,
  windowMs: 60 * 1000, // 1 minute
  delayAfter: (req: Request) => {
    // Throttle expensive operations (For You feed, Explore feed)
    if (isExpensiveFeedRequest(req)) {
      const authReq = req as AuthRequest;
      return authReq.user?.id ? 20 : 10; // Lower limit for expensive operations
    }
    return 100; // Higher limit for simple operations
  },
  delayMs: () => 1000, // Add 1 second delay per request above limit
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    const feedType = getValidatedFeedSource(req) || 'invalid';
    if (authReq.user?.id) {
      return `user:${authReq.user.id}:${feedType}`;
    }
    return `${hashedIpKey(req)}:${feedType}`;
  },
  skip: (req: Request) => {
    // Don't throttle simple feed types
    return !isExpensiveFeedRequest(req);
  }
});

export { bruteForceProtection };
