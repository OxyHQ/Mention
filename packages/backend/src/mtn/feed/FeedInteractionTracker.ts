/**
 * FeedInteractionTracker
 *
 * Tracks feed impressions, clicks, and engagement for feed quality improvement.
 * AT Protocol equivalent: app.bsky.feed.sendInteractions
 */

import { MtnConfig, PostVisibility } from '@mention/shared-types';
import type { FeedInteractionEventName } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';

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
import { userPreferenceService } from '../../services/UserPreferenceService';
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
 * Record feed interactions for analytics and ranking feedback.
 * Writes to the FeedInteraction model asynchronously.
 */
export async function trackFeedInteraction(interaction: FeedInteractionData): Promise<void> {
  try {
    // Lazy import to avoid circular dependency at module load time
    const { FeedInteraction } = await import('../../models/FeedInteraction');
    await FeedInteraction.create({
      userId: interaction.userId,
      feedDescriptor: interaction.feedDescriptor,
      postUri: interaction.postUri,
      event: interaction.event,
      durationMs: interaction.durationMs,
      createdAt: interaction.timestamp,
    });
  } catch (error) {
    // Non-critical — log and move on
    logger.warn('[FeedInteractionTracker] Failed to record interaction', error);
  }

  // An impression carries TWO derived signals beyond the raw analytics row:
  //   1. a deduped increment of the post's real view count (ranking input), and
  //   2. a UserBehavior learning signal — a genuine `view` when the post was
  //      dwelled on, or a negative `skip` when it was scrolled past quickly.
  // Both are best-effort and MUST NOT fail the interaction record above, so they
  // run after it and swallow-then-log their own errors.
  if (interaction.event === 'impression') {
    applyImpressionSignals(interaction).catch((error) => {
      logger.warn('[FeedInteractionTracker] Failed to apply impression signals', error);
    });
  } else if (interaction.event === 'report') {
    // A report is a strong negative feed signal — count it (split by origin) so
    // report-per-impression can be tracked online and per A/B cohort offline.
    recordReportSignal(interaction).catch((error) => {
      logger.warn('[FeedInteractionTracker] Failed to record report signal', error);
    });
  }
}

/**
 * Apply the deduped view-count increment and the UserBehavior learning signal
 * for a feed impression. `postUri` is the local post id (Mongo `_id` string);
 * federated/non-local uris that are not valid ObjectIds are skipped.
 *
 * Impression telemetry is CLIENT-controlled, so its side effects are hardened
 * against ranking manipulation:
 *   - the post is resolved to a real public+published local post (author
 *     included) before any side effect runs;
 *   - a viewer's OWN posts record NO view/dwell/preference learning, so an author
 *     cannot self-pump their own ranking signals;
 *   - the dwell sample is CLAMPED to `MtnConfig.preferences.maxDwellMs` and folded
 *     into the rolling average AT MOST ONCE per (post, viewer) — only when the
 *     deduped view counted a NEW view — so a forged/repeated impression cannot
 *     dominate or inflate the average.
 *
 * Exported for unit testing; called only by {@link trackFeedInteraction}.
 */
export async function applyImpressionSignals(interaction: FeedInteractionData): Promise<void> {
  const postId = interaction.postUri;
  if (!postId) {
    return; // Nothing to count or learn from.
  }

  // Client telemetry is untrusted: only derive view/preference side effects for
  // real public, published local posts. Resolving the post here also yields its
  // author (self-pumping guard below) and its federation columns (the impression
  // origin label). The id is a bound parameter against a `text` column, so a
  // `postUri` that is not a local post id — a federated URI, or anything else a
  // client invents — simply matches no row; the ObjectId pre-check this replaces
  // would have discarded every post created since the cutover instead.
  const [post] = await getDb()
    .select({ oxyUserId: posts.oxyUserId, isFederated: IS_FEDERATED })
    .from(posts)
    .where(and(
      eq(posts.id, postId),
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
    ))
    .limit(1);
  if (!post) {
    return;
  }

  // Self-pumping guard: a viewer impressing their OWN post must not move any
  // ranking/learning signal (view count, dwell average, or affinity), otherwise
  // an author could inflate their own reach by re-viewing their posts. Self-views
  // are also excluded from the impression metrics so they never skew the
  // engagement-per-impression denominator.
  if (post.oxyUserId && post.oxyUserId === interaction.userId) {
    return;
  }

  // Online metric: a genuine third-party impression, split by federated vs local
  // origin (the denominator for engagement- and report-per-impression).
  recordImpression(interaction.feedDescriptor, originForFederation(post.isFederated || null));

  // 1. Deduped real view count. Returns true ONLY for the first view of this
  //    (post, viewer) pair within the window (no-op without Redis / on duplicate).
  const countedNewView = await recordDedupedView(postId, interaction.userId);

  // 2. UserBehavior signal. A short dwell is a SKIP (negative); a real dwell is
  //    a VIEW (mild positive). The frontend only reports impressions that passed
  //    its visibility gate, so `durationMs` is the accrued visible time. The
  //    originating feed is forwarded as the attribution surface so a video-feed
  //    view is attributed to video content, not the author.
  const dwellMs = interaction.durationMs ?? 0;
  const signal = dwellMs > 0 && dwellMs < MtnConfig.preferences.dwellSkipThresholdMs ? 'skip' : 'view';
  // Online metric: the derived view/skip signal for this impression.
  recordInteractionSignal(signal, interaction.feedDescriptor);
  await userPreferenceService.recordInteraction(interaction.userId, postId, signal, {
    surface: interaction.feedDescriptor,
  });

  // 3. Fold the dwell duration into the post's rolling average (opt-in
  //    `dwellTime` ranking signal). Recorded ONCE per (post, viewer) — gated on
  //    the deduped view counting a NEW view so repeated impressions can't pump
  //    the mean — and CLAMPED so one forged sample can't dominate it.
  if (countedNewView && dwellMs > 0) {
    await recordDwell(postId, Math.min(dwellMs, MtnConfig.preferences.maxDwellMs));
  }
}

/**
 * Emit the `feed_report_total{descriptor,origin}` metric for a report interaction.
 * Resolves the reported post's origin (federated vs local) with a single lean read
 * when the uri is a local post id; a non-local / unresolved uri is counted as
 * `local`. Best-effort — never fails the interaction record.
 *
 * Exported for unit testing; called only by {@link trackFeedInteraction}.
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
