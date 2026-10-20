/**
 * FeedInteractionTracker
 *
 * Tracks feed impressions, clicks, and engagement for feed quality improvement.
 * AT Protocol equivalent: app.bsky.feed.sendInteractions
 */

import { MtnConfig, PostVisibility } from '@mention/shared-types';
import type { FeedInteractionEventName } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { feedInteractions } from '../../db/schema/feeds';

/**
 * Whether the post came from another instance — the impression-origin label.
 *
 * Tests the SAME disjunction `assemblePostRecords` uses to decide whether a
 * record carries a `federation` object at all, rather than any single column: a
 * federated post that arrived without an `activity_id` would otherwise be
 * labelled `local` and quietly skew the federated-vs-local denominator.
 */
const IS_FEDERATED = sql<boolean>`(
  ${posts.federationActivityId} is not null
  or ${posts.federationActorUri} is not null
  or ${posts.federationInReplyTo} is not null
  or ${posts.federationUrl} is not null
  or ${posts.federationSensitive} is not null
  or ${posts.federationSpoilerText} is not null
)`;
import { recordDedupedView } from '../../services/feedViewCounter';
import { recordDwell } from '../../services/dwellAggregate';
import { type InteractionEntry, userPreferenceService } from '../../services/UserPreferenceService';
import {
  recordImpression,
  recordInteractionSignal,
  recordReport,
  originForFederation,
} from './feedMetrics';

export interface FeedInteractionData {
  userId: string;
  feedDescriptor: string;
  postUri: string;
  /** Shared with the client emitter and the route validator — see `@mention/shared-types`. */
  event: FeedInteractionEventName;
  durationMs?: number;
  timestamp: Date;
}

/**
 * Record a batch of feed interactions for analytics and ranking feedback.
 *
 * Returns, per interaction and in order, the post's new `viewsCount` when that
 * interaction counted a view and `null` otherwise — see
 * {@link applyImpressionSignals}. Nothing else the server does here is invisible
 * to the caller, so nothing else needs returning.
 *
 * The raw rows go to `feed_interactions` in POSTGRES, in ONE insert, alongside
 * everything else this function writes: the view counts, the dwell aggregates
 * and the preference signals below. The table is indexed, swept by
 * `db/expiry.ts` and probed by the deletion preflight.
 *
 * `createdAt` is written EXPLICITLY from the caller's timestamp rather than
 * left to the column default. The caller stamps the interaction when it
 * happened; this write is awaited inside a request but the value it records is
 * not "now", and a default would quietly re-date every row to insert time.
 */
export async function trackFeedInteractions(
  interactions: readonly FeedInteractionData[],
): Promise<Array<number | null>> {
  if (interactions.length === 0) return [];
  try {
    await getDb()
      .insert(feedInteractions)
      .values(
        interactions.map((interaction) => ({
          userId: interaction.userId,
          feedDescriptor: interaction.feedDescriptor,
          postUri: interaction.postUri,
          event: interaction.event,
          durationMs: interaction.durationMs,
          createdAt: interaction.timestamp,
        })),
      );
  } catch (error) {
    // Non-critical — log and move on. Analytics must never fail a feed request.
    logger.warn('[FeedInteractionTracker] Failed to record interactions', error);
  }

  // A report is a strong negative feed signal — count it (split by origin) so
  // report-per-impression can be tracked online and per A/B cohort offline.
  for (const interaction of interactions) {
    if (interaction.event !== 'report') continue;
    recordReportSignal(interaction).catch((error) => {
      logger.warn('[FeedInteractionTracker] Failed to record report signal', error);
    });
  }

  // An impression carries TWO derived signals beyond the raw analytics row:
  //   1. a deduped increment of the post's real view count (ranking input), and
  //   2. a UserBehavior learning signal — a genuine `view` when the post was
  //      dwelled on, or a negative `skip` when it was scrolled past quickly.
  // AWAITED, because one of those side effects produces a value the RESPONSE
  // carries: the post's new view total. The reporting client is the surface that
  // shows that number, and only the server knows whether the view counted.
  const viewCounts: Array<number | null> = interactions.map(() => null);
  const impressionAt = interactions.flatMap((interaction, index) =>
    interaction.event === 'impression' ? [index] : [],
  );
  if (impressionAt.length === 0) return viewCounts;
  const counted = await applyImpressionSignals(impressionAt.map((index) => interactions[index]));
  impressionAt.forEach((index, at) => {
    viewCounts[index] = counted[at] ?? null;
  });
  return viewCounts;
}

/**
 * Apply the deduped view-count increments and the UserBehavior learning signals
 * for a batch of feed impressions. `postUri` is the local post id (`posts.id`, a
 * `text` column holding ObjectId hex before the cutover and uuid v7 after); a
 * uri naming no local post is skipped.
 *
 * Impression telemetry is CLIENT-controlled, so its side effects are hardened
 * against ranking manipulation:
 *   - each post is resolved to a real public+published local post (author
 *     included) before any side effect runs;
 *   - a viewer's OWN posts record NO view/dwell/preference learning, so an author
 *     cannot self-pump their own ranking signals;
 *   - the dwell sample is CLAMPED to `MtnConfig.preferences.maxDwellMs` and folded
 *     into the rolling average AT MOST ONCE per (post, viewer) — only when the
 *     deduped view counted a NEW view — so a forged/repeated impression cannot
 *     dominate or inflate the average.
 *
 * ONE read resolves every post in the batch, and each viewer's preference
 * signals are applied in ONE locked write (`recordInteractions`), in batch order.
 *
 * Returns, per impression, the post's new `viewsCount` when that impression
 * counted a view, and `null` on every path that did not count one — a non-local
 * uri, an ineligible post, the self-view guard, a repeat inside the dedupe
 * window, or a failure. That is exactly the set of decisions a client cannot make
 * for itself, which is why the value travels back rather than being inferred
 * there.
 *
 * Exported for unit testing; called only by {@link trackFeedInteractions}.
 */
export async function applyImpressionSignals(
  impressions: readonly FeedInteractionData[],
): Promise<Array<number | null>> {
  // Emptiness only. There is deliberately NO id-shape check: `posts.id` is
  // `text` holding pre-cutover ObjectId hex AND post-cutover uuid v7, so an
  // `isValidObjectId` guard would reject every post this instance has minted
  // since the cutover. The ids are bound parameters against a `text` column, so
  // a `postUri` that is not a local post id — a federated URI, or anything else
  // a client invents — simply matches no row.
  const postIds = [...new Set(impressions.map((impression) => impression.postUri))].filter(
    (postId) => postId.length > 0,
  );
  if (postIds.length === 0) return impressions.map(() => null);

  const eligible = await getDb()
    .select({ id: posts.id, oxyUserId: posts.oxyUserId, isFederated: IS_FEDERATED })
    .from(posts)
    .where(
      and(
        inArray(posts.id, postIds),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ),
    );
  const postById = new Map(eligible.map((post) => [post.id, post]));

  // Built synchronously, in batch order, so the preference write applies the
  // signals in the order they were observed.
  const preferenceSignals = new Map<string, InteractionEntry[]>();
  const counted = await Promise.all(
    impressions.map(async (impression) => {
      const post = postById.get(impression.postUri);
      if (!post) return null;

      // Self-pumping guard: a viewer impressing their OWN post must not move any
      // ranking/learning signal (view count, dwell average, or affinity),
      // otherwise an author could inflate their own reach by re-viewing their
      // posts. Self-views are also excluded from the impression metrics so they
      // never skew the engagement-per-impression denominator.
      if (post.oxyUserId && post.oxyUserId === impression.userId) return null;

      // Online metric: a genuine third-party impression, split by federated vs
      // local origin (the denominator for engagement- and report-per-impression).
      recordImpression(impression.feedDescriptor, originForFederation(post.isFederated || null));

      // UserBehavior signal. A short dwell is a SKIP (negative); a real dwell is
      // a VIEW (mild positive). The frontend only reports impressions that
      // passed its visibility gate, so `durationMs` is the accrued visible time.
      // The originating feed is forwarded as the attribution surface so a
      // video-feed view is attributed to video content, not the author.
      const dwellMs = impression.durationMs ?? 0;
      const signal =
        dwellMs > 0 && dwellMs < MtnConfig.preferences.dwellSkipThresholdMs ? 'skip' : 'view';
      // Online metric: the derived view/skip signal for this impression.
      recordInteractionSignal(signal, impression.feedDescriptor);
      const signals = preferenceSignals.get(impression.userId) ?? [];
      signals.push({
        postId: post.id,
        type: signal,
        context: { surface: impression.feedDescriptor },
      });
      preferenceSignals.set(impression.userId, signals);

      try {
        // Deduped real view count. Returns the post's new total ONLY for the
        // first view of this (post, viewer) pair within the window, and null
        // otherwise (no-op without Redis / on duplicate).
        const countedViewsCount = await recordDedupedView(post.id, impression.userId);

        // Fold the dwell duration into the post's rolling average (opt-in
        // `dwellTime` ranking signal). Recorded ONCE per (post, viewer) — gated
        // on the deduped view counting a NEW view so repeated impressions can't
        // pump the mean — and CLAMPED so one forged sample can't dominate it.
        if (countedViewsCount !== null && dwellMs > 0) {
          await recordDwell(post.id, Math.min(dwellMs, MtnConfig.preferences.maxDwellMs));
        }
        return countedViewsCount;
      } catch (error) {
        logger.warn('[FeedInteractionTracker] Failed to apply impression signals', error);
        return null;
      }
    }),
  );

  for (const [userId, signals] of preferenceSignals) {
    try {
      await userPreferenceService.recordInteractions(userId, signals);
    } catch (error) {
      logger.warn('[FeedInteractionTracker] Failed to record preference signals', error);
    }
  }
  return counted;
}

/**
 * Emit the `feed_report_total{descriptor,origin}` metric for a report interaction.
 * Resolves the reported post's origin (federated vs local) with a single lean read
 * when the uri is a local post id; a non-local / unresolved uri is counted as
 * `local`. Best-effort — never fails the interaction record.
 *
 * Exported for unit testing; called only by {@link trackFeedInteractions}.
 */
export async function recordReportSignal(interaction: FeedInteractionData): Promise<void> {
  const postId = interaction.postUri;
  let federation: unknown;
  if (postId) {
    // `postUri` is client-supplied and is bound as a PARAMETER, so no
    // user-shaped value can alter the query's structure.
    const [post] = await getDb()
      .select({ isFederated: IS_FEDERATED })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    federation = post?.isFederated || null;
  }
  recordReport(interaction.feedDescriptor, originForFederation(federation));
}
