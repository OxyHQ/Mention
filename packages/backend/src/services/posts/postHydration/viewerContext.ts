// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Who is asking: the viewer's blocks, follows, privacy, interactions, languages and operated accounts. */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres';
import { bookmarks as bookmarksTable, likes as likesTable } from '../../../db/schema/engagement';
import { userSettings } from '../../../db/schema/userProfile';
import { findRepostedPostIds } from '../../../db/posts/postRepository';
import { findFederatedVisibilityOptOuts } from '../../../db/federation/actorRepository';
import { getRuntimeOxyClient } from '../../../runtime/oxyClient';
import {
  getBlockedUserIds,
  getRestrictedUserIds,
  getFollowingIds,
  getFollowerIds,
} from '../../../utils/privacyHelpers';
import { logger } from '../../../utils/logger';
import {
  DEFAULT_PRIVACY,
  readEngagementCountPrivacy,
} from '../../engagement/engagementCountPrivacy';
import { listOperatedChannelIds } from '../../accounts/publishAsAccount';
import { languageLadder, loadViewerLanguages } from '../../../utils/viewerLanguage';
import type { ExtendedViewerContext, HydrationOptions, RawPost, ViewerContext } from './types';
import { mayNeedCurrentChannelAuthority } from './readability';

/**
 * The viewer's ordered language preference ({@link languageLadder}): an
 * explicit `?lang`, then the viewer's Oxy account locales — which the feed
 * already resolved and threads in, and which every other caller reads here
 * through the same {@link loadViewerLanguages} — then `Accept-Language`.
 * Fail-soft: an unresolvable viewer simply contributes no account locales.
 */
async function buildLanguageCandidates(
  viewerId: string | undefined,
  options: HydrationOptions | undefined,
): Promise<string[]> {
  const accountLanguages =
    options?.viewerLanguages ?? (await loadViewerLanguages(viewerId, options?.oxyClient));
  return languageLadder(options?.requestLanguages, accountLanguages);
}

export async function buildViewerContext(
  posts: object[],
  viewerId?: string,
  options?: HydrationOptions,
  accessDb?: DatabaseOrTransaction,
): Promise<ExtendedViewerContext> {
  const context: ExtendedViewerContext = {
    viewerId,
    languageCandidates: [],
    blockedIds: new Set<string>(),
    restrictedIds: new Set<string>(),
    follows: new Set<string>(),
    followedBy: new Set<string>(),
    likedPosts: new Set<string>(),
    downvotedPosts: new Set<string>(),
    savedPosts: new Set<string>(),
    boostedPosts: new Set<string>(),
    privateProfileIds: new Set<string>(),
    operatedAccountIds: new Set<string>(options?.operatedAccountIds ?? []),
    includeFullArticleBody: options?.includeFullArticleBody ?? true,
    includeFullMetadata: options?.includeFullMetadata ?? true,
  };

  // Collect unique author IDs for profile visibility check
  const authorIds = Array.from(
    new Set(
      posts
        .map((p) => (p as RawPost)?.oxyUserId)
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  );

  const client = options?.oxyClient;
  // These reads share no inputs beyond the request. Await them together so
  // languages, author settings, privacy and graph latency do not add up.
  // Privacy rejection still rejects hydration before any post is emitted.
  await Promise.all([
    (async () => {
      // Access checks do not render translations or need identity-summary DB reads.
      if (!accessDb) context.languageCandidates = await buildLanguageCandidates(viewerId, options);
    })(),
    (async () => {
      // Load ALL author settings in one query (profile visibility + engagement privacy)
      // This avoids a separate query in buildAuthorPrivacyMap.
      //
      // It is also the ONLY `user_settings` read a hydration makes. There used to
      // be a second one, a few hundred lines below, that loaded the VIEWER's own
      // four counter flags into the context — per-statement instrumentation put
      // `user_settings` at two of the eight round trips one hydration costs. It
      // went, rather than being folded into this batch, because the value it
      // loaded was never read by anything and could not have been correct if it
      // were: the four flags belong to a post's AUTHOR and hide a counter from
      // everyone (see `engagementCountPrivacy.ts`), so the viewer's own copy of
      // them says what the viewer discloses on THEIR posts — not what they may be
      // shown on someone else's.
      if (authorIds.length > 0) {
        try {
          const allAuthorSettings = await loadPrivacySettings(authorIds, accessDb);

          // Pre-populate author privacy map for reuse in buildAuthorPrivacyMap
          const authorPrivacyCache = new Map<string, typeof DEFAULT_PRIVACY>();
          for (const row of allAuthorSettings) {
            const authorId = row.oxyUserId;

            // Track private profiles
            if (row.profileVisibility === 'private' || row.profileVisibility === 'followers_only') {
              context.privateProfileIds.add(authorId);
            }

            // Cache engagement privacy for buildAuthorPrivacyMap
            // The columns are flat and `NOT NULL`, so the row IS a
            // `CountPrivacySource`. Read through the shared helper anyway: the
            // realtime broadcaster hides exactly what this DTO hides, and a fifth
            // counter must not be able to land in one surface only.
            authorPrivacyCache.set(authorId, readEngagementCountPrivacy(row));
          }

          // Set defaults for authors without settings
          for (const authorId of authorIds) {
            if (!authorPrivacyCache.has(authorId)) {
              authorPrivacyCache.set(authorId, { ...DEFAULT_PRIVACY });
            }
          }

          context._authorPrivacyCache = authorPrivacyCache;
        } catch (error) {
          // Authorization must fail closed if local privacy cannot be read.
          if (accessDb) throw error;
          logger.warn('[PostHydration] Failed to load author settings:', error);
        }
      }
    })(),
    (async () => {
      // A signed-out viewer, and a federated author who hides from signed-out
      // readers at their origin (Bluesky's `!no-unauthenticated`). Joining
      // the private-profile set is exactly right: that gate admits followers
      // and owners, and a signed-out viewer is neither.
      if (viewerId || authorIds.length === 0) return;
      try {
        const optOuts = await findFederatedVisibilityOptOuts(authorIds, accessDb);
        for (const [authorId, optOut] of optOuts) {
          if (optOut.requiresSignIn) context.privateProfileIds.add(authorId);
        }
      } catch (error) {
        // The same failure policy as the author settings read above.
        if (accessDb) throw error;
        logger.warn('[PostHydration] Failed to load federated visibility opt-outs:', error);
      }
    })(),
    (async () => {
      if (!viewerId) return;
      // Feed path: the controller resolved both lists ONCE, up front — do NOT ask
      // Oxy again. See `viewerPrivacy` on `HydrationOptions`; this is the same
      // deduplication `viewerGraph` performs immediately below.
      const threadedPrivacy = options?.viewerPrivacy;
      const [blockedIds, restrictedIds] = threadedPrivacy
        ? [threadedPrivacy.blockedIds, threadedPrivacy.restrictedIds]
        : await Promise.all([
            getBlockedUserIds(client, accessDb ? undefined : viewerId),
            getRestrictedUserIds(client, accessDb ? undefined : viewerId),
          ]);

      blockedIds.forEach((id) => context.blockedIds.add(String(id)));
      restrictedIds.forEach((id) => context.restrictedIds.add(String(id)));
    })(),
    (async () => {
      if (!viewerId) return;
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
          const [followingIds, followerIds] = await Promise.all([
            getFollowingIds(viewerId, oxyForFollows, accessDb ? { fresh: true } : undefined).catch(
              (error: unknown) => {
                logger.warn('[PostHydration] getUserFollowing failed:', error);
                return [];
              },
            ),
            getFollowerIds(viewerId, oxyForFollows, accessDb ? { fresh: true } : undefined).catch(
              (error: unknown) => {
                logger.warn('[PostHydration] getUserFollowers failed:', error);
                return [];
              },
            ),
          ]);

          followingIds.forEach((id) => context.follows.add(String(id)));
          followerIds.forEach((id) => context.followedBy.add(String(id)));
        } catch (error) {
          logger.warn('[PostHydration] Failed to load follower/following context:', error);
        }
      }
    })(),
  ]);

  if (!viewerId) return context;

  // LAST, because it reads the follow graph and the restriction/private-profile
  // sets built above: whether a post is withheld from this viewer at all is
  // what decides if the round trip is worth making.
  await resolveCurrentChannelAuthority(posts, context, options);

  return context;
}

/**
 * Ask Oxy which channels this viewer currently operates — but only if a post
 * in this batch is one where the answer could change the verdict.
 *
 * ## Why the answer cannot simply be read off the post
 *
 * A channel post carries the human who wrote it in `writtenByOxyUserId`, free
 * and already in hand, and the ACL used to admit them on that alone. It is the
 * wrong column for the question. It is written once, at creation
 * (`PostCreationService`), and never again — not when a colleague rewrites the
 * post, and not when its writer leaves the channel. So it answered "yes" for a
 * removed member for as long as they held the post id, over an editorial queue
 * whose entire value is being embargoed, and over edits made after they left.
 *
 * Current membership lives in Oxy's account graph and nowhere else, so proving
 * it costs a round trip. `GET /accounts` is anchored on the AUTHENTICATED
 * OPERATOR — a service credential cannot ask it on someone's behalf — which is
 * why the caller hands over its own client rather than hydration holding one.
 *
 * ## What stops this landing on a feed
 *
 * {@link mayNeedCurrentChannelAuthority}, evaluated over columns already
 * fetched. A published, public post asks Oxy nothing however it was authored,
 * which is every channel post on every feed, in search, and on the profile.
 * What is left is a post WITHHELD from this viewer that an account authored on
 * somebody's behalf — the exact set the departed-writer clause used to decide,
 * and rare enough on the id-based surfaces to be worth one `GET /accounts`.
 *
 * ONE call for the whole batch, not one per post, and only ever after the free
 * checks have failed to admit the viewer on their own.
 *
 * ## Two ways this deliberately does nothing
 *
 * An explicit `operatedAccountIds` wins outright, empty array included: a
 * caller that resolved the set itself (`getScheduledPosts`, which scopes its
 * query with the same list) must not have a second, later resolution disagree
 * with the one its query used.
 *
 * No reader means no answer, and no answer means refusal — `listOperatedChannelIds`
 * fail-softs to `[]` on an Oxy outage for the same reason. Both directions are
 * narrow-not-wide: the cost is a member briefly unable to read their own queued
 * post, never a stranger able to.
 */
export async function resolveCurrentChannelAuthority(
  posts: object[],
  context: ExtendedViewerContext,
  options: HydrationOptions | undefined,
): Promise<void> {
  if (!context.viewerId || context._channelAuthorityResolved) return;
  if (options?.operatedAccountIds !== undefined) return;
  const reader = options?.operatedAccountReader;
  if (!reader) return;
  if (!posts.some((post) => mayNeedCurrentChannelAuthority(post as RawPost, context))) return;

  for (const accountId of await listOperatedChannelIds(reader)) {
    context.operatedAccountIds.add(accountId);
  }
  context._channelAuthorityResolved = true;
}

/**
 * The privacy columns of `user_settings` for a set of accounts.
 *
 * ONE reader for every site that needs them (author privacy, profile
 * visibility, the viewer's own preference), so four call sites do not each
 * rebuild the same defaults.
 * A row's ABSENCE is meaningful — it means "never saved settings" — so the
 * caller applies `DEFAULT_PRIVACY` rather than this returning a padded map.
 */
export async function loadPrivacySettings(
  oxyUserIds: string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<
  Array<{
    oxyUserId: string;
    profileVisibility: string | null;
    hideLikeCounts: boolean;
    hideShareCounts: boolean;
    hideReplyCounts: boolean;
    hideSaveCounts: boolean;
  }>
> {
  if (oxyUserIds.length === 0) return [];
  return db
    .select({
      oxyUserId: userSettings.oxyUserId,
      profileVisibility: userSettings.privacyProfileVisibility,
      hideLikeCounts: userSettings.privacyHideLikeCounts,
      hideShareCounts: userSettings.privacyHideShareCounts,
      hideReplyCounts: userSettings.privacyHideReplyCounts,
      hideSaveCounts: userSettings.privacyHideSaveCounts,
    })
    .from(userSettings)
    .where(inArray(userSettings.oxyUserId, oxyUserIds));
}

export async function populateViewerInteractions(
  postIds: string[],
  viewerContext: ViewerContext,
): Promise<void> {
  const viewerId = viewerContext.viewerId;
  if (!viewerId || postIds.length === 0) {
    return;
  }

  try {
    const db = getDb();
    const [likeRows, bookmarkRows, reposts] = await Promise.all([
      db
        .select({ postId: likesTable.postId, value: likesTable.value })
        .from(likesTable)
        .where(and(eq(likesTable.userId, viewerId), inArray(likesTable.postId, postIds))),
      db
        .select({ postId: bookmarksTable.postId })
        .from(bookmarksTable)
        .where(and(eq(bookmarksTable.userId, viewerId), inArray(bookmarksTable.postId, postIds))),
      findRepostedPostIds(viewerId, postIds),
    ]);

    // `value` is `1` or `-1` and NOT NULL, so a downvote is the only way into
    // the second bucket.
    for (const like of likeRows) {
      if (like.value === 1) viewerContext.likedPosts.add(like.postId);
      else viewerContext.downvotedPosts.add(like.postId);
    }

    for (const bookmark of bookmarkRows) {
      viewerContext.savedPosts.add(bookmark.postId);
    }

    for (const repostedId of reposts) {
      viewerContext.boostedPosts.add(repostedId);
    }
  } catch (error) {
    logger.error('[PostHydration] Failed to populate viewer interactions:', error);
  }
}
