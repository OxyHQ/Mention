import { FeedPostSlice, FeedSliceItem, HydratedPost, HydratedPostSummary, HydratedBoostContext, HydratedAuthor, PostUser, PostAttachmentBundle, PostEngagementSummary, PostLinkPreview, PostPermissions, PostReplyContext, PostViewerState, PostVisibility, PostAuthorshipEntry, MEDIA_VARIANT_THUMB } from '@mention/shared-types';
import type { LaneDisplayMode, LaneSummary } from '@mention/shared-types';
import { isValidObjectId } from 'mongoose';
import { Post, type PostFederationData } from '../models/Post';
import { Lane } from '../models/Lane';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import { FederatedActor } from '../models/FederatedActor';
import { UserSettings } from '../models/UserSettings';
import { disclosesWriters, loadSigningChannelIds } from './channelWriterDisclosure';
import { actorService } from '../connectors/activitypub/actor.service';
import { ACTOR_DOMAIN, FEDERATION_DOMAIN, FEDERATION_ENABLED } from '../connectors/activitypub/constants';
import { deriveBridgyActorUri } from '../connectors/activitypub/bridgy';
import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { extractUrls } from '../utils/extractUrls';
import { ownProfileUrlHandle } from '@mention/shared-types/profileUrls';
import {
  getBlockedUserIds,
  getRestrictedUserIds,
  extractFollowingIds,
  extractFollowersIds,
  OxyClient,
} from '../utils/privacyHelpers';
import { resolveMediaItems, attachCdnVariant } from '../utils/mediaResolver';
import { logger } from '../utils/logger';
import { readPersistedMediaFields } from './MediaMetadataService';
// The counter-visibility flags are shared with the realtime broadcaster, which
// has to hide exactly what the DTO hides — see `engagementCountPrivacy.ts`.
import { DEFAULT_PRIVACY, readEngagementCountPrivacy } from './engagementCountPrivacy';
import type { User as OxyUser } from '@oxyhq/core';
import { getNormalizedUserHandle, getUserLanguages } from '@oxyhq/core';
import type { LinkPreview } from '@oxyhq/contracts';
import { assignThreadState } from './ThreadSlicingService';
import { mget as mgetUserSummaries, mset as msetUserSummaries, CachedUserSummary } from './userSummaryCache';
import { computeStarterPackScores, mongoStarterPackCurationDeps } from './starterPackCuration';
import {
  collectAuthorshipUserIds,
  getHeaderAuthorshipEntries,
  getViewerEntry,
  normalizeAuthorship,
} from '../utils/postAuthorship';
import { canManagePostWithoutLookup } from './postManagementAccess';
import { normalizeMentionIds } from '../utils/textProcessing';
import { isReplyPost } from '../utils/postReply';
import { degradedActorSummary } from '../utils/degradedActorSummary';
import {
  readerVariants,
  resolveVariant,
  resolveViewerTag,
  type ResolvedVariant,
} from './postVariants';
import { loadRecentReplierIds } from './PostRecentReplierService';

import { PostContentVariant, PostMetadata, StoredPostContent } from '@mention/shared-types';

/**
 * The hosts whose `/@alice` URLs name a user in OUR namespace.
 *
 * These must be the same hosts the app recognises
 * (`packages/frontend/utils/ownProfileLinks.ts`, which derives its list from the
 * app's `WEB_BASE_URL` and is shared by the reader's linkifier, the composer's
 * card gate and the composer's mention summary), because the decisions are all
 * halves of one behaviour:
 * the renderer turns such a URL into a mention, and {@link ownProfileLinkUrls}
 * withholds the preview card that would otherwise sit under it. If the lists
 * disagree the reader sees the mismatch — a mention with a redundant card, or a
 * link that lost its card for no visible reason.
 *
 * The federation domain rather than `FRONTEND_URL`: they agree in production,
 * but `FRONTEND_URL` is a CORS origin and is `http://localhost:8110` in
 * development, where the app's own base URL is not. `ACTOR_DOMAIN` defaults to
 * the same value and is only distinct when actor URIs are served elsewhere.
 */
const OWN_PROFILE_HOSTS: readonly string[] = [
  ...new Set([FEDERATION_DOMAIN, ACTOR_DOMAIN].filter((host): host is string => Boolean(host))),
];

/**
 * True when a URL names a profile on this instance — the URLs the reader is
 * shown a MENTION for rather than a link.
 *
 * The same `ownProfileUrlHandle` the linkifier decides with, so the two cannot
 * drift into disagreeing about a URL: whatever the renderer swallows into a
 * mention is exactly what loses its card, and everything else keeps one. Purely
 * syntactic, so this costs a `URL` parse per extracted link and no I/O.
 */
function isOwnProfileLink(url: string): boolean {
  return ownProfileUrlHandle(url, OWN_PROFILE_HOSTS) !== undefined;
}

/**
 * A raw post plain-object as returned by `.lean()` or `.toObject()`.
 * Covers all fields accessed during hydration, including federated-only fields.
 */
interface RawPost {
  _id?: unknown;
  id?: string;
  oxyUserId?: string;
  /**
   * The human who wrote a post published BY a `channel` account, recorded here
   * rather than in `authorship` (which would put the post back on their own
   * profile and their followers' timelines). Read only to decide the byline —
   * it never reaches a DTO field of its own.
   */
  writtenByOxyUserId?: string;
  authorship?: PostAuthorshipEntry[];
  /** The post's STORED content: renditions (`variants[0]` is the primary) + the shared media/article. */
  content?: Partial<StoredPostContent>;
  metadata?: Partial<PostMetadata>;
  /** AP federation metadata (federated posts only); `spoilerText` is the CW label. */
  federation?: PostFederationData;
  /**
   * Stage-A classification subdoc. Only the canonical multi-language array is
   * read during hydration (surfaced to the DTO as `metadata.languages`).
   */
  postClassification?: { languages?: string[] };
  stats?: {
    likesCount?: number;
    downvotesCount?: number;
    boostsCount?: number;
    commentsCount?: number;
    viewsCount?: number;
    savesCount?: number;
  };
  boostOf?: unknown;
  quoteOf?: unknown;
  /** The author's lane for this post — the `› Lane name` chip. Local curation only. */
  laneId?: string;
  originalPostId?: unknown;
  parentPostId?: unknown;
  threadId?: unknown;
  replyPermission?: string[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  hashtags?: string[];
  mentions?: unknown[];
  tags?: string[];
  visibility?: string;
  status?: string;
  scheduledFor?: unknown;
  language?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  date?: unknown;
  /** Allow additional fields from lean/toObject results */
  [key: string]: unknown;
}

interface HydrationOptions {
  viewerId?: string;
  oxyClient?: OxyClient; // Per-request OxyServices instance with user's auth token
  maxDepth?: number;
  includeLinkMetadata?: boolean;
  includeFullArticleBody?: boolean; // For feed, skip full article bodies
  includeFullMetadata?: boolean; // For feed, skip some metadata fields
  /**
   * When hydrating posts for public federation surfaces, referenced posts
   * (boost/quote originals) must not bypass their own publication controls.
   * Root posts are still supplied by the caller's query; this only constrains
   * graph expansion by id.
   */
  publicReferencesOnly?: boolean;
  /**
   * The viewer's already-resolved social graph, threaded from the feed context
   * (`loadViewerFeedContext`). When present, {@link buildViewerContext} populates
   * the viewer follows/followedBy sets from these ids and SKIPS the per-request
   * `getUserFollowing`/`getUserFollowers` Oxy round trips (the feed already
   * resolved them once, in parallel). When absent — every non-feed caller (post
   * detail, notifications, profile, search) — hydration falls back to the live
   * Oxy fetch, so those paths are unchanged. Both id lists are required together
   * (the feed always threads both) so the graph is applied atomically.
   */
  viewerGraph?: { followingIds: string[]; followerIds: string[] };
  /**
   * The language preference carried by the REQUEST — an explicit `?lang=` the
   * reader picked, then `Accept-Language` — most-preferred first, from
   * {@link requestLanguageCandidates}. It leads the variant-resolution ladder;
   * the viewer's Oxy account locales follow. A caller with no request context
   * (the OG renderer, MCP, a socket broadcast) omits it and gets the post's
   * primary language, which is what those surfaces should show.
   */
  requestLanguages?: string[];
  /**
   * The viewer's Oxy account locales, when the caller already resolved them (the
   * feed does, in `loadViewerFeedContext`). Absent → {@link buildViewerContext}
   * reads them from the Redis-cached identity itself.
   */
  viewerLanguages?: string[];
  /**
   * Count the posts that quote each hydrated post and expose them as
   * `engagement.quotes`. Off by default: there is no denormalized `quotesCount`
   * on `stats`, so this costs one extra aggregate over the `quoteOf` index per
   * hydration call — worth it on the post-detail endpoints that render the
   * number, wasted on every feed request that does not.
   */
  includeQuoteCounts?: boolean;
}

interface HydratedGraphNode {
  post: RawPost;
  depth: number;
}

interface ViewerContext {
  viewerId?: string;
  /**
   * The viewer's ordered language preference — the request's tags (explicit
   * `?lang`, then `Accept-Language`) followed by the Oxy account locales. This is
   * the ladder `resolveViewerTag` walks to pick which localized rendition of each
   * post to serve. Empty for an anonymous reader with no header (a crawler), which
   * resolves every post to its primary language.
   */
  languageCandidates: string[];
  privacyPreferences: {
    hideLikeCounts: boolean;
    hideShareCounts: boolean;
    hideReplyCounts: boolean;
    hideSaveCounts: boolean;
  };
  blockedIds: Set<string>;
  restrictedIds: Set<string>;
  follows: Set<string>;
  followedBy: Set<string>;
  likedPosts: Set<string>;
  downvotedPosts: Set<string>;
  savedPosts: Set<string>;
  boostedPosts: Set<string>;
  /** Author IDs with private or followers_only profile visibility */
  privateProfileIds: Set<string>;
}

interface ExtendedViewerContext extends ViewerContext {
  includeFullArticleBody?: boolean;
  includeFullMetadata?: boolean;
  _authorPrivacyCache?: Map<string, typeof DEFAULT_PRIVACY>;
}

/**
 * The projection for a reply's PARENT, fetched only to answer "whom does this
 * reply answer" (see `buildReplyParentAuthorMap`). Deliberately minimal: the
 * parent's body is never rendered from here, so this carries the author link and
 * nothing beyond the fields the ACL itself reads.
 *
 * Every field is load-bearing. `status` and `visibility` are what
 * `canViewerReadPost` gates on — leave either unprojected and it reads
 * `undefined`, defaults to published/public, and the gate silently stops
 * gating. `authorship` carries the collaborator entries that let a viewer
 * legitimately see their own unpublished post, and `federation` is what marks a
 * parent as federated (hence public by definition).
 */
const REPLY_PARENT_PROJECTION = '_id oxyUserId authorship federation status visibility';

/**
 * Build the cached identity ({@link CachedUserSummary}: raw Oxy user + the
 * ranking-side follower count and account languages) from a resolved Oxy user.
 * Oxy owns the user shape, so the {@link PostUser} half is a PASSTHROUGH: it
 * selects the canonical fields without reshaping — no flat `displayName`, no
 * pre-resolved `avatarUrl`, no wire `handle`. `avatar` stays the bare Oxy file id
 * (Bloom's `ImageResolver` renders it, same as Who-to-follow / the profile
 * header). Centralized so the per-id and the bulk resolution paths cache
 * IDENTICAL output.
 */
function toCachedUser(userId: string, userData: OxyUser): CachedUserSummary {
  const isFederated = Boolean(userData.isFederated) || userData.type === 'federated';
  const federation = userData.federation;

  const user: PostUser = {
    id: String(userData.id || userId),
    username: userData.username || undefined,
    // Canonical structured name — passed through unchanged. `name.displayName`
    // is present only when the user has a real name; renderers fall back to the
    // handle when it is absent (never synthesize a name here).
    name: userData.name ?? {},
    // Bare Oxy file id (or a mirrored absolute URL) — never pre-resolved here.
    avatar: userData.avatar ?? null,
    verified: Boolean(userData.verified || userData.isVerified),
    // The account classification, passed through UNCHANGED like every other Oxy
    // user field. It is what tells a renderer to link a channel's post to
    // `/c/<handle>`, and what `services/publishAsAccount` reads server-side.
    kind: userData.kind,
    isFederated: isFederated || undefined,
    federation: federation
      ? { domain: federation.domain, actorUri: federation.actorUri, actorId: federation.actorId }
      : undefined,
    instance: isFederated ? (userData.instance || federation?.domain) : (userData.instance || undefined),
  };

  const followerCount = userData._count?.followers;
  // Account locales, normalized/validated/deduped by the SDK (`es-es` → `es-ES`,
  // unsupported tags dropped). Cached alongside the identity so the feed can read
  // the VIEWER's languages without a second Oxy round trip; omitted when the
  // account declares none, which keeps the language signal neutral.
  const languages = getUserLanguages(userData);
  return {
    user,
    followerCount: typeof followerCount === 'number' ? followerCount : undefined,
    languages: languages.length > 0 ? languages : undefined,
  };
}

// Preserve the existing public import path while keeping the placeholder in a
// dependency-light module that non-hydration surfaces can safely reuse.
export { degradedActorSummary };

/** A minimal, safe cached value used when an author cannot be resolved from Oxy. */
function fallbackSummary(userId: string): CachedUserSummary {
  return { user: degradedActorSummary(userId) };
}

/**
 * Whether a {@link PostUser} is the degraded/unresolved placeholder — the ONLY
 * user with an EMPTY `username` (a resolved Oxy user always has one, and a
 * federated-enriched user has its `username@domain` restored). Callers use this
 * to SKIP an unresolved actor (starter-pack members, mention-placeholder
 * replacement) instead of rendering a nameless row. Kept in lockstep with
 * `degradedActorSummary`.
 */
export function isFallbackUserSummary(user: PostUser): boolean {
  return !user.username;
}

/**
 * Enrich any author that degraded (Oxy resolution failed transiently) with its
 * canonical FEDERATED identity from Mention's own {@link FederatedActor} record.
 *
 * Unlike a local author, a federated author's `username@domain` + remote avatar
 * are knowable WITHOUT Oxy. This fills the MISSING `username` / `federation.domain`
 * / `avatar` so a federated post shows its REAL, tappable handle (and image)
 * instead of a neutral "Unknown user" whenever Oxy is momentarily unreachable (or
 * in the brief window right after the bridge mints the Oxy user).
 *
 * It NEVER invents `name.displayName` — the FederatedActor has no display-name
 * field, so an enriched author renders its handle. Enriched (still-incomplete)
 * users are NOT cached (see {@link resolveUserSummaries}), so they self-heal once
 * Oxy recovers. Mutates `resolved` in place; batched, best-effort.
 */
async function enrichDegradedFederatedUsers(resolved: Map<string, CachedUserSummary>): Promise<void> {
  const degradedIds: string[] = [];
  for (const [userId, value] of resolved) {
    if (isFallbackUserSummary(value.user)) {
      degradedIds.push(userId);
    }
  }
  if (degradedIds.length === 0) return;

  let actors: Array<{ oxyUserId?: string; acct?: string; username?: string; domain?: string; avatarUrl?: string }>;
  try {
    actors = await FederatedActor.find({ oxyUserId: { $in: degradedIds } })
      .select('oxyUserId acct username domain avatarUrl')
      .lean();
  } catch (error) {
    logger.warn('[PostHydration] Federated author enrich lookup failed', {
      count: degradedIds.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return;
  }

  for (const actor of actors) {
    const oxyUserId = actor.oxyUserId ? String(actor.oxyUserId) : '';
    if (!oxyUserId) continue;
    const username = actor.username || (actor.acct ? actor.acct.split('@')[0] : '');
    if (!username) continue;
    const existing = resolved.get(oxyUserId);
    resolved.set(oxyUserId, {
      user: {
        id: oxyUserId,
        username,
        // Deliberately empty: never invent a display name. The renderer falls
        // back to the (now-restored) `username@domain` handle.
        name: {},
        avatar: existing?.user.avatar ?? actor.avatarUrl ?? null,
        isFederated: true,
        federation: actor.domain ? { domain: actor.domain } : undefined,
        instance: actor.domain || undefined,
      },
      followerCount: existing?.followerCount,
      starterPackScore: existing?.starterPackScore,
    });
  }
}

/**
 * Stamp the bounded starter-pack CURATION score onto the summaries resolved in
 * this batch, BEFORE they are written to the Redis cache — so the score is read
 * back on every warm hydration and the `starterPackBoost` ranking signal costs no
 * per-post (and no per-author) query.
 *
 * ONE batched aggregation for the WHOLE set of freshly-resolved authors, run only
 * on the cache-MISS path. Fail-soft by construction: {@link computeStarterPackScores}
 * never throws, and an author with no score is simply left without the field,
 * which the signal reads as exactly neutral. Mutates `freshlyResolved` in place.
 */
async function applyStarterPackScores(freshlyResolved: Map<string, CachedUserSummary>): Promise<void> {
  if (freshlyResolved.size === 0) return;

  const scores = await computeStarterPackScores(
    Array.from(freshlyResolved.keys()),
    mongoStarterPackCurationDeps,
  );
  for (const [userId, score] of scores) {
    const summary = freshlyResolved.get(userId);
    if (summary) {
      summary.starterPackScore = score;
    }
  }
}

/** Maximum number of public per-user Oxy reads in flight after a bulk miss. */
export const OXY_USER_FALLBACK_CONCURRENCY = 8;
/** One wall-clock budget shared by the bulk read and every fallback read. */
export const OXY_USER_RESOLUTION_DEADLINE_MS = 1_500;

class OxyUserResolutionDeadlineError extends Error {
  constructor() {
    super('Oxy user resolution deadline exceeded');
    this.name = 'OxyUserResolutionDeadlineError';
  }
}

const userSummaryFlights = new Map<string, Promise<Map<string, CachedUserSummary>>>();
let activeOxyUserResolutionCalls = 0;
const oxyUserResolutionWaiters: Array<{
  grant: () => void;
  cancel: () => void;
}> = [];

function userSummaryFlightKey(userIds: string[]): string {
  return [...userIds].sort().join('\u0000');
}

async function withinUserResolutionDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new OxyUserResolutionDeadlineError();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new OxyUserResolutionDeadlineError()), remainingMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function releaseOxyUserResolutionPermit(): void {
  const next = oxyUserResolutionWaiters.shift();
  if (next) {
    next.grant();
    return;
  }
  activeOxyUserResolutionCalls = Math.max(0, activeOxyUserResolutionCalls - 1);
}

async function acquireOxyUserResolutionPermit(
  deadlineAt: number,
): Promise<() => void> {
  if (Date.now() >= deadlineAt) {
    throw new OxyUserResolutionDeadlineError();
  }

  if (activeOxyUserResolutionCalls < OXY_USER_FALLBACK_CONCURRENCY) {
    activeOxyUserResolutionCalls += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseOxyUserResolutionPermit();
    };
  }

  return new Promise<() => void>((resolve, reject) => {
    const remainingMs = deadlineAt - Date.now();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          releaseOxyUserResolutionPermit();
        });
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new OxyUserResolutionDeadlineError());
      },
    };
    timeout = setTimeout(() => {
      const index = oxyUserResolutionWaiters.indexOf(waiter);
      if (index >= 0) oxyUserResolutionWaiters.splice(index, 1);
      waiter.cancel();
    }, Math.max(0, remainingMs));
    timeout.unref?.();
    oxyUserResolutionWaiters.push(waiter);
  });
}

/**
 * Bound Oxy I/O across every concurrent hydration cohort. A timed-out caller
 * stops waiting, but its permit remains occupied until the underlying SDK call
 * actually settles. This prevents slow or non-abortable SDK requests from
 * accumulating without limit during an outage.
 */
async function runBoundedOxyUserResolutionCall<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const release = await acquireOxyUserResolutionPermit(deadlineAt);
  const inFlight = Promise.resolve().then(operation);
  void inFlight.then(release, release);
  return withinUserResolutionDeadline(inFlight, deadlineAt);
}

async function runWithConcurrencyLimit<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex++];
        await worker(value);
      }
    },
  );
  await Promise.all(workers);
}

async function resolveOxyUserSummaryMisses(
  missIds: string[],
): Promise<Map<string, CachedUserSummary>> {
  const deadlineAt = Date.now() + OXY_USER_RESOLUTION_DEADLINE_MS;
  const requestedIds = new Set(missIds);
  const freshlyResolved = new Map<string, CachedUserSummary>();
  let bulkFailure: unknown;

  try {
    const users = await runBoundedOxyUserResolutionCall(
      () => getServiceOxyClient().getUsersByIds(missIds),
      deadlineAt,
    );
    for (const user of Array.isArray(users) ? users : []) {
      const id = String((user as { id?: unknown }).id ?? '');
      if (id && requestedIds.has(id)) {
        freshlyResolved.set(id, toCachedUser(id, user));
      }
    }
  } catch (error) {
    bulkFailure = error;
  }

  const unresolved = missIds.filter((userId) => !freshlyResolved.has(userId));
  let perIdFailures = 0;
  let deadlineExceeded = bulkFailure instanceof OxyUserResolutionDeadlineError;

  if (unresolved.length > 0 && Date.now() < deadlineAt) {
    await runWithConcurrencyLimit(
      unresolved,
      OXY_USER_FALLBACK_CONCURRENCY,
      async (userId) => {
        if (Date.now() >= deadlineAt) {
          deadlineExceeded = true;
          perIdFailures += 1;
          return;
        }

        try {
          const userData = await runBoundedOxyUserResolutionCall(
            () => getRuntimeOxyClient().getUserById(userId),
            deadlineAt,
          );
          freshlyResolved.set(userId, toCachedUser(userId, userData));
        } catch (error) {
          if (error instanceof OxyUserResolutionDeadlineError) {
            deadlineExceeded = true;
          }
          perIdFailures += 1;
        }
      },
    );
  } else if (unresolved.length > 0) {
    deadlineExceeded = true;
    perIdFailures = unresolved.length;
  }

  if (bulkFailure || perIdFailures > 0) {
    logger.warn('[PostHydration] Oxy user resolution was partial', {
      requested: missIds.length,
      resolved: freshlyResolved.size,
      fallbackFailures: perIdFailures,
      deadlineExceeded,
      bulkReason: bulkFailure instanceof Error ? bulkFailure.message : undefined,
    });
  }

  await applyStarterPackScores(freshlyResolved);
  if (freshlyResolved.size > 0) {
    await msetUserSummaries(freshlyResolved);
  }

  const result = new Map<string, CachedUserSummary>();
  for (const userId of missIds) {
    result.set(userId, freshlyResolved.get(userId) ?? fallbackSummary(userId));
  }

  // Mention-owned federated data can repair a degraded actor, but repaired and
  // degraded summaries remain deliberately uncached so Oxy can self-heal them.
  await enrichDegradedFederatedUsers(result);
  return result;
}

/**
 * Resolve {@link CachedUserSummary} for a set of Oxy user ids, collapsing the
 * classic feed M+1 (one `getUserById` per unique author) into:
 *   1. a single batched read of the Redis user-summary cache, then
 *   2. a single bulk service-token Oxy fetch for the MISSES (`getUsersByIds`
 *      via the service client; bounded per-id fallback under one deadline), then
 *   3. a single batched write of the freshly-resolved summaries back to cache.
 *
 * Cache hits never touch Oxy. Misses that error fall back to a minimal summary
 * (and are NOT cached, so they re-resolve next time). Shared by hydration
 * ({@link PostHydrationService.buildUserMap}) and the ranking authority signal.
 */
export async function resolveUserSummaries(userIds: string[]): Promise<Map<string, CachedUserSummary>> {
  const resolved = new Map<string, CachedUserSummary>();
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueUserIds.length === 0) {
    return resolved;
  }

  // 1. Batched cache read.
  const cached = await mgetUserSummaries(uniqueUserIds);
  const missIds: string[] = [];
  for (const userId of uniqueUserIds) {
    const hit = cached.get(userId);
    if (hit) {
      resolved.set(userId, hit);
    } else {
      missIds.push(userId);
    }
  }

  if (missIds.length === 0) {
    return resolved;
  }

  // 2. Single-flight an identical miss cohort. The shared resolver performs the
  //    bulk service-token read first and bounds any public per-id fallback.
  const flightKey = userSummaryFlightKey(missIds);
  let flight = userSummaryFlights.get(flightKey);
  if (!flight) {
    flight = resolveOxyUserSummaryMisses(missIds);
    userSummaryFlights.set(flightKey, flight);
    void flight.then(
      () => {
        if (userSummaryFlights.get(flightKey) === flight) {
          userSummaryFlights.delete(flightKey);
        }
      },
      () => {
        if (userSummaryFlights.get(flightKey) === flight) {
          userSummaryFlights.delete(flightKey);
        }
      },
    );
  }

  const freshlyResolved = await flight;

  // 3. Merge cache-miss results (real users or deliberately uncached fallbacks).
  for (const [userId, value] of freshlyResolved) {
    resolved.set(userId, value);
  }

  return resolved;
}

/**
 * Lowercased host of the first parseable absolute URL among `urls` (an actor
 * URI, a canonical post URL, or an activity id). Used as the `instance` on a
 * degraded federated author so the ORIGIN still surfaces when no handle is
 * knowable (e.g. a brid.gy/Bluesky-bridged note that carries only an
 * `activityId`). Returns `undefined` when none parse.
 */
function federatedHost(...urls: Array<string | undefined>): string | undefined {
  for (const url of urls) {
    if (!url) continue;
    try {
      const host = new URL(url).host.toLowerCase();
      if (host) return host;
    } catch {
      // Not a parseable absolute URL — try the next candidate.
    }
  }
  return undefined;
}

/**
 * Actor URIs currently being lazily resolved out of {@link resolveOrphanFederatedAuthors}.
 * Collapses the repeated hydrations of a hot feed onto ONE detached fetch per
 * actor so a re-rendering orphan cohort never storms the remote.
 */
const inFlightOrphanActorSyncs = new Set<string>();

/**
 * Fire-and-forget: lazily resolve (fetch + create) the FederatedActor + Oxy
 * federated user for a set of actor URIs DERIVED from legacy brid.gy/Bluesky
 * orphan posts. This is the SAME on-demand sync the inbound Like/Announce/mention
 * paths use ({@link actorService.getOrFetchActor}), run DETACHED so it never
 * blocks feed hydration; the resolved actor lands in Mongo, so the NEXT hydration
 * of the same orphan renders the real `@handle@bsky.brid.gy` (self-healing).
 *
 * Bounded to the unique derivable actors in one hydration batch and deduped by an
 * in-flight guard. Fail-soft: every error is swallowed (logged at debug) — an
 * orphan simply stays degraded until a later pass succeeds.
 */
function scheduleOrphanActorSync(actorUris: Set<string>): void {
  if (!FEDERATION_ENABLED || actorUris.size === 0) return;
  for (const actorUri of actorUris) {
    if (inFlightOrphanActorSyncs.has(actorUri)) continue;
    inFlightOrphanActorSyncs.add(actorUri);
    void actorService
      .getOrFetchActor(actorUri)
      .catch((error) => {
        logger.debug('[PostHydration] Orphan actor lazy sync failed', {
          actorUri,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      })
      .finally(() => {
        inFlightOrphanActorSyncs.delete(actorUri);
      });
  }
}

/**
 * Build the author {@link PostUser} for FEDERATED posts whose Oxy author link is
 * missing — legacy "orphans" ingested before the federated-actor → Oxy-user link
 * was enforced, so `oxyUserId` is null. Such a post is NOT dropped: its CONTENT
 * (text/media) must still render so a boost/quote referencing it — and the post
 * itself — is not blank. The author is derived ONLY from the post's own
 * federation data + Mention's own {@link FederatedActor} record, NEVER from a raw
 * id (the ghost-handle rule):
 *
 *  1. Resolve each orphan's author actor URI: the stored `federation.actorUri`,
 *     or — for a brid.gy/Bluesky orphan that stored only the object URL — the
 *     actor URI deterministically {@link deriveBridgyActorUri | derived} from the
 *     atproto DID embedded in `federation.activityId`/`federation.url` (no network).
 *  2. If a {@link FederatedActor} exists for that URI, use its authoritative
 *     `username@domain` + avatar — the SAME enrichment
 *     {@link enrichDegradedFederatedUsers} applies, keyed here by actor URI since
 *     there is no `oxyUserId`. It NEVER invents a `name.displayName`.
 *  3. If the URI was DERIVED and has no FederatedActor row yet (the common brid.gy
 *     case — the actor was never synced), kick a fire-and-forget
 *     {@link scheduleOrphanActorSync} that mints the actor + Oxy user off the
 *     request path, and degrade WITH the bridge origin this pass so the DTO
 *     self-heals to the real handle on the next load.
 *  4. Otherwise fall back to {@link degradedActorSummary} ("Unknown user", empty
 *     handle), marked federated with the origin `instance` when a host is
 *     derivable. The empty handle suppresses the `@handle` line and the profile
 *     link, so no misleading handle is ever emitted.
 *
 * Batched (single FederatedActor query), best-effort, and never cached — the DTO
 * self-heals once the actor resolves or the post's `oxyUserId` is backfilled and
 * normal Oxy resolution takes over. Keyed by post id (orphans have no `oxyUserId`
 * to key on).
 */
export async function resolveOrphanFederatedAuthors(
  orphans: Array<{ postId: string; federation: PostFederationData }>,
): Promise<Map<string, PostUser>> {
  const result = new Map<string, PostUser>();
  if (orphans.length === 0) return result;

  // Resolve each orphan's effective author actor URI up front: the stored one, or
  // — when absent — the brid.gy actor URI derived from the atproto DID in the
  // object URL. Track which post used a DERIVED URI so only those (never a
  // stored-actorUri orphan) trigger the lazy on-demand actor sync below.
  const derivedByPost = new Map<string, string>();
  const lookupUris = new Set<string>();
  for (const { postId, federation } of orphans) {
    if (federation.actorUri) {
      lookupUris.add(federation.actorUri);
      continue;
    }
    const derivedUri = deriveBridgyActorUri(federation.activityId, federation.url);
    if (derivedUri) {
      derivedByPost.set(postId, derivedUri);
      lookupUris.add(derivedUri);
    }
  }

  const actorByUri = new Map<
    string,
    { username?: string; acct?: string; domain?: string; avatarUrl?: string; oxyUserId?: string }
  >();
  if (lookupUris.size > 0) {
    try {
      const actors = await FederatedActor.find({ uri: { $in: Array.from(lookupUris) } })
        .select('uri username acct domain avatarUrl oxyUserId')
        .lean();
      for (const actor of actors) {
        const uri = (actor as { uri?: string }).uri;
        if (uri) actorByUri.set(uri, actor);
      }
    } catch (error) {
      logger.warn('[PostHydration] Orphan federated author lookup failed', {
        count: lookupUris.size,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  // Derived brid.gy actors that have no local row yet — resolved off the request
  // path after the loop so the next hydration renders the real handle.
  const lazyResolveUris = new Set<string>();

  for (const { postId, federation } of orphans) {
    const derivedUri = federation.actorUri ? undefined : derivedByPost.get(postId);
    const actorUri = federation.actorUri ?? derivedUri;
    const actor = actorUri ? actorByUri.get(actorUri) : undefined;
    const username = actor?.username || (actor?.acct ? actor.acct.split('@')[0] : '');

    if (actor && username) {
      // Authoritative federated identity from Mention's own FederatedActor record
      // (never invents a display name — the renderer falls back to the handle).
      result.set(postId, {
        id: actor.oxyUserId || actorUri || postId,
        username,
        name: {},
        avatar: actor.avatarUrl ?? null,
        isFederated: true,
        federation: actor.domain
          ? { domain: actor.domain, actorUri }
          : (actorUri ? { actorUri } : undefined),
        instance: actor.domain || federatedHost(actorUri),
      });
      continue;
    }

    // A brid.gy actor we derived but have never synced: mint it in the background
    // so the NEXT hydration resolves the real handle.
    if (derivedUri) {
      lazyResolveUris.add(derivedUri);
    }

    // No knowable handle THIS pass: a neutral "Unknown user", still marked
    // federated with the origin host so the CONTENT (not a fabricated handle) is
    // what renders.
    const instance = federatedHost(actorUri, federation.url, federation.activityId);
    result.set(postId, {
      ...degradedActorSummary(actorUri || federation.url || federation.activityId || postId),
      isFederated: true,
      ...(instance ? { instance, federation: { domain: instance, ...(actorUri ? { actorUri } : {}) } } : {}),
    });
  }

  scheduleOrphanActorSync(lazyResolveUris);

  return result;
}

export class PostHydrationService {
  async hydratePosts(rawPosts: object[], options: HydrationOptions = {}): Promise<HydratedPost[]> {
    if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
      return [];
    }

    const maxDepth = Math.max(0, options.maxDepth ?? 1);
    const viewerContext = await this.buildViewerContext(rawPosts, options.viewerId, options);

    const initialPosts = rawPosts
      .map((p): RawPost => (typeof (p as { toObject?: () => RawPost }).toObject === 'function' ? (p as { toObject: () => RawPost }).toObject() : p as RawPost))
      .filter((post) => {
        if (!post) return false;
        const authorId = post.oxyUserId ? String(post.oxyUserId) : undefined;
        if (authorId) return !viewerContext.blockedIds.has(authorId);
        // A FEDERATED post whose Oxy author link is missing (a legacy "orphan",
        // ingested before the federated-actor → Oxy-user link was enforced) is
        // NOT a data error — it still renders in a degraded form (see
        // buildPostSummary) so the post itself, and any boost/quote referencing
        // it, is not blank. A native post with no author IS a data error → drop.
        return Boolean(post.federation?.activityId);
      });

    if (initialPosts.length === 0) {
      return [];
    }

    const graph = await this.collectPostsWithDepth(
      initialPosts,
      maxDepth,
      viewerContext.blockedIds,
      options.publicReferencesOnly === true,
    );

    const postIds = Array.from(graph.keys());
    // Every post row actually fetched into the graph (initial posts + collected
    // references). Used by `attachNestedContext` to tell a GENUINELY-MISSING boost
    // original (never fetched → not here) from one dropped by an ACL check.
    const collectedPostIds = new Set(postIds);
    const postsForHydration = Array.from(graph.values());

    // Resolve each post's localized rendition for THIS viewer, once. Everything
    // downstream — the body, the media (with its localized alt), the article, and
    // the link previews extracted from the text — reads the resolved rendition, so
    // a reader never sees one language's text beside another language's images.
    const resolvedMap = this.buildResolvedVariantMap(postsForHydration, viewerContext);

    // Run independent hydration steps in parallel to minimize waterfall latency.
    // Dependency chain: loadRecentReplierProjection → buildUserMap → buildReplierAvatarsFromUserMap
    // Everything else is independent and can run concurrently.
    const [
      ,
      { userMap, recentReplierMap, replyParentAuthorIdByPostId, selfContinuationPostIds, signingChannelIds },
      pollMap,
      authorPrivacyMap,
      linkPreviewMap,
      orphanAuthorMap,
      quoteCountMap,
      laneMap,
    ] = await Promise.all([
      this.populateViewerInteractions(postIds, viewerContext),
      (async () => {
        // The reply-parent lookup runs BESIDE the replier projection, not after
        // it: both only need the collected graph, and both feed the SAME user
        // batch below. So resolving "whom does each reply answer" adds no Oxy
        // round trip and no latency of its own — the parent authors are merged
        // into the one `buildUserMap` call the rest of hydration already makes.
        // The channel-disclosure lookup joins them for the same reason: it is
        // one indexed settings query over the graph, it feeds the SAME user
        // batch, and its answer is what decides whether a channel's WRITER is
        // resolved at all. An undisclosed writer is never even looked up.
        const [replierAggResult, replyParents, signingIds] = await Promise.all([
          this.loadRecentReplierProjection(postIds),
          this.buildReplyParentAuthorMap(postsForHydration, viewerContext),
          this.buildSigningChannelIds(postsForHydration),
        ]);
        const extraUserIds = new Set(replierAggResult.allReplierIds);
        for (const parentAuthorId of replyParents.parentAuthorIds) {
          extraUserIds.add(parentAuthorId);
        }
        for (const writerId of this.collectDisclosedWriterIds(postsForHydration, signingIds)) {
          extraUserIds.add(writerId);
        }
        const uMap = await this.buildUserMap(postsForHydration, extraUserIds);
        const rMap = this.buildReplierAvatarsFromUserMap(replierAggResult.perPostRepliers, uMap);
        return {
          userMap: uMap,
          recentReplierMap: rMap,
          replyParentAuthorIdByPostId: replyParents.parentAuthorIdByPostId,
          selfContinuationPostIds: replyParents.selfContinuationPostIds,
          signingChannelIds: signingIds,
        };
      })(),
      this.buildPollMap(postsForHydration),
      this.buildAuthorPrivacyMap(postsForHydration, viewerContext),
      options.includeLinkMetadata !== false
        ? this.buildLinkPreviewMap(postsForHydration, resolvedMap)
        : Promise.resolve(new Map<string, PostLinkPreview[]>()),
      this.buildOrphanFederatedAuthorMap(postsForHydration),
      // `undefined` (not an empty Map) when the caller did not ask, so a post
      // with zero quotes is still reported as 0 rather than as "not counted".
      options.includeQuoteCounts === true
        ? this.buildQuoteCountMap(postIds)
        : Promise.resolve(undefined),
      this.buildLaneMap(postsForHydration),
    ]);
    const mentionCache: Map<string, PostUser> = new Map(userMap);

    const summaryMap = new Map<string, HydratedPostSummary>();

    const summaries = await Promise.all(
      postsForHydration.map(({ post }) =>
        this.buildPostSummary({
          post,
          viewerContext,
          pollMap,
          userMap,
          mentionCache,
          linkPreviewMap,
          authorPrivacyMap,
          recentReplierMap,
          orphanAuthorMap,
          resolvedMap,
          quoteCountMap,
          replyParentAuthorIdByPostId,
          selfContinuationPostIds,
          laneMap,
          signingChannelIds,
        })
      )
    );
    for (const summary of summaries) {
      if (summary) {
        summaryMap.set(summary.id, summary);
      }
    }

    const hydratedResults: HydratedPost[] = [];

    for (const { post, depth } of postsForHydration) {
      if (depth !== 0) continue;
      const postId = this.resolveId(post);
      const summary = summaryMap.get(postId);
      if (!summary) continue;

      const hydrated = this.attachNestedContext(
        post,
        summary,
        summaryMap,
        collectedPostIds,
        options.publicReferencesOnly === true,
      );
      if (hydrated) {
        hydratedResults.push(hydrated);
      }
    }

    return hydratedResults;
  }

  /**
   * Hydrate all posts across multiple slices in a single batch,
   * then reconstruct slices with hydrated data.
   * This prevents per-slice hydration overhead (N+1 at the slice level).
   */
  async hydrateSlices(
    slices: FeedPostSlice[],
    options: HydrationOptions = {}
  ): Promise<FeedPostSlice[]> {
    if (slices.length === 0) return [];

    // Collect ALL posts from ALL slices into a flat array for batch hydration
    const allRawPosts: object[] = [];
    const postIdToSlicePositions = new Map<string, Array<{ sliceIdx: number; itemIdx: number }>>();

    for (let si = 0; si < slices.length; si++) {
      for (let ii = 0; ii < slices[si].items.length; ii++) {
        const rawPost = slices[si].items[ii].post as unknown as RawPost;
        const postId = (rawPost?.id as string | undefined) || (rawPost?._id ? String(rawPost._id) : '') || '';
        if (!postId) continue;

        allRawPosts.push(rawPost);
        if (!postIdToSlicePositions.has(postId)) {
          postIdToSlicePositions.set(postId, []);
        }
        postIdToSlicePositions.get(postId)!.push({ sliceIdx: si, itemIdx: ii });
      }
    }

    // Hydrate all posts in one batch
    const hydratedPosts = await this.hydratePosts(allRawPosts, options);

    // Build lookup: postId → HydratedPost
    const hydratedMap = new Map<string, HydratedPost>();
    for (const hp of hydratedPosts) {
      hydratedMap.set(hp.id, hp);
    }

    // Reconstruct slices with hydrated data
    const result: FeedPostSlice[] = [];
    for (const slice of slices) {
      const hydratedItems: FeedSliceItem[] = [];
      for (const item of slice.items) {
        const itemPost = item.post as unknown as RawPost;
        const postId = (itemPost?.id as string | undefined) || (itemPost?._id ? String(itemPost._id) : '') || '';
        const hydrated = hydratedMap.get(postId);
        if (hydrated) {
          hydratedItems.push({
            ...item,
            post: hydrated,
          });
        }
      }

      // Only include slices that have at least one hydrated item
      if (hydratedItems.length > 0) {
        // Recalculate thread state after filtering (items may have been dropped)
        const recalculated = assignThreadState(hydratedItems);

        // Recompute slice key only if items were dropped during hydration
        const sliceKey = hydratedItems.length === slice.items.length
          ? slice._sliceKey
          : recalculated.map((i) => i.post.id).join('+');

        // The reason SURVIVES an ACL-dropped parent. It used to be stripped,
        // because it carried `parentAuthor` and would then have named the author
        // of a post this viewer was just denied — but the author now lives on the
        // reply's own `replyContext`, gated by the same ACL, so there is nothing
        // left here to leak. Stripping it was also losing the only thing the
        // reason still asserts: that this item is a reply, which the `hideReplies`
        // tuner filters on. A viewer hiding replies would have been served the
        // ones whose parent they could not read.
        result.push({
          ...slice,
          _sliceKey: sliceKey,
          items: recalculated,
        });
      }
    }

    return result;
  }

  /**
   * The viewer's ordered language preference: the request's tags first (an
   * explicit `?lang`, then `Accept-Language`), then the viewer's Oxy account
   * locales — which the feed already resolved and threads in, and which every
   * other caller reads here from the Redis-cached identity (the same batched
   * lookup hydration uses for authors, so it costs no Oxy round trip on a hit).
   * Fail-soft: an unresolvable viewer simply contributes no account locales.
   */
  private async buildLanguageCandidates(
    viewerId: string | undefined,
    options: HydrationOptions | undefined,
  ): Promise<string[]> {
    const candidates = [...(options?.requestLanguages ?? [])];

    let accountLanguages = options?.viewerLanguages;
    if (accountLanguages === undefined && viewerId) {
      try {
        const summaries = await resolveUserSummaries([viewerId]);
        accountLanguages = summaries.get(viewerId)?.languages ?? [];
      } catch (error) {
        logger.warn('[PostHydration] Failed to resolve viewer languages', error);
        accountLanguages = [];
      }
    }

    for (const tag of accountLanguages ?? []) {
      if (!candidates.includes(tag)) {
        candidates.push(tag);
      }
    }

    return candidates;
  }

  private async buildViewerContext(posts: object[], viewerId?: string, options?: HydrationOptions): Promise<ExtendedViewerContext> {
    const context: ExtendedViewerContext = {
      viewerId,
      languageCandidates: await this.buildLanguageCandidates(viewerId, options),
      privacyPreferences: { ...DEFAULT_PRIVACY },
      blockedIds: new Set<string>(),
      restrictedIds: new Set<string>(),
      follows: new Set<string>(),
      followedBy: new Set<string>(),
      likedPosts: new Set<string>(),
      downvotedPosts: new Set<string>(),
      savedPosts: new Set<string>(),
      boostedPosts: new Set<string>(),
      privateProfileIds: new Set<string>(),
      includeFullArticleBody: options?.includeFullArticleBody ?? true,
      includeFullMetadata: options?.includeFullMetadata ?? true,
    };

    // Collect unique author IDs for profile visibility check
    const authorIds = Array.from(
      new Set(posts.map((p) => (p as RawPost)?.oxyUserId).filter(Boolean).map((id) => String(id))),
    );

    // Load ALL author settings in one query (profile visibility + engagement privacy)
    // This avoids a separate query in buildAuthorPrivacyMap
    if (authorIds.length > 0) {
      try {
        const allAuthorSettings = await UserSettings.find({
          oxyUserId: { $in: authorIds },
        }).lean();

        // Pre-populate author privacy map for reuse in buildAuthorPrivacyMap
        const authorPrivacyCache = new Map<string, typeof DEFAULT_PRIVACY>();
        for (const s of allAuthorSettings) {
          const authorId = String(s.oxyUserId);

          // Track private profiles
          const vis = s.privacy?.profileVisibility;
          if (vis === 'private' || vis === 'followers_only') {
            context.privateProfileIds.add(authorId);
          }

          // Cache engagement privacy for buildAuthorPrivacyMap
          authorPrivacyCache.set(authorId, readEngagementCountPrivacy(s.privacy));
        }

        // Set defaults for authors without settings
        for (const authorId of authorIds) {
          if (!authorPrivacyCache.has(authorId)) {
            authorPrivacyCache.set(authorId, { ...DEFAULT_PRIVACY });
          }
        }

        context._authorPrivacyCache = authorPrivacyCache;
      } catch (error) {
        logger.warn('[PostHydration] Failed to load author settings:', error);
      }
    }

    if (!viewerId) {
      return context;
    }

    const client = options?.oxyClient;

    const [blockedIds, restrictedIds] = await Promise.all([
      getBlockedUserIds(client),
      getRestrictedUserIds(client),
    ]);

    blockedIds.forEach((id) => context.blockedIds.add(String(id)));
    restrictedIds.forEach((id) => context.restrictedIds.add(String(id)));

    try {
      const settings = await UserSettings.findOne({ oxyUserId: viewerId }).lean();
      if (settings?.privacy) {
        context.privacyPreferences = readEngagementCountPrivacy(settings.privacy);
      }
    } catch (error) {
      logger.warn('[PostHydration] Failed to load viewer privacy settings:', error);
    }

    const threadedGraph = options?.viewerGraph;
    if (threadedGraph) {
      // Feed path: the viewer graph was already resolved ONCE by
      // `loadViewerFeedContext` (in parallel with the rest of the context) and
      // threaded here — do NOT re-fetch it from Oxy. This is the deduplication
      // that guarantees getUserFollowing/getUserFollowers hit Oxy at most once per
      // feed request.
      threadedGraph.followingIds.forEach((id) => context.follows.add(String(id)));
      threadedGraph.followerIds.forEach((id) => context.followedBy.add(String(id)));
    } else {
      // Non-feed callers (post detail, notifications, profile, search) do not
      // pre-resolve the graph — fall back to the live Oxy fetch (unchanged).
      try {
        const oxyForFollows = client || getRuntimeOxyClient();
        const [followingResponse, followersResponse] = await Promise.all([
          oxyForFollows.getUserFollowing(viewerId).catch((error: unknown) => {
            logger.warn('[PostHydration] getUserFollowing failed:', error);
            return [];
          }),
          oxyForFollows.getUserFollowers(viewerId).catch((error: unknown) => {
            logger.warn('[PostHydration] getUserFollowers failed:', error);
            return [];
          }),
        ]);

        extractFollowingIds(followingResponse).forEach((id) => context.follows.add(String(id)));
        extractFollowersIds(followersResponse).forEach((id) => context.followedBy.add(String(id)));
      } catch (error) {
        logger.warn('[PostHydration] Failed to load follower/following context:', error);
      }
    }

    return context;
  }

  // A boost-of-boost chain (Announce of an Announce) is collected one extra hop
  // beyond `maxDepth` per the forced-boost-original rule below, but is then
  // capped so a pathological chain cannot fan out unbounded. Two levels is
  // enough to render a boost of a boost (its own original embeds); deeper
  // chains keep their nested original empty rather than over-fetching.
  private static readonly MAX_FORCED_BOOST_DEPTH = 2;

  private async collectPostsWithDepth(
    initialPosts: RawPost[],
    maxDepth: number,
    blockedIds: Set<string>,
    publicReferencesOnly: boolean,
  ): Promise<Map<string, HydratedGraphNode>> {
    const result = new Map<string, HydratedGraphNode>();
    const visited = new Set<string>();

    let currentLevel = initialPosts.map((post): HydratedGraphNode => ({ post, depth: 0 }));

    // The collection runs at least one level beyond `maxDepth` so a boost's
    // mandatory original (forced below, regardless of `maxDepth`) is always
    // fetched. The per-entry guards still respect `maxDepth` for OPTIONAL
    // references, so this added iteration only ever fetches forced boost
    // originals — never expands the normal depth budget.
    const collectionDepthCap = Math.max(maxDepth, PostHydrationService.MAX_FORCED_BOOST_DEPTH);

    for (let depth = 0; depth <= collectionDepthCap && currentLevel.length > 0; depth++) {
      const nextIdMap = new Map<string, number>();

      for (const entry of currentLevel) {
        const id = this.resolveId(entry.post);
        if (!id || visited.has(id)) continue;
        visited.add(id);

        const authorId = entry.post?.oxyUserId ? String(entry.post.oxyUserId) : undefined;
        if (authorId && blockedIds.has(authorId)) {
          continue;
        }

        result.set(id, { post: entry.post, depth: entry.depth });

        const enqueueRef = (refId: string) => {
          if (!refId || visited.has(refId)) return;
          const nextDepth = entry.depth + 1;
          const existing = nextIdMap.get(refId);
          nextIdMap.set(refId, existing === undefined ? nextDepth : Math.min(existing, nextDepth));
        };

        // A `type:'boost'` post has an intentionally EMPTY content body and is
        // NOT renderable without its boosted original — the original is part of
        // the boost's own content, not optional nested context. So ALWAYS
        // collect a boost's direct `boostOf` original one hop deep, independent
        // of the caller's `maxDepth`. Without this, any endpoint that hydrates
        // boosts at `maxDepth: 0` (most feed paths) silently returns a blank
        // boost. Bounded by `collectionDepthCap` so a boost-of-boost chain
        // cannot fan out indefinitely.
        if (entry.depth < collectionDepthCap) {
          const forcedOriginalId = this.extractBoostOriginalId(entry.post);
          if (forcedOriginalId) {
            enqueueRef(forcedOriginalId);
          }
        }

        // OPTIONAL references (quote, legacy originalPostId) still respect the
        // caller's `maxDepth` budget — they are nested context, not mandatory
        // content, so a `maxDepth: 0` caller intentionally omits them.
        if (entry.depth < maxDepth) {
          for (const refId of this.extractReferenceIds(entry.post)) {
            enqueueRef(refId);
          }
        }
      }

      if (nextIdMap.size === 0) {
        break;
      }

      const nextIds = Array.from(nextIdMap.keys());
      const referenceQuery: Record<string, unknown> = { _id: { $in: nextIds } };
      if (publicReferencesOnly) {
        referenceQuery.status = 'published';
        referenceQuery.visibility = PostVisibility.PUBLIC;
      }

      try {
        const fetched = await Post.find(referenceQuery)
          .select('-metadata.likedBy -metadata.savedBy')
          .lean();

        currentLevel = fetched.map((post) => ({
          post: post as unknown as RawPost,
          depth: nextIdMap.get(this.resolveId(post as unknown as RawPost)!) ?? depth + 1,
        }));
      } catch (error) {
        logger.error('[PostHydration] Failed to fetch referenced posts:', error);
        break;
      }
    }

    return result;
  }

  /**
   * Resolve a boost's DIRECT original post id (`boostOf`), if any. Unlike
   * {@link extractReferenceIds} this returns only the mandatory boost original
   * (never the optional quote/originalPostId references), so the forced
   * collection in {@link collectPostsWithDepth} pulls exactly the one post a
   * boost cannot render without.
   */
  private extractBoostOriginalId(post: RawPost): string | undefined {
    const value = post?.boostOf;
    if (!value) return undefined;
    if (typeof value === 'string') return value || undefined;
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const refId = obj._id ?? obj.id ?? obj.postId;
      if (refId) return String(refId);
    }
    return undefined;
  }

  private extractReferenceIds(post: RawPost): string[] {
    const ids: string[] = [];
    const maybePush = (value: unknown) => {
      if (!value) return;
      if (typeof value === 'string') {
        ids.push(value);
        return;
      }
      if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const refId = obj._id ?? obj.id ?? obj.postId;
        if (refId) {
          ids.push(String(refId));
        }
      }
    };

    maybePush(post.boostOf);
    maybePush(post.quoteOf);
    if (post.originalPostId) {
      maybePush(post.originalPostId);
    }
    return ids.filter(Boolean);
  }

  private resolveId(post: RawPost): string {
    if (!post) return '';
    if (typeof post.id === 'string') return post.id;
    if (post._id) return String(post._id);
    return '';
  }

  private async populateViewerInteractions(postIds: string[], viewerContext: ViewerContext): Promise<void> {
    const viewerId = viewerContext.viewerId;
    if (!viewerId || postIds.length === 0) {
      return;
    }

    try {
      const [likes, bookmarks, boosts] = await Promise.all([
        Like.find({ userId: viewerId, postId: { $in: postIds } }).select('postId value').lean(),
        Bookmark.find({ userId: viewerId, postId: { $in: postIds } }).select('postId').lean(),
        Post.find({ oxyUserId: viewerId, boostOf: { $in: postIds } }).select('boostOf').lean(),
      ]);

      likes.forEach((like) => {
        const id = like?.postId ? String(like.postId) : undefined;
        if (!id) return;
        const value = like.value ?? 1;
        if (value === 1) {
          viewerContext.likedPosts.add(id);
        } else {
          viewerContext.downvotedPosts.add(id);
        }
      });

      bookmarks.forEach((bookmark) => {
        const id = bookmark?.postId ? String(bookmark.postId) : undefined;
        if (id) viewerContext.savedPosts.add(id);
      });

      boosts.forEach((boost) => {
        const id = boost?.boostOf ? String(boost.boostOf) : undefined;
        if (id) viewerContext.boostedPosts.add(id);
      });
    } catch (error) {
      logger.error('[PostHydration] Failed to populate viewer interactions:', error);
    }
  }

  private async buildPollMap(nodes: HydratedGraphNode[]): Promise<Map<string, Record<string, unknown>>> {
    const pollIds = Array.from(
      new Set(
        nodes
          .map(({ post }) => post?.content?.pollId)
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    );

    if (pollIds.length === 0) {
      return new Map();
    }

    try {
      const polls = await Poll.find({ _id: { $in: pollIds } }).lean();
      const map = new Map<string, Record<string, unknown>>();

      polls.forEach((poll) => {
        const id = poll?._id ? String(poll._id) : undefined;
        if (!id) return;

        map.set(id, {
          question: poll.question,
          options: poll.options.map((opt) => opt.text),
          endTime: poll.endsAt?.toISOString?.() ?? poll.endsAt ?? new Date().toISOString(),
          votes: poll.options.reduce((acc: Record<string, number>, opt, index) => {
            acc[String(index)] = Array.isArray(opt.votes) ? opt.votes.length : 0;
            return acc;
          }, {}),
          userVotes: poll.options.reduce((acc: Record<string, string>, opt, index) => {
            if (Array.isArray(opt.votes)) {
              opt.votes.forEach((userId) => {
                if (userId) {
                  acc[String(userId)] = String(index);
                }
              });
            }
            return acc;
          }, {}),
        });
      });

      return map;
    } catch (error) {
      logger.error('[PostHydration] Failed to build poll map:', error);
      return new Map();
    }
  }

  /**
   * The lanes of every post in the graph, in ONE indexed query keyed by lane id.
   *
   * Emitting it on the summary is what propagates it to `originalPost` /
   * `quotedPost` / `boost.originalPost` for free: those are the SAME objects out
   * of `summaryMap`, so a quoted post shows its own lane without a second pass.
   *
   * `displayMode` travels with the name because it is what the chip's own menu
   * needs (an owner looking at their own post can see, and change, whether that
   * lane shows on the profile) — it is public curation state, not a permission.
   *
   * Fail-soft: a lookup failure yields an empty map, so the post renders without
   * a chip rather than not rendering at all.
   */
  private async buildLaneMap(nodes: HydratedGraphNode[]): Promise<Map<string, LaneSummary>> {
    const laneIds = Array.from(
      new Set(
        nodes
          .map(({ post }) => post?.laneId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    if (laneIds.length === 0) {
      return new Map();
    }

    try {
      const lanes = await Lane.find({ _id: { $in: laneIds } })
        .select('name displayMode')
        .lean<Array<{ _id: unknown; name: string; displayMode: LaneDisplayMode }>>();

      const map = new Map<string, LaneSummary>();
      for (const lane of lanes) {
        const id = lane?._id ? String(lane._id) : undefined;
        if (!id) continue;
        map.set(id, { id, name: lane.name, displayMode: lane.displayMode });
      }
      return map;
    } catch (error) {
      logger.error('[PostHydration] Failed to build lane map:', error);
      return new Map();
    }
  }

  /**
   * The channel accounts in this page that DISCLOSE their writers.
   *
   * Only posts that actually carry a `writtenByOxyUserId` contribute a
   * candidate, so an ordinary page of posts asks about nothing and
   * {@link loadSigningChannelIds} skips its query entirely.
   *
   * The decision itself — including the fail-closed reading of
   * `channel.signPosts` — belongs to `services/channelWriterDisclosure`, which
   * the channel's writers list reads too. Hydration collects the candidates; it
   * does not decide.
   */
  private async buildSigningChannelIds(nodes: HydratedGraphNode[]): Promise<Set<string>> {
    const candidateAuthorIds = new Set<string>();
    for (const { post } of nodes) {
      if (typeof post?.writtenByOxyUserId !== 'string' || post.writtenByOxyUserId.length === 0) {
        continue;
      }
      const authorId = post.oxyUserId ? String(post.oxyUserId) : '';
      if (authorId) candidateAuthorIds.add(authorId);
    }

    return loadSigningChannelIds(candidateAuthorIds);
  }

  /**
   * The writer ids this page will actually DISCLOSE — merged into the single
   * `buildUserMap` batch so a disclosed writer resolves through the ordinary
   * identity path, exactly like any other author.
   *
   * Gated on the settings answer rather than on the column, so an undisclosed
   * writer is not resolved, not cached, and cannot reach a DTO by accident. The
   * remaining condition — that the author really is a `channel` account — is
   * checked at byline time, where the resolved `user.kind` is known.
   */
  private collectDisclosedWriterIds(
    nodes: HydratedGraphNode[],
    signingChannelIds: Set<string>,
  ): Set<string> {
    const writerIds = new Set<string>();
    if (signingChannelIds.size === 0) return writerIds;

    for (const { post } of nodes) {
      const writerId = typeof post?.writtenByOxyUserId === 'string' ? post.writtenByOxyUserId : '';
      const authorId = post?.oxyUserId ? String(post.oxyUserId) : '';
      if (writerId && authorId && signingChannelIds.has(authorId)) {
        writerIds.add(writerId);
      }
    }
    return writerIds;
  }

  private async buildUserMap(
    nodes: HydratedGraphNode[],
    extraLocalUserIds?: Set<string>,
  ): Promise<Map<string, PostUser>> {
    const userIds = new Set<string>();

    for (const { post } of nodes) {
      for (const userId of collectAuthorshipUserIds(post?.authorship)) {
        userIds.add(userId);
      }
    }

    // Merge in extra user IDs (e.g., replier IDs) for batch fetching
    if (extraLocalUserIds) {
      for (const id of extraLocalUserIds) {
        userIds.add(id);
      }
    }

    // `resolveUserSummaries` returns raw Oxy users (Oxy owns identity) and
    // already enriches any degraded FEDERATED author from the FederatedActor
    // record — no separate repair step here.
    const resolved = await resolveUserSummaries([...userIds]);

    const userMap = new Map<string, PostUser>();
    for (const [userId, value] of resolved) {
      userMap.set(userId, value.user);
    }

    return userMap;
  }

  /**
   * Resolve a degraded author (keyed by post id) for every FEDERATED post in the
   * graph whose Oxy author link is missing — a legacy orphan. Native null-author
   * posts are intentionally skipped: they carry no `federation` data and are a
   * genuine data error that {@link buildPostSummary} drops. See
   * {@link resolveOrphanFederatedAuthors} for the derivation.
   */
  private async buildOrphanFederatedAuthorMap(
    nodes: HydratedGraphNode[],
  ): Promise<Map<string, PostUser>> {
    const orphans: Array<{ postId: string; federation: PostFederationData }> = [];
    for (const { post } of nodes) {
      if (post?.oxyUserId || !post?.federation) continue;
      const postId = this.resolveId(post);
      if (!postId) continue;
      orphans.push({ postId, federation: post.federation });
    }
    return resolveOrphanFederatedAuthors(orphans);
  }

  /**
   * Resolve, for every post in the graph, the ONE localized rendition this viewer
   * is served — walking the ladder (explicit `?lang` → `Accept-Language` → the
   * viewer's Oxy account locales → the post's primary) and applying variant
   * inheritance. Pure and synchronous: {@link resolveViewerTag} and
   * {@link resolveVariant} read only the post's own content.
   */
  private buildResolvedVariantMap(
    nodes: HydratedGraphNode[],
    viewerContext: ViewerContext,
  ): Map<string, ResolvedVariant> {
    const resolvedMap = new Map<string, ResolvedVariant>();
    for (const { post } of nodes) {
      const postId = this.resolveId(post);
      if (!postId) continue;
      const content: StoredPostContent = post?.content ?? {};
      const tag = resolveViewerTag(viewerContext.languageCandidates, content);
      resolvedMap.set(postId, resolveVariant(content, tag));
    }
    return resolvedMap;
  }

  /**
   * Build the per-post link-preview map for a batch of posts. Each post maps to
   * its resolved previews IN TEXT ORDER, capped at `MAX_POST_LINK_PREVIEWS` by
   * {@link extractUrls} — a post with several links renders a card per link. The
   * URLs are read from the RESOLVED body, so a reader served the Spanish variant
   * gets the cards for the links that variant actually contains.
   *
   * Link previews are resolved through the Oxy ecosystem link-preview service
   * ({@link OxyServices.getLinkPreviews}) instead of being scraped locally. Oxy
   * owns BOTH resolution and privacy-preserving image hosting: the `image` /
   * `favicon` on every returned preview is an absolute Oxy-hosted
   * (`cloud.oxy.so`) URL — never re-proxied via `/media/proxy`, but sized down
   * via {@link attachCdnVariant} (the `MEDIA_VARIANT_THUMB`/`w320` context,
   * matching the link-preview card's rendered width) instead of serving the
   * no-variant original for what renders as a small card cover image.
   *
   * This stays safe on the `/feed/*` response path: the batch call is a fast
   * cached read (mirroring the {@link OxyServices.getUsersByIds} author-batch
   * call also awaited here) over the DEDUPED url set, so posts sharing a URL
   * cost one resolution. Oxy returns already-resolved previews immediately and a
   * `'pending'` placeholder for any first-seen URL, which it warms server-side in
   * the background — it does NOT block on a remote HTML fetch. A
   * `'pending'`/`'empty'` result is skipped (the remaining resolved previews keep
   * their relative text order), so a brand-new URL shows no card on its first
   * render and gains one on a later render once Oxy has resolved it. Only
   * top-level posts carry previewable text; nested boosts/quotes have no preview
   * of their own.
   *
   * A URL naming a profile on THIS instance gets no card ({@link isOwnProfileLink}),
   * because the reader is not shown a link there: the linkifier renders that span
   * as a mention, and a card underneath would preview a page the reader can no
   * longer see a link to. It is dropped before the batch call rather than after,
   * so we also stop asking the preview service to scrape our own profile pages.
   * The suppression is per URL, not per post — a post carrying a profile link AND
   * an article still gets the article's card.
   *
   * One bounded consequence, stated rather than hidden: {@link extractUrls}
   * applies the `MAX_POST_LINK_PREVIEWS` cap BEFORE this filter, so a post
   * carrying more than that many links, one of which is a profile link, renders
   * one card fewer instead of promoting the next link into the freed slot. Moving
   * the filter ahead of the cap would mean teaching a generally-named URL
   * extractor about profile links, which is a worse trade for a case that needs
   * five links in one body to reach.
   */
  private async buildLinkPreviewMap(
    nodes: HydratedGraphNode[],
    resolvedMap: Map<string, ResolvedVariant>,
  ): Promise<Map<string, PostLinkPreview[]>> {
    const previewMap = new Map<string, PostLinkPreview[]>();

    const postToUrls = new Map<string, string[]>(); // postId -> [url] (text order)
    const urlToPosts = new Map<string, string[]>(); // url -> [postId] (dedupes the batch call)

    for (const { post } of nodes) {
      const postId = this.resolveId(post);
      if (!postId) continue;

      const text = resolvedMap.get(postId)?.text;
      if (!text || typeof text !== 'string') continue;

      const urls = extractUrls(text).filter((url) => !isOwnProfileLink(url));
      if (urls.length === 0) continue;

      postToUrls.set(postId, urls);

      for (const url of urls) {
        const posts = urlToPosts.get(url);
        if (posts) {
          posts.push(postId);
        } else {
          urlToPosts.set(url, [postId]);
        }
      }
    }

    const uniqueUrls = Array.from(urlToPosts.keys());
    if (uniqueUrls.length === 0) return previewMap;

    let previews: Record<string, LinkPreview>;
    try {
      previews = await getServiceOxyClient().getLinkPreviews(uniqueUrls);
    } catch (error) {
      // Best-effort: a preview-service hiccup must never fail feed hydration.
      logger.warn('[PostHydration] Failed to resolve link previews from Oxy', {
        count: uniqueUrls.length,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return previewMap;
    }

    const resolvedByUrl = new Map<string, PostLinkPreview>();
    for (const url of uniqueUrls) {
      const preview = previews[url];
      // Only fully-resolved previews are rendered; `'pending'`/`'empty'` are
      // omitted so the URL re-resolves into a real preview on a later render.
      if (!preview || preview.status !== 'resolved') continue;

      resolvedByUrl.set(url, {
        url: preview.url,
        title: preview.title || undefined,
        description: preview.description || undefined,
        // Already an absolute Oxy-hosted `cloud.oxy.so` URL — attach the
        // thumb-context variant instead of serving the no-variant original.
        image: preview.image ? attachCdnVariant(preview.image, MEDIA_VARIANT_THUMB) : undefined,
        siteName: preview.siteName || undefined,
      });
    }

    for (const [postId, urls] of postToUrls) {
      const resolved: PostLinkPreview[] = [];
      for (const url of urls) {
        const preview = resolvedByUrl.get(url);
        if (preview) resolved.push(preview);
      }
      if (resolved.length > 0) previewMap.set(postId, resolved);
    }

    return previewMap;
  }

  private async buildAuthorPrivacyMap(
    nodes: HydratedGraphNode[],
    viewerContext?: ViewerContext,
  ): Promise<Map<string, typeof DEFAULT_PRIVACY>> {
    // Use pre-fetched cache from buildViewerContext if available
    const cached = (viewerContext as ExtendedViewerContext)?._authorPrivacyCache;
    if (cached && cached.size > 0) {
      // Ensure all authors in current nodes are covered (some may be from depth>0 fetches)
      const authorIds = Array.from(
        new Set(nodes.map(({ post }) => post?.oxyUserId).filter(Boolean).map((id) => String(id))),
      );
      const missingIds = authorIds.filter((id) => !cached.has(id));
      if (missingIds.length === 0) {
        return cached;
      }

      // Fetch only missing authors
      try {
        const settings = await UserSettings.find({ oxyUserId: { $in: missingIds } }).lean();
        for (const setting of settings) {
          cached.set(String(setting.oxyUserId), readEngagementCountPrivacy(setting.privacy));
        }
        for (const id of missingIds) {
          if (!cached.has(id)) cached.set(id, { ...DEFAULT_PRIVACY });
        }
      } catch (error) {
        logger.warn('[PostHydration] Failed to load missing author privacy settings:', error);
        for (const id of missingIds) cached.set(id, { ...DEFAULT_PRIVACY });
      }
      return cached;
    }

    // Fallback: no cache available, fetch all
    const authorIds = Array.from(
      new Set(nodes.map(({ post }) => post?.oxyUserId).filter(Boolean).map((id) => String(id))),
    );

    const privacyMap = new Map<string, typeof DEFAULT_PRIVACY>();
    if (authorIds.length === 0) {
      return privacyMap;
    }

    try {
      const settings = await UserSettings.find({ oxyUserId: { $in: authorIds } }).lean();
      settings.forEach((setting) => {
        privacyMap.set(String(setting.oxyUserId), readEngagementCountPrivacy(setting.privacy));
      });

      authorIds.forEach((authorId) => {
        if (!privacyMap.has(authorId)) {
          privacyMap.set(authorId, { ...DEFAULT_PRIVACY });
        }
      });
    } catch (error) {
      logger.warn('[PostHydration] Failed to load author privacy settings:', error);
      authorIds.forEach((authorId) => {
        privacyMap.set(authorId, { ...DEFAULT_PRIVACY });
      });
    }

    return privacyMap;
  }

  /**
   * Phase 1: Read bounded replier user IDs without fetching their profiles.
   * Returns both per-post replier arrays and a flat set of all IDs.
   */
  private async loadRecentReplierProjection(postIds: string[]): Promise<{
    perPostRepliers: Map<string, string[]>;
    allReplierIds: Set<string>;
  }> {
    const perPostRepliers = new Map<string, string[]>();
    const allReplierIds = new Set<string>();

    if (postIds.length === 0) return { perPostRepliers, allReplierIds };

    try {
      return await loadRecentReplierIds(postIds);
    } catch (error) {
      logger.warn('[PostHydration] Failed to load recent replier IDs:', error);
    }

    return { perPostRepliers, allReplierIds };
  }

  /**
   * May this viewer read the post with this id?
   *
   * The same question {@link canViewerReadPost} answers, asked by a caller that
   * holds an id rather than a hydrated graph — today the `joinPost` socket
   * handler, deciding whether a client may subscribe to a post's live counters.
   *
   * It is a real read of the real gate, not a cheaper approximation: the post is
   * fetched with the ACL's own projection, the viewer context is built by the
   * same builder hydration uses, and the verdict comes from the same predicate.
   * A "is it public?" shortcut written at the call site would be a second
   * visibility rule, and the two would drift the first time either moved.
   *
   * A blocked author fails here too, matching hydration — which drops a blocked
   * author's post while COLLECTING it, before the gate below ever sees it, so
   * asking the gate alone would let through the one case hydration never serves.
   *
   * Costs one indexed `_id` lookup plus the viewer context (the viewer's
   * blocks/restrictions/graph) — the same work one post-detail request already
   * does. Callers must therefore bound how often they can ask.
   */
  async canViewerReadPostId(
    postId: string,
    viewerId: string,
    options?: Pick<HydrationOptions, 'oxyClient'>,
  ): Promise<boolean> {
    // The id reaches this seam straight from a client. `findById` CASTS, so a
    // non-id string would throw rather than answer, and "no such post" is the
    // honest answer to a string that could never name one.
    if (!isValidObjectId(postId)) return false;

    const post = await Post.findById(postId)
      .select(REPLY_PARENT_PROJECTION)
      .lean<RawPost | null>();
    if (!post) return false;

    const isFederatedPost = !!post.federation;
    const authorId = post.oxyUserId ? String(post.oxyUserId) : undefined;
    // A native post with no author is a data error hydration refuses to render;
    // a federated orphan is public by definition and keeps the federated path.
    if (!authorId) return isFederatedPost;

    const viewerContext = await this.buildViewerContext([post], viewerId, options);
    if (viewerContext.blockedIds.has(authorId)) return false;

    return this.canViewerReadPost(
      post,
      authorId,
      normalizeAuthorship(post.authorship as PostAuthorshipEntry[] | undefined),
      viewerContext,
    );
  }

  /**
   * May this viewer read this post at all?
   *
   * The single post-level ACL, applied to LOCAL and FEDERATED posts alike.
   * `mapApVisibility` turns a Note that is not publicly addressed into
   * `followers_only`, so a federated post is NOT public by definition and a
   * blanket bypass here served a remote author's private post to anybody who
   * asked for it by id. Hydration is used for globally-broadcast DTOs and for
   * nested quote/boost references fetched by id, so the gate lives here rather
   * than relying on every caller to pre-filter.
   *
   * Extracted from {@link buildPostSummary} (whose behaviour is unchanged) so
   * that {@link buildReplyParentAuthorMap} can ask the identical question about a
   * reply's PARENT. A reply's "Replying to @…" header names the parent's author,
   * which must not reveal the author — or the existence — of a post this viewer
   * would be refused. Answering that with a second, hand-rolled visibility check
   * is exactly how the two would drift apart; there is one gate and both call it.
   */
  private canViewerReadPost(
    post: RawPost,
    authorId: string,
    authorship: PostAuthorshipEntry[],
    viewerContext: ViewerContext,
  ): boolean {
    const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
    // Pending collaborators may PREVIEW the post they were invited to (so the
    // collab-invite UI can render the actual content before they accept),
    // alongside the owner and accepted collaborators. All three bypass the
    // unpublished/private/followers-only/restricted ACL checks below.
    const viewerOwnsPost =
      viewerContext.viewerId === authorId ||
      (viewerEntry?.role === 'collaborator' &&
        (viewerEntry.status === 'accepted' || viewerEntry.status === 'pending'));

    if ((post.status ?? 'published') !== 'published' && !viewerOwnsPost) {
      return false;
    }

    const visibility = (post.visibility ?? PostVisibility.PUBLIC) as PostVisibility;
    if (visibility === PostVisibility.PRIVATE && !viewerOwnsPost) {
      return false;
    }

    if (visibility === PostVisibility.FOLLOWERS_ONLY && !viewerOwnsPost) {
      if (!viewerContext.viewerId || !viewerContext.follows.has(authorId)) {
        return false;
      }
    }

    if (viewerContext.restrictedIds.has(authorId) && !viewerOwnsPost) {
      return false;
    }

    // Filter posts from private/followers_only profiles. Own posts are always
    // visible; public profiles pass through.
    if (viewerContext.privateProfileIds.has(authorId) && !viewerOwnsPost) {
      if (!viewerContext.viewerId || !viewerContext.follows.has(authorId)) {
        return false;
      }
    }

    return true;
  }

  /**
   * For every post in the graph that IS a reply, the Oxy id of the author it
   * answers — when we hold that parent AND this viewer may read it.
   *
   * This is what makes reply context a property of the POST rather than of the
   * feed slice that happens to carry it. Every surface hydrates, so every surface
   * gets it: the feeds whose definition never opted into reply-context slicing,
   * the paths that emit no slices at all (the popular fallback, ordered feeds),
   * and the non-feed screens (search, saved, insights, the thread view) that
   * render a bare `HydratedPost`.
   *
   * Costs nothing when the page holds no replies — the common case for a
   * discovery lane — and at most ONE extra indexed `_id` lookup otherwise. The
   * authors themselves are NOT resolved here: their ids are merged into the
   * single {@link buildUserMap} batch the rest of hydration already runs, so a
   * parent author who is also a post author on the page costs no second fetch and
   * no second Oxy round trip.
   *
   * Membership of the returned map is the ACL decision. A parent that is absent,
   * unpublished, private, followers-only to a non-follower, restricted, or behind
   * a private profile yields NO entry, so the reply still reports itself as a
   * reply but names nobody — never a header naming the author of a post this
   * viewer was refused.
   *
   * `selfContinuationPostIds` is the SELF-THREAD decision, made here rather than
   * in the renderer for two reasons. It is the only place that holds both
   * authoritative author ids (`post.oxyUserId` and the parent's), and the DTO's
   * `user.id` is NOT a safe substitute: an orphan federated post carries a
   * degraded author summary whose `id` is the POST id (see `degradedActorSummary`
   * in `buildPostSummary`), so a renderer-side comparison would silently never
   * match for exactly those posts.
   */
  private async buildReplyParentAuthorMap(
    nodes: HydratedGraphNode[],
    viewerContext: ViewerContext,
  ): Promise<{
    parentAuthorIdByPostId: Map<string, string>;
    parentAuthorIds: Set<string>;
    selfContinuationPostIds: Set<string>;
  }> {
    const parentAuthorIdByPostId = new Map<string, string>();
    const parentAuthorIds = new Set<string>();
    const selfContinuationPostIds = new Set<string>();

    // `isReplyPost` is the ONE definition of the concept (see utils/postReply):
    // it counts a federated reply whose `inReplyTo` never resolved into a local
    // `parentPostId`. Such a reply has no parent to name but is still a reply,
    // and `buildPostSummary` emits its marker off the same predicate.
    const parentIdByPostId = new Map<string, string>();
    const replyAuthorIdByPostId = new Map<string, string>();
    for (const { post } of nodes) {
      if (!post || !isReplyPost(post)) continue;
      const postId = this.resolveId(post);
      const parentId = post.parentPostId ? String(post.parentPostId) : '';
      if (postId && parentId) {
        parentIdByPostId.set(postId, parentId);
        // The raw `oxyUserId`, not the DTO's `user.id` — see the note above.
        replyAuthorIdByPostId.set(postId, post.oxyUserId ? String(post.oxyUserId) : '');
      }
    }

    if (parentIdByPostId.size === 0) {
      return { parentAuthorIdByPostId, parentAuthorIds, selfContinuationPostIds };
    }

    // Parents already collected into the graph (a reply-context slice prepends
    // its parent, and a thread's own posts sit beside each other) are reused
    // rather than re-fetched.
    const knownById = new Map<string, RawPost>();
    for (const { post } of nodes) {
      const id = this.resolveId(post);
      if (id) knownById.set(id, post);
    }

    const missingIds = [...new Set(parentIdByPostId.values())].filter((id) => !knownById.has(id));
    if (missingIds.length > 0) {
      try {
        const parents = await Post.find({ _id: { $in: missingIds } })
          .select(REPLY_PARENT_PROJECTION)
          .lean();
        for (const parent of parents) {
          const parentPost = parent as unknown as RawPost;
          const id = this.resolveId(parentPost);
          if (id) knownById.set(id, parentPost);
        }
      } catch (error) {
        // Soft-fail: replies still report themselves as replies, just unnamed.
        logger.warn('[PostHydration] Failed to load reply parents:', error);
      }
    }

    for (const [postId, parentId] of parentIdByPostId) {
      const parent = knownById.get(parentId);
      if (!parent) continue;

      const parentAuthorId = parent.oxyUserId ? String(parent.oxyUserId) : '';
      // An orphan federated parent carries no Oxy author link, so there is
      // nobody to name — the reply keeps its marker and drops the handle.
      if (!parentAuthorId) continue;

      // A reply to one's OWN post is a self-thread continuation, which every
      // client renders as a thread (connector line + "Show this thread"), never
      // as a reply header — "Replying to @themselves" on every post after the
      // first is noise, and self-threads are a very common shape. Classified
      // here, where both ids are authoritative; `buildPostSummary` then omits
      // `replyContext` for these posts entirely, so the renderer needs no rule
      // and cannot mistake a self-continuation for an unnamed reply.
      const replyAuthorId = replyAuthorIdByPostId.get(postId);
      if (replyAuthorId && replyAuthorId === parentAuthorId) {
        selfContinuationPostIds.add(postId);
        continue;
      }

      const readable = this.canViewerReadPost(
        parent,
        parentAuthorId,
        normalizeAuthorship(parent.authorship as PostAuthorshipEntry[] | undefined),
        viewerContext,
      );
      if (!readable) continue;

      parentAuthorIdByPostId.set(postId, parentAuthorId);
      parentAuthorIds.add(parentAuthorId);
    }

    return { parentAuthorIdByPostId, parentAuthorIds, selfContinuationPostIds };
  }

  /**
   * Phase 2: Build replier avatar map using the already-populated userMap.
   * No additional user profile fetches needed.
   */
  private buildReplierAvatarsFromUserMap(
    perPostRepliers: Map<string, string[]>,
    userMap: Map<string, PostUser>,
  ): Map<string, string[]> {
    const replierMap = new Map<string, string[]>();

    for (const [parentId, replierIds] of perPostRepliers) {
      const avatars: string[] = [];
      for (const replierId of replierIds) {
        const user = userMap.get(replierId);
        // Bare Oxy file id (or mirrored URL) — the client resolves it through
        // Bloom's ImageResolver, same as every other avatar.
        if (user?.avatar) {
          avatars.push(user.avatar);
        }
      }
      if (avatars.length > 0) {
        replierMap.set(parentId, avatars);
      }
    }

    return replierMap;
  }

  private async buildPostSummary(params: {
    post: RawPost;
    viewerContext: ViewerContext;
    pollMap: Map<string, Record<string, unknown>>;
    userMap: Map<string, PostUser>;
    mentionCache: Map<string, PostUser>;
    linkPreviewMap: Map<string, PostLinkPreview[]>;
    authorPrivacyMap: Map<string, typeof DEFAULT_PRIVACY>;
    recentReplierMap?: Map<string, string[]>;
    orphanAuthorMap: Map<string, PostUser>;
    resolvedMap: Map<string, ResolvedVariant>;
    /** Undefined unless the caller passed `includeQuoteCounts` — see {@link HydrationOptions}. */
    quoteCountMap: Map<string, number> | undefined;
    /** Reply post id → its parent's author id, for the posts whose parent this viewer may read. */
    replyParentAuthorIdByPostId: Map<string, string>;
    /** Replies to their OWN author's post — self-thread continuations, which carry no reply context. */
    selfContinuationPostIds: Set<string>;
    /** The author's lanes, keyed by lane id — the `› Lane name` chip in the name row. */
    laneMap: Map<string, LaneSummary>;
    /** Channel accounts in this page whose `signPosts` is on — see {@link buildSigningChannelIds}. */
    signingChannelIds: Set<string>;
  }): Promise<HydratedPostSummary | null> {
    const { post, viewerContext, pollMap, userMap, mentionCache, linkPreviewMap, authorPrivacyMap, recentReplierMap, orphanAuthorMap, resolvedMap, quoteCountMap, replyParentAuthorIdByPostId, selfContinuationPostIds, laneMap, signingChannelIds } = params;

    const postId = this.resolveId(post);
    if (!postId) return null;

    const isFederatedPost = !!post?.federation;

    // A post normally carries a resolved `oxyUserId` — the federated-actor → Oxy
    // user link is enforced at ingest, so NEW federated posts always have one and
    // the author renders through the canonical Oxy `name.displayName` path
    // (buildUserMap / resolveUserSummaries). Two exceptions are handled here:
    //  - A NATIVE post with no author is a genuine data error → dropped.
    //  - A FEDERATED post with no author is a legacy "orphan" (ingested before the
    //    link was enforced, e.g. a brid.gy/Bluesky-bridged note). It still renders
    //    in a DEGRADED form — its content plus a federation-derived author (see
    //    buildOrphanFederatedAuthorMap) — so a boost/quote referencing it, and the
    //    post itself, is not blank. The degraded author is transient/never cached,
    //    so the DTO self-heals once `oxyUserId` is backfilled.
    let orphanAuthor: PostUser | undefined;
    let authorId = post?.oxyUserId ? String(post.oxyUserId) : undefined;
    if (!authorId) {
      if (!isFederatedPost) return null;
      orphanAuthor = orphanAuthorMap.get(postId) ?? degradedActorSummary(postId);
      authorId = orphanAuthor.id;
    }

    const authorship = normalizeAuthorship(post.authorship as PostAuthorshipEntry[] | undefined);

    if (!this.canViewerReadPost(post, authorId, authorship, viewerContext)) {
      return null;
    }

    // `resolveUserSummaries` always populates an entry for every requested id
    // (a real user or the degraded fallback), so this default is defensive — but
    // it must STILL never emit the raw id as a handle if ever reached. An orphan
    // federated post uses its federation-derived author (its `oxyUserId` is null,
    // so there is nothing in `userMap`), and its authorship carries no usable
    // owner — the byline falls back to `user` from an empty `authors[]`.
    //
    // A CHANNEL post takes this same path and no other. The channel is an Oxy
    // account and authors its own posts, so `authorId` IS the channel and `user`
    // resolves through the ordinary identity route — real handle, real avatar,
    // real `name.displayName`. `user` stays the channel whatever the byline
    // says: the channel is the signature.
    const user = orphanAuthor ?? userMap.get(authorId) ?? degradedActorSummary(authorId);
    const headerEntries = orphanAuthor ? [] : getHeaderAuthorshipEntries(authorship);
    const authors: HydratedAuthor[] = headerEntries.map((entry) => {
      const summary = userMap.get(entry.oxyUserId) ?? degradedActorSummary(entry.oxyUserId);
      return {
        ...summary,
        role: entry.role,
        status: entry.status,
      };
    });

    // The human behind a channel post, named only when the channel says to.
    //
    // FAIL-CLOSED. {@link disclosesWriters} owns both disclosure clauses — the
    // account has to BE a channel, and that channel has to be in
    // `signingChannelIds`, which holds only accounts whose settings row says
    // `signPosts === true`, so a missing row, a channel that never opted in and
    // a failed lookup are all absent from it. The remaining conditions here are
    // about the BYLINE rather than about consent: the post has to carry a
    // writer, and that writer must not already be in it.
    //
    // `userMap` only holds the writer when the SAME conditions already sent the
    // id to the batch, so an undisclosed writer is not merely unrendered: they
    // were never resolved, and `writtenByOxyUserId` has no DTO field to leak
    // through either. Anonymity does not depend on this branch being right.
    //
    // Appended to an EXISTING byline, never used to start one: `authors` leads
    // with the owner, so a lone writer would read as the primary author — the
    // one thing `user` staying the channel is meant to prevent.
    const writerId = typeof post.writtenByOxyUserId === 'string' ? post.writtenByOxyUserId : '';
    if (
      writerId &&
      authors.length > 0 &&
      disclosesWriters(authorId, user, signingChannelIds) &&
      !authors.some((author) => author.id === writerId)
    ) {
      const writer = userMap.get(writerId);
      // Absent only if the batch never resolved them; a resolve MISS still
      // yields the degraded summary, which renders as "Unknown user" with no
      // handle rather than as a raw id.
      if (writer) {
        authors.push({ ...writer, role: 'writer', status: 'accepted' });
      }
    }

    const baseContent: StoredPostContent = post?.content ?? {};
    const resolved = resolvedMap.get(postId) ?? resolveVariant(baseContent);
    const extendedContext = viewerContext as ExtendedViewerContext;
    const postMentions: string[] = Array.isArray(post.mentions) && post.mentions.length > 0
      ? post.mentions.filter((mention): mention is string => typeof mention === 'string')
      : [];
    const inlineVariants = await this.buildInlineVariants(
      baseContent,
      resolved.tag,
      postMentions,
      mentionCache,
      extendedContext.includeFullArticleBody !== false,
    );
    const content = this.buildContent(post, pollMap, viewerContext, resolved, inlineVariants);
    const attachments = this.buildAttachments(post, pollMap, resolved);
    const linkPreviews = linkPreviewMap.get(postId) ?? [];
    const viewerState = this.buildViewerState(post, postId, viewerContext, authorship);
    const permissions = this.buildPermissions(post, authorId, viewerContext, authorship);
    const authorPrivacy = authorPrivacyMap.get(authorId) ?? { ...DEFAULT_PRIVACY };
    const replierAvatars = recentReplierMap?.get(postId);
    const engagement = this.buildEngagement(
      post,
      authorPrivacy,
      replierAvatars,
      quoteCountMap ? quoteCountMap.get(postId) ?? 0 : undefined,
    );

    // Only include essential metadata for feed performance
    const includeFullMetadata = (params.viewerContext as ExtendedViewerContext).includeFullMetadata !== false;
    // Guarded rather than converted inline like `createdAt`: this field is
    // optional, so an unparseable value is reachable, and `toISOString()` throws
    // on one — which would fail the whole hydration, not just this field.
    const scheduledAt = post.scheduledFor
      ? new Date(post.scheduledFor as string | number | Date)
      : null;
    const scheduledFor = scheduledAt && !Number.isNaN(scheduledAt.getTime())
      ? scheduledAt.toISOString()
      : undefined;
    const metadata = {
      visibility: (post.visibility ?? PostVisibility.PUBLIC) as PostVisibility,
      replyPermission: post.replyPermission as import('@mention/shared-types').ReplyPermission[] | undefined,
      reviewReplies: Boolean(post.reviewReplies),
      quotesDisabled: Boolean(post.quotesDisabled),
      isPinned: Boolean(post.metadata?.isPinned),
      isSensitive: Boolean(post.metadata?.isSensitive),
      // Content-warning label from the federated source (Mastodon `summary`). The
      // frontend renders it as a spoiler/CW header; absent for native posts and
      // federated posts without a CW.
      spoilerText: post.federation?.spoilerText || undefined,
      isThread: Boolean(post.threadId),
      language: post.language || undefined,
      languages: post.postClassification?.languages ?? undefined,
      // Only include tags/hashtags if needed (can be large arrays)
      tags: includeFullMetadata && Array.isArray(post.tags) && post.tags.length > 0 ? post.tags : undefined,
      mentions: includeFullMetadata && Array.isArray(post.mentions) && post.mentions.length > 0 ? post.mentions.filter((m): m is string => typeof m === 'string') : undefined,
      hashtags: includeFullMetadata && Array.isArray(post.hashtags) && post.hashtags.length > 0 ? post.hashtags : undefined,
      createdAt: new Date((post.createdAt || post.date || Date.now()) as string | number | Date).toISOString(),
      updatedAt: new Date((post.updatedAt || post.createdAt || Date.now()) as string | number | Date).toISOString(),
      status: post.status as 'draft' | 'published' | 'scheduled' | undefined,
      // Only a scheduled post carries one, and the ACL above already dropped
      // every unpublished post for anyone but its owner/collaborators — so this
      // is emitted unconditionally rather than gated on `status`, which would
      // only duplicate that check somewhere it could drift.
      scheduledFor,
    };

    // Always replace mentions in text if they exist, regardless of includeFullMetadata
    // This ensures mentions are always displayed correctly. Runs on the RESOLVED
    // body (`content.text` is already this reader's language), so a localized
    // rendition never leaks a raw `[mention:<id>]` placeholder.
    const finalText = await this.resolveMentionText(
      typeof content?.text === 'string' ? content.text : '',
      postMentions,
      mentionCache,
    );

    if (content) {
      content.text = finalText;
    }

    const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
    const includeAuthorship = viewerEntry != null;

    // Empty when the parent is absent, unreadable by this viewer, or an orphan
    // federated post with no Oxy author — the post is still marked as a reply,
    // it simply names nobody.
    const parentAuthorId = replyParentAuthorIdByPostId.get(postId);
    const parentAuthor = parentAuthorId ? userMap.get(parentAuthorId) : undefined;
    const replyContext: PostReplyContext = parentAuthor ? { parentAuthor } : {};

    return {
      id: postId,
      content: content ?? { text: finalText },
      attachments,
      linkPreviews,
      user,
      authors,
      ...(includeAuthorship ? { authorship } : {}),
      engagement,
      viewerState,
      permissions,
      metadata,
      // Absent when the post has no lane, and absent when its lane row is gone
      // (the delete cascade unsets `laneId` before removing the Lane, so this is
      // only reachable if that cascade was interrupted — a missing chip, which
      // is harmless).
      ...(typeof post.laneId === 'string' && laneMap.has(post.laneId)
        ? { lane: laneMap.get(post.laneId) }
        : {}),
      // Include parentPostId for thread hierarchy in replies
      ...(post.parentPostId ? { parentPostId: String(post.parentPostId) } : {}),
      // The reply marker rides on the POST, so every surface that renders one —
      // sliced feed, flat feed, search, saved, thread view — can say "Replying
      // to @…" from the DTO alone. `isReplyPost` is the single definition, so a
      // federated reply whose `inReplyTo` never resolved is still marked; it just
      // names nobody. Self-thread continuations are the one exclusion — they are
      // replies, but they are rendered as a THREAD, not as reply context. See
      // `PostReplyContext`.
      ...(isReplyPost(post) && !selfContinuationPostIds.has(postId) ? { replyContext } : {}),
    };
  }

  /**
   * Normalize a raw `content.media` array (strings or objects from lean docs)
   * into typed {@link MediaItem}s carrying `id`/`type` plus the optional `alt`
   * (accessibility description). URL resolution is applied separately via
   * {@link resolveMediaItems}, which passes `alt` through unchanged.
   */
  private normalizeMediaItems(rawMedia: unknown): import('@mention/shared-types').MediaItem[] | undefined {
    if (!Array.isArray(rawMedia)) {
      return undefined;
    }
    const items = rawMedia
      .map((item: unknown): import('@mention/shared-types').MediaItem | undefined => {
        if (!item) return undefined;
        if (typeof item === 'string') {
          return { id: item, type: 'image' };
        }
        if (typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (obj.id) {
            const persisted = readPersistedMediaFields(obj);
            return {
              id: String(obj.id),
              type: obj.type === 'video' || obj.type === 'gif' ? (obj.type as 'video' | 'gif') : 'image',
              ...persisted,
            };
          }
        }
        return undefined;
      })
      .filter((x): x is import('@mention/shared-types').MediaItem => x !== undefined);
    return items;
  }

  /**
   * The text a reader actually sees: mention placeholders (`[mention:<id>]`)
   * replaced with the mentioned user's canonical handle. Runs on the RESOLVED
   * body and on every inline variant, so a language switch never exposes a raw
   * placeholder.
   */
  private async resolveMentionText(
    text: string,
    postMentions: string[],
    mentionCache: Map<string, PostUser>,
  ): Promise<string> {
    if (postMentions.length === 0 || !text.includes('[mention:')) {
      return text;
    }
    return this.replaceMentionPlaceholders(text, postMentions, mentionCache);
  }

  /**
   * The renditions shipped INLINE on the DTO so a reader can switch language with
   * no round trip: every AUTHOR variant, plus the machine translation for the
   * language being served when one is cached ({@link readerVariants}).
   *
   * Emitted ONLY when there is more than one: a monolingual post's single variant
   * IS `content.text`, and shipping it again would duplicate every body in every
   * feed payload. Each variant carries an ALREADY-RESOLVED rendition — its media
   * appears only when that variant overrides it (a replaced set, or the shared set
   * with the variant's localized `alt` merged in), so the client swaps in what it
   * is handed and never re-implements the inheritance rule.
   */
  private async buildInlineVariants(
    content: StoredPostContent,
    servedTag: string | undefined,
    postMentions: string[],
    mentionCache: Map<string, PostUser>,
    includeFullArticleBody: boolean,
  ): Promise<PostContentVariant[] | undefined> {
    const switchable = readerVariants(content, servedTag);
    if (switchable.length < 2) return undefined;

    const inline: PostContentVariant[] = [];
    for (const variant of switchable) {
      const rendition = resolveVariant(content, variant.tag);
      const overridesMedia = variant.media !== undefined || variant.alt !== undefined;
      const normalizedMedia = overridesMedia ? this.normalizeMediaItems(rendition.media) : undefined;
      const article = variant.article && rendition.article;

      inline.push({
        ...(variant.tag ? { tag: variant.tag } : {}),
        source: variant.source,
        text: await this.resolveMentionText(variant.text, postMentions, mentionCache),
        ...(normalizedMedia && normalizedMedia.length > 0
          ? { media: resolveMediaItems(normalizedMedia) }
          : {}),
        ...(article
          ? {
              article: {
                title: article.title,
                excerpt: article.excerpt,
                ...(includeFullArticleBody && article.body ? { body: article.body } : {}),
              },
            }
          : {}),
        ...(variant.createdAt ? { createdAt: variant.createdAt } : {}),
      });
    }
    return inline;
  }

  private buildContent(
    post: RawPost,
    pollMap: Map<string, Record<string, unknown>>,
    viewerContext: ViewerContext | undefined,
    resolved: ResolvedVariant,
    inlineVariants: PostContentVariant[] | undefined,
  ): Record<string, unknown> {
    const baseContent: StoredPostContent = post?.content ?? {};

    // The media the RESOLVED rendition shows: the shared set with this language's
    // alt descriptions merged in, or the set the variant replaced it with.
    const normalizedMedia = this.normalizeMediaItems(resolved.media);
    const media = normalizedMedia ? resolveMediaItems(normalizedMedia) : undefined;

    const pollId = baseContent.pollId;
    const poll = pollId ? pollMap.get(String(pollId)) : undefined;
    const article = resolved.article;

    return {
      // Already resolved for THIS reader — every renderer that reads `content.text`
      // (video captions, notification previews, quote cards, the share sheet, SEO,
      // the server-rendered OG, MCP) shows the right language without knowing this
      // feature exists. It is not stored anywhere: the body lives only on the
      // variant this resolved to.
      text: resolved.text,
      // The tag actually served — what the UI shows as "Showing in Spanish".
      textLang: resolved.tag,
      variants: inlineVariants,
      media,
      poll,
      pollId: pollId ? String(pollId) : undefined,
      // For feed, only include article metadata, not full body (saves bandwidth)
      article: article
        ? {
            articleId: article.articleId,
            title: article.title,
            excerpt: article.excerpt,
            // Only include body if explicitly requested (e.g., for detail view)
            ...((viewerContext as ExtendedViewerContext)?.includeFullArticleBody && article.body
              ? { body: article.body }
              : {}),
          }
        : undefined,
      sources: Array.isArray(baseContent.sources) ? baseContent.sources : undefined,
      location: baseContent.location,
      event: baseContent.event,
      room: baseContent.room,
      attachments: Array.isArray(baseContent.attachments) ? baseContent.attachments : undefined,
    };
  }

  private buildAttachments(
    post: RawPost,
    pollMap: Map<string, Record<string, unknown>>,
    resolved: ResolvedVariant,
  ): PostAttachmentBundle {
    const content = post?.content ?? {};
    const attachments: PostAttachmentBundle = {};

    // The attachment bundle renders the SAME rendition as `content` — a reader
    // served the Spanish body must get the Spanish alt text on the same images.
    const normalizedMedia = this.normalizeMediaItems(resolved.media);
    if (normalizedMedia && normalizedMedia.length > 0) {
      attachments.media = resolveMediaItems(normalizedMedia);
    }

    const pollId = content.pollId;
    if (pollId) {
      const poll = pollMap.get(String(pollId));
      if (poll) {
        attachments.poll = poll as unknown as import('@mention/shared-types').PollData;
      }
    } else if (content.poll) {
      attachments.poll = content.poll;
    }

    if (resolved.article) {
      attachments.article = {
        articleId: resolved.article.articleId,
        title: resolved.article.title,
        body: resolved.article.body,
        excerpt: resolved.article.excerpt,
      };
    }

    if (Array.isArray(content.sources) && content.sources.length > 0) {
      attachments.sources = (content.sources as Array<{ url: string; title?: string }>).map((source: { url: string; title?: string }) => ({
        url: source.url,
        title: source.title,
      }));
    }

    if (content.location?.coordinates?.length === 2) {
      attachments.location = content.location;
    }

    if (content.event) {
      attachments.event = {
        eventId: content.event.eventId,
        name: content.event.name,
        date: content.event.date,
        location: content.event.location,
        description: content.event.description,
      };
    }

    const roomData = content.room;
    if (roomData) {
      attachments.room = {
        roomId: roomData.roomId,
        title: roomData.title,
        status: roomData.status,
        topic: roomData.topic,
        host: roomData.host,
      };
    }

    if (content.podcast) {
      attachments.podcast = {
        syraPodcastId: content.podcast.syraPodcastId,
        title: content.podcast.title,
        author: content.podcast.author,
        artworkUrl: content.podcast.artworkUrl,
        showUrl: content.podcast.showUrl,
      };
    }

    return attachments;
  }

  /**
   * `isOwner` is what the client's post menu draws itself from — delete, edit,
   * pin, move to lane, reply options — so it has to name everybody who may
   * actually manage the post.
   *
   * `authorship` alone does not. A CHANNEL post's owner entry is the CHANNEL,
   * an account nobody can ever be signed in as, so on `authorship` alone every
   * channel post is unmanageable by everyone — the menu comes up empty for the
   * person who wrote it. The writer is carried in `writtenByOxyUserId` and never
   * in `authorship` (putting them there would break the channel's anonymity and
   * put the post back on their own profile), which is why this reads both.
   *
   * `canManagePostWithoutLookup` is the SAME predicate the write routes take
   * their fast path from, so the button and the route agree by construction on
   * everything it covers. What it deliberately does not cover is a co-operator
   * who did not write the post: that is a membership question only Oxy can
   * answer, and this runs once per post per hydration. They see no button and
   * would not be refused if they reached the route — affordance ⊆ permission.
   */
  private buildViewerState(
    post: RawPost,
    postId: string,
    viewerContext: ViewerContext,
    authorship: PostAuthorshipEntry[],
  ): PostViewerState {
    const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
    const isOwner =
      viewerEntry?.role === 'owner' || canManagePostWithoutLookup(post, viewerContext.viewerId);
    const isCollaborator = viewerEntry?.role === 'collaborator' && viewerEntry.status === 'accepted';

    return {
      isOwner,
      isCollaborator,
      collabInvitePending: viewerEntry?.role === 'collaborator' && viewerEntry.status === 'pending',
      viewerRole: viewerEntry?.role,
      isLiked: viewerContext.likedPosts.has(postId),
      isDownvoted: viewerContext.downvotedPosts.has(postId),
      isBoosted: viewerContext.boostedPosts.has(postId),
      isSaved: viewerContext.savedPosts.has(postId),
    };
  }

  private buildPermissions(
    post: RawPost,
    authorId: string,
    viewerContext: ViewerContext,
    authorship: PostAuthorshipEntry[],
  ): PostPermissions {
    const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
    // Same reading as `buildViewerState` — and it has to be the same, or the
    // menu and the permission flags beside it would disagree about one post.
    const isOwner =
      viewerEntry?.role === 'owner' || canManagePostWithoutLookup(post, viewerContext.viewerId);
    const isAcceptedCollaborator = viewerEntry?.role === 'collaborator' && viewerEntry.status === 'accepted';
    const canReply = this.computeReplyPermission(post, authorId, viewerContext);

    return {
      canReply,
      canDelete: isOwner,
      canPin: isOwner,
      canViewSources: Boolean(post?.content?.sources?.length),
      canEdit: isOwner,
      canStopSharing: isAcceptedCollaborator,
      canViewInsights: isOwner || isAcceptedCollaborator,
    };
  }

  private computeReplyPermission(post: RawPost, authorId: string, viewerContext: ViewerContext): boolean {
    const viewerId = viewerContext.viewerId;
    if (!viewerId) return false;
    if (viewerId === authorId) return true;

    const permissions: string[] = post?.replyPermission || ['anyone'];

    if (permissions.includes('anyone')) return true;
    if (permissions.includes('nobody')) return false;

    for (const perm of permissions) {
      switch (perm) {
        case 'followers':
          if (viewerContext.follows.has(authorId)) return true;
          break;
        case 'following':
          if (viewerContext.followedBy.has(authorId)) return true;
          break;
        case 'mentioned':
          if (Array.isArray(post?.mentions) && post.mentions.some((mention: unknown) => {
            const mentionId = typeof mention === 'string' ? mention : typeof mention === 'object' && mention ? String((mention as Record<string, unknown>).id || (mention as Record<string, unknown>)._id || (mention as Record<string, unknown>).oxyUserId || '') : '';
            return mentionId && String(mentionId) === viewerId;
          })) return true;
          break;
      }
    }

    return false;
  }

  /**
   * Posts-that-quote counts for the whole hydrated graph in ONE indexed
   * aggregate over `{ quoteOf: 1, createdAt: -1 }`. Only ids with at least one
   * quote appear; a caller reads a miss as zero. Counting on read (rather than a
   * denormalized `stats.quotesCount`) matches how the insights endpoint already
   * reports quotes, so there is one source of truth and nothing to backfill or
   * keep in lockstep at the quote write sites.
   */
  private async buildQuoteCountMap(postIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (postIds.length === 0) return counts;

    const rows = await Post.aggregate<{ _id: string; count: number }>([
      { $match: { quoteOf: { $in: postIds } } },
      { $group: { _id: '$quoteOf', count: { $sum: 1 } } },
    ]);

    for (const row of rows) {
      if (row?._id) counts.set(String(row._id), row.count);
    }
    return counts;
  }

  private buildEngagement(
    post: RawPost,
    authorPrivacy: typeof DEFAULT_PRIVACY,
    recentReplierAvatars?: string[],
    quotesCount?: number,
  ): PostEngagementSummary {
    const stats = post?.stats || {};
    const likesCount = typeof stats.likesCount === 'number' ? stats.likesCount : 0;
    const downvotesCount = typeof stats.downvotesCount === 'number' ? stats.downvotesCount : 0;
    const boostsCount = typeof stats.boostsCount === 'number' ? stats.boostsCount : 0;
    const repliesCount = typeof stats.commentsCount === 'number' ? stats.commentsCount : 0;
    const savesCount = typeof stats.savesCount === 'number' ? stats.savesCount : 0;

    const viewsCount = typeof stats.viewsCount === 'number' ? stats.viewsCount : 0;

    return {
      likes: authorPrivacy.hideLikeCounts ? null : likesCount,
      downvotes: authorPrivacy.hideLikeCounts ? null : downvotesCount,
      boosts: authorPrivacy.hideShareCounts ? null : boostsCount,
      replies: authorPrivacy.hideReplyCounts ? null : repliesCount,
      saves: authorPrivacy.hideSaveCounts ? null : savesCount,
      // Absent unless the caller asked for quote counts. Hidden by the same
      // author control as boosts — a quote is a share of the post.
      quotes: quotesCount === undefined
        ? undefined
        : authorPrivacy.hideShareCounts ? null : quotesCount,
      views: viewsCount > 0 ? viewsCount : null,
      impressions: null,
      recentReplierAvatars: recentReplierAvatars?.length ? recentReplierAvatars : undefined,
    };
  }

  private attachNestedContext(
    post: RawPost,
    summary: HydratedPostSummary,
    summaryMap: Map<string, HydratedPostSummary>,
    collectedPostIds: Set<string>,
    publicReferencesOnly: boolean,
  ): HydratedPost | null {
    const boostOf = post?.boostOf ? String(post.boostOf) : undefined;
    const quoteOf = post?.quoteOf ? String(post.quoteOf) : undefined;

    const quotedPost = quoteOf ? summaryMap.get(quoteOf) ?? null : null;
    const boostOriginal = boostOf ? summaryMap.get(boostOf) ?? null : null;

    let originalPost: HydratedPostSummary | null = null;
    if (boostOf) {
      originalPost = boostOriginal;
    } else if (quoteOf) {
      originalPost = quotedPost;
    }

    let boostContext: HydratedBoostContext | null = null;
    if (boostOf) {
      if (boostOriginal) {
        boostContext = { originalPost: boostOriginal, actor: summary.user };
      } else if (!publicReferencesOnly && !collectedPostIds.has(boostOf)) {
        // The boosted original was force-collected but no post row came back — it
        // is genuinely GONE (deleted, or a never-imported federated original).
        // A boost has an empty body, so instead of a blank card we surface an
        // `unavailable` marker for the client to render a placeholder. This is
        // deliberately distinct from an original that WAS collected but whose
        // summary was dropped by an ACL/visibility check for this viewer (id IS in
        // `collectedPostIds`) — that stays `boost: null` so a private post's
        // existence is never revealed. On public-broadcast surfaces
        // (`publicReferencesOnly`) a filtered-out original is indistinguishable
        // from a gone one at the query layer, so we stay conservative and keep
        // `boost: null` there too.
        boostContext = { originalPost: null, actor: summary.user, unavailable: true };
      }
    }

    const context = this.buildContext(post);

    return {
      ...summary,
      originalPost,
      quotedPost,
      boost: boostContext,
      context,
    };
  }

  private buildContext(post: RawPost) {
    if (!post?.threadId && !post?.parentPostId) {
      return undefined;
    }

    return {
      parentThreadId: post.threadId ? String(post.threadId) : undefined,
      isThreadParent: !post.parentPostId && Boolean(post.threadId),
    };
  }

  private async replaceMentionPlaceholders(
    text: string,
    mentions: string[],
    mentionCache: Map<string, PostUser>,
  ): Promise<string> {
    if (!text || !Array.isArray(mentions) || mentions.length === 0) {
      return text;
    }

    // Normalize the current post's declared mention IDs via the shared coercion
    // (the SAME parsing the federation Note builder uses). The per-request cache is
    // intentionally shared across a hydration batch, so replacement must be scoped
    // to this per-post allowlist rather than every cached user.
    const declaredMentionIds = new Set<string>(normalizeMentionIds(mentions));

    // Collect declared mention placeholders present in the text but not yet in
    // the per-request cache. Only placeholders that actually appear are worth
    // resolving.
    const uncachedIds: string[] = [];
    for (const mentionId of declaredMentionIds) {
      if (text.includes(`[mention:${mentionId}]`) && !mentionCache.has(mentionId)) {
        uncachedIds.push(mentionId);
      }
    }

    // Resolve the uncached ids through the shared user-summary resolver: ONE
    // batched Redis read + ONE bulk service-token Oxy fetch for the misses, and
    // it writes the resolved summaries back to the Redis cache. A user who is
    // both a post author and a mention is already warm from `buildUserMap`, so
    // this never re-fetches them. Ids that only resolve to the degraded fallback
    // summary (empty handle, i.e. the lookup failed) are treated as unresolved
    // and left as the original placeholder.
    if (uncachedIds.length > 0) {
      const resolved = await resolveUserSummaries(uncachedIds);
      for (const mentionId of uncachedIds) {
        const value = resolved.get(mentionId);
        if (!value || isFallbackUserSummary(value.user)) {
          continue;
        }
        mentionCache.set(mentionId, value.user);
      }
    }

    // Single-pass replacement: build the placeholder→replacement map for only
    // this post's declared mention IDs, then run ONE regex over the text. An
    // undeclared or unresolved mention is left as its original placeholder.
    const replacements = new Map<string, string>();
    for (const mentionId of declaredMentionIds) {
      const mentionUser = mentionCache.get(mentionId);
      if (mentionUser) {
        // Canonical handle (`username@domain` for federated) owns both the label
        // fallback and the link target, so they can never diverge.
        const handle = getNormalizedUserHandle(mentionUser);
        if (!handle) continue;
        // A mention with no display name renders as `@handle` — never `@undefined`.
        const mentionLabel = mentionUser.name?.displayName?.trim() || handle;
        replacements.set(mentionId, `[@${mentionLabel}](${handle})`);
      }
    }

    return text.replace(/\[mention:([^\]]+)\]/g, (placeholder, mentionId: string) => {
      return replacements.get(mentionId) ?? placeholder;
    });
  }
}

export const postHydrationService = new PostHydrationService();
