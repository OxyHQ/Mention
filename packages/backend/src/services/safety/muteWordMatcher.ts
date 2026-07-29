/**
 * Muted-words matching — the SINGLE definition of "this viewer muted this post",
 * shared by every read surface that shows a viewer other people's content.
 *
 * Why this exists: the mute-word predicate used to live INSIDE the feed tuner
 * (`mtn/feed/tuners/filterMuteWords`), so it applied to feeds and nowhere else — a
 * user who muted a word still saw it in search results and in their notifications.
 * A mute is a per-viewer safety rule, not a feed feature, so the rule lives here
 * and each surface calls it. Adding a scope (a new target, an expiry) updates every
 * surface at once, and no surface can silently diverge.
 *
 * The matcher is PURE: compile a viewer's rules once per request
 * ({@link compileMuteWords}), then test each candidate ({@link isMutedSubject}).
 * Loading the rules from Mongo lives in {@link ./viewerSafety} so this module stays
 * trivially unit-testable.
 *
 * Scope honored (mirrors the `MuteWord` model — there is no expiry field):
 *   - `targets`: `'content'` matches the post's visible text, `'tag'` matches its
 *     hashtags. A rule can carry either or both.
 *   - `actorTarget`: `'all'` applies to every author; `'exclude-following'` applies
 *     ONLY to authors the viewer does not follow. Because the second kind needs the
 *     viewer's follow graph, {@link CompiledMuteWords.needsFollowState} tells the
 *     caller whether that (potentially remote) lookup is worth doing at all — it is
 *     `false` for the overwhelming majority of viewers, who have no such rule.
 */

import { escapeRegex } from '../../utils/textProcessing';

/** What part of a post a muted entry matches against. */
export type MuteTarget = 'content' | 'tag';

/** Which authors a muted entry applies to. */
export type MuteActorTarget = 'all' | 'exclude-following';

/**
 * One stored muted entry, in the shape every surface loads it in. Mirrors the
 * persisted `MuteWord` fields the matcher actually reads.
 */
export interface MuteWordRule {
  value: string;
  targets: MuteTarget[];
  actorTarget: MuteActorTarget;
}

/**
 * The post fields the matcher reads. `text` is the rendition the viewer is being
 * served (so a muted word is caught in the body they would actually see), and
 * `hashtags` the post's canonical tags. `authorId` is only consulted for
 * `exclude-following` rules.
 */
export interface MuteWordSubject {
  text?: string | null;
  hashtags?: readonly string[] | null;
  authorId?: string | null;
}

/** One compiled bucket of rules: content regexes plus lowercase tag values. */
interface MuteWordBucket {
  contentPatterns: RegExp[];
  tagValues: Set<string>;
}

/** A viewer's muted entries, compiled once per request. */
export interface CompiledMuteWords {
  /** Rules that apply to every author (`actorTarget: 'all'`). */
  readonly always: MuteWordBucket;
  /** Rules that apply only when the viewer does NOT follow the author. */
  readonly nonFollowedOnly: MuteWordBucket;
  /**
   * Whether any `exclude-following` rule was compiled. When `false` the caller can
   * pass {@link NO_FOLLOWED_AUTHORS} and skip resolving the viewer's follow graph
   * entirely — matching is then independent of who they follow.
   */
  readonly needsFollowState: boolean;
}

/**
 * The empty follow set. Callers pass this when
 * {@link CompiledMuteWords.needsFollowState} is `false`, which makes the absent
 * follow graph provably irrelevant rather than an implicit default.
 */
export const NO_FOLLOWED_AUTHORS: ReadonlySet<string> = new Set<string>();

/**
 * Compile one muted value into a case-insensitive content pattern.
 *
 * The value is matched on word boundaries so muting `art` does not also mute
 * `heart` — but a `\b` is added only on a side where the value itself starts/ends
 * with a word character. Anchoring `c++` as `\bc\+\+\b` could never match anything
 * (there is no word boundary after `+`), which would leave the rule silently dead.
 */
function toContentPattern(value: string): RegExp {
  const leading = /^\w/.test(value) ? '\\b' : '';
  const trailing = /\w$/.test(value) ? '\\b' : '';
  return new RegExp(`${leading}${escapeRegex(value)}${trailing}`, 'i');
}

function emptyBucket(): MuteWordBucket {
  return { contentPatterns: [], tagValues: new Set<string>() };
}

function isBucketEmpty(bucket: MuteWordBucket): boolean {
  return bucket.contentPatterns.length === 0 && bucket.tagValues.size === 0;
}

/**
 * Compile a viewer's muted entries into a matcher.
 *
 * Returns `null` when there is nothing to match (no rules, or rules whose values
 * are all blank) so callers can skip the whole filtering step — and, with it, any
 * follow-graph lookup — on the common path.
 */
export function compileMuteWords(rules: readonly MuteWordRule[] | undefined | null): CompiledMuteWords | null {
  if (!rules || rules.length === 0) return null;

  const always = emptyBucket();
  const nonFollowedOnly = emptyBucket();

  for (const rule of rules) {
    const value = typeof rule.value === 'string' ? rule.value.trim() : '';
    if (!value) continue;

    const bucket = rule.actorTarget === 'exclude-following' ? nonFollowedOnly : always;
    const targets = Array.isArray(rule.targets) ? rule.targets : [];
    if (targets.includes('content')) {
      bucket.contentPatterns.push(toContentPattern(value));
    }
    if (targets.includes('tag')) {
      // Stored tag values are already lowercase (`normalizeMuteValue`); lowercasing
      // again keeps a legacy row matching the lowercase canonical post hashtags.
      bucket.tagValues.add(value.toLowerCase());
    }
  }

  if (isBucketEmpty(always) && isBucketEmpty(nonFollowedOnly)) return null;

  return { always, nonFollowedOnly, needsFollowState: !isBucketEmpty(nonFollowedOnly) };
}

function bucketMatches(bucket: MuteWordBucket, subject: MuteWordSubject): boolean {
  if (bucket.contentPatterns.length > 0) {
    const text = typeof subject.text === 'string' ? subject.text : '';
    if (text && bucket.contentPatterns.some((pattern) => pattern.test(text))) return true;
  }

  if (bucket.tagValues.size > 0) {
    const hashtags = subject.hashtags;
    if (Array.isArray(hashtags) && hashtags.some((tag) => bucket.tagValues.has(String(tag).toLowerCase()))) {
      return true;
    }
  }

  return false;
}

/**
 * Whether this post is muted for the viewer whose rules were compiled.
 *
 * `followedAuthorIds` is REQUIRED rather than optional: an `exclude-following` rule
 * cannot be evaluated without it, and an implicit default would silently resolve
 * that ambiguity one way or the other at every call site. Callers that know the
 * follow graph is irrelevant (`needsFollowState === false`) pass
 * {@link NO_FOLLOWED_AUTHORS}.
 */
export function isMutedSubject(
  compiled: CompiledMuteWords | null,
  subject: MuteWordSubject,
  followedAuthorIds: ReadonlySet<string>,
): boolean {
  if (!compiled) return false;

  if (bucketMatches(compiled.always, subject)) return true;

  if (compiled.needsFollowState) {
    const authorId = subject.authorId;
    const isFollowed = typeof authorId === 'string' && authorId.length > 0 && followedAuthorIds.has(authorId);
    if (!isFollowed && bucketMatches(compiled.nonFollowedOnly, subject)) return true;
  }

  return false;
}
