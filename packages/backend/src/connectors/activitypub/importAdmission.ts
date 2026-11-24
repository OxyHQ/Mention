import { MtnConfig } from '@mention/shared-types';
import { computeDeterministicScores } from '../../services/contentClassification/spamQuality';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { xTimelineHandle } from './xTimeline';
import { extractApContentHtml } from './apPostContent';

/**
 * WHICH ACCOUNTS THE DISCOVERY BACKFILL COPIES, AND HOW MUCH OF THEM.
 *
 * The discovery backfill walks every resolved remote account, newest-unvisited
 * first, and copies its 100 most recent posts. Measured on 2026-11-24 on the
 * import ledger, that road was 22% of all imports and, with profile views, the
 * bulk of ~300k imported posts a day, while accounts a local user follows were
 * about 0.2% of imports. Each import is several writes on a database that had
 * run out of I/O credit, to fill For You with posts nobody asked for.
 *
 * The rule, in the owner's words: an account a local user FOLLOWS is copied in
 * full (it is not touched here); any other account is on PROBATION, a few posts
 * that let its content speak for itself, filtered by what the content is rather
 * than by how many followers it claims. Followers do not measure quality.
 *
 * Pure policy with no I/O, like `repostTransportPolicy.ts`; the callers supply
 * the one fact it cannot know (whether a local user follows the account).
 */

/** Posts copied from an account no local user follows. */
export const PROBATION_POST_LIMIT = 20;

export interface ActorAdmission {
  /** Posts to copy at most (the walk stops there). */
  limit: number;
  /** True when the account is not copied at all by discovery. */
  skip: boolean;
  /** True when each note is judged on its content before it is stored. */
  filterContent: boolean;
}

/**
 * How the discovery backfill treats one account.
 *
 * - Followed by a local user: the full `fullLimit`, nothing filtered.
 * - An X account through a bridge, not followed: skipped. A bridge account is
 *   a whole timeline a person chose to follow on X, not here, and the bridge
 *   delivers it as one post per tweet and retweet.
 * - Anyone else: {@link PROBATION_POST_LIMIT} posts, content-filtered.
 */
export function discoveryAdmission(input: {
  followedLocally: boolean;
  actorUri: string;
  fullLimit: number;
}): ActorAdmission {
  if (input.followedLocally) {
    return { limit: input.fullLimit, skip: false, filterContent: false };
  }
  if (xTimelineHandle(input.actorUri) !== undefined) {
    return { limit: 0, skip: true, filterContent: false };
  }
  return {
    limit: Math.min(input.fullLimit, PROBATION_POST_LIMIT),
    skip: false,
    filterContent: true,
  };
}

/**
 * Whether a note is worth storing, on its text alone: not empty, emoji-only or
 * link-only (low quality) and not confidently spam. Uses the discovery gate's own
 * thresholds, so the import and For You never disagree on what is junk.
 */
export function isWorthImporting(
  note: Record<string, unknown>,
  actor: { type?: string; domain?: string },
): boolean {
  const text = htmlToPlainText(extractApContentHtml(note));
  const { spam, quality } = computeDeterministicScores(text, 0, {
    actorType: actor.type,
    instanceDomain: actor.domain,
    isFederated: true,
  });
  const gate = MtnConfig.feed.discoveryGate;
  return spam < gate.spamRejectThreshold && quality > gate.qualityRejectThreshold;
}
