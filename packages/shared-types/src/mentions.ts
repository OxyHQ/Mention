/**
 * Canonical mention-placeholder helpers shared by every write boundary.
 *
 * A placeholder is only a stable reference in the body. It is NOT authority by
 * itself: callers must also supply the corresponding id in their mention
 * allowlist. Reconciliation therefore intersects the two sources instead of
 * inferring recipients from arbitrary text a user typed.
 */

import { scanTextEntities, stripTextEntities } from './textEntities';

/**
 * The placeholder form is defined ONCE, in `./textEntities`, alongside every
 * other inline entity — this module used to carry its own copy, and the
 * outbound-federation linkifier carried a third that differed on whether an id
 * could contain whitespace.
 */
const PLACEHOLDER_ONLY = ['mentionPlaceholder'] as const;

/**
 * Above this many DISTINCT mentioned users, a post is a broadcast rather than a
 * conversation, and it notifies NOBODY (see {@link isMentionBroadcast}).
 *
 * Measured against the reply-all pile-up that motivated this cap (the thread at
 * `annihilation.social`, 1,870 posts pulled from the origin's API): mentions per
 * post averaged 28.9 with a maximum of 34 — every post there addressed the whole
 * participant list. Ordinary conversation names a handful of people. 8 sits ~3.6x
 * below the measured pile-up mean, so the abusive population is nowhere near it,
 * while still leaving room for a genuine small-group thread.
 */
export const MAX_MENTION_NOTIFICATIONS_PER_POST = 8;

/**
 * Hard ceiling on how many DISTINCT mentions one post may CARRY — the containment
 * bound on stored ids, on hydration's per-post mention resolution, and (on the
 * federated ingest path) on how many remote actors one note may make us fetch.
 *
 * Deliberately twice {@link MAX_MENTION_NOTIFICATIONS_PER_POST}: carrying a mention
 * is not the same as ringing a phone. Between the two numbers a mention still
 * renders as a real profile link and still puts the post in that user's mentions
 * feed — it just does not notify. Above this ceiling the surplus mentions are
 * dropped, which for federated ingest means they degrade to the plain `@user` text
 * an unresolved mention has always produced. 16 is still well under the measured
 * 28.9 mean, so it genuinely binds on a pile-up instead of decorating it.
 */
export const MAX_MENTIONS_PER_POST = 2 * MAX_MENTION_NOTIFICATIONS_PER_POST;

/**
 * Max distinct PROFILE LINKS one body's mentions may be derived from — the
 * second source of mentions, beside the composer's picker.
 *
 * A profile link a body carries is folded into that post's real mentions when we
 * already store the identity it names, so a link-heavy post must not turn into an
 * unbounded burst of lookups (nor, since a resolved link becomes a real mention,
 * into an unbounded burst of notifications). Beyond the cap the surplus links
 * stay ordinary links, which is the pre-existing behavior for all of them.
 *
 * It lives HERE, next to {@link MAX_MENTIONS_PER_POST}, because three separate
 * places have to agree on it or the composer promises a mention the write
 * boundary will not store: the fold itself (`services/profileLinkMentions`), the
 * endpoint that answers "would this URL become a mention" for the composer, and
 * the composer's own candidate selection (`utils/composerProfileLinks`). This is
 * a ceiling, not the number of links a given body may resolve — that is narrowed
 * further by whatever headroom the body's existing mentions leave under
 * `MAX_MENTIONS_PER_POST`, since the two sources share ONE per-post ceiling.
 */
export const MAX_PROFILE_LINKS_PER_BODY = 8;

/**
 * Who a profile link will mention, named exactly as the published post will name
 * them — the handle and the label `PostHydrationService` writes when it renders
 * the `[mention:<id>]` the fold puts in the body.
 */
export interface ProfileLinkMentionIdentity {
  /** The Oxy user id that lands in `post.mentions`. */
  userId: string;
  /** Canonical handle — `username` locally, `username@domain` when federated. */
  handle: string;
  /** Display name, falling back to the handle when the account declares none. */
  displayName: string;
}

/** One URL's answer. */
export interface ProfileLinkMentionAnswer {
  /** The URL that was asked about, echoed so answers can be matched to inputs. */
  url: string;
  /**
   * Who it will mention, or `null` when it stays an ordinary link — because we
   * store no identity for it, or because the identity could not be named. `null`
   * is the safe direction: the caller says nothing rather than promising a
   * mention the write boundary would not make.
   */
  mention: ProfileLinkMentionIdentity | null;
}

/** Response of `POST /mentions/profile-links`. */
export interface ProfileLinkMentionsResponse {
  /** One answer per requested URL, in request order. */
  links: ProfileLinkMentionAnswer[];
}

/**
 * True when a post names so many people that it is a broadcast, not a conversation
 * — the single predicate every mention-notification decision consults.
 *
 * `distinctMentionCount` is the count for the POST, not for the subset of
 * recipients a given caller happens to hold: a federated note that mentions 30
 * people of whom one is local is still a broadcast, and that one local user must
 * not be the only person it rings.
 *
 * A broadcast notifies NOBODY rather than its first N mentions. Notifying the first
 * N reads as the safer option and is not: in a reply-all pile-up the mention list
 * is inherited from the parent and appended to, so whoever was named early stays
 * early in every one of the thousands of replies — "first N" would deliver
 * essentially the entire flood to exactly the people the cap exists to protect, and
 * silence only the most recent arrivals. It is also the weaker rule against abuse:
 * neither policy stops a targeted single notification (a sender simply keeps their
 * post at or under the cap), but "first N" additionally lets a 100-mention post
 * still ring N phones of the sender's choosing, pricing the abusive shape at a
 * discount instead of at zero. The cost of "nobody" is bounded and recoverable —
 * the mention itself is not lost, only the interrupt.
 */
export function isMentionBroadcast(distinctMentionCount: number): boolean {
  return distinctMentionCount > MAX_MENTION_NOTIFICATIONS_PER_POST;
}

/**
 * Extract placeholder ids in first-occurrence order, without duplicates.
 */
/**
 * Remove every `[mention:<id>]` placeholder from stored post text.
 *
 * A mention is STORED as a placeholder and rendered into a display form only at
 * hydration, so any consumer that reads the raw text sees `[mention:<id>]` and
 * not the `@handle` a reader sees. Anything that treats that text as prose must
 * strip it first, or it reads the literal word `mention` and a user id as if
 * the author had written them.

 * That is not hypothetical: trend extraction tokenized the placeholder and made
 * `mention` — this instance's own name — the network's biggest trending term,
 * carried by every post that replied to anybody.
 *
 * Replaces with a space rather than nothing, so the words either side of a
 * placeholder do not fuse into one.
 */
export function stripMentionPlaceholders(text: string): string {
  return stripTextEntities(text, { kinds: PLACEHOLDER_ONLY });
}

export function extractMentionIds(text: string): string[] {
  if (!text) return [];

  const ids = new Set<string>();
  for (const entity of scanTextEntities(text, { kinds: PLACEHOLDER_ONLY })) {
    if (entity.value) ids.add(entity.value);
  }
  return [...ids];
}

/**
 * Normalize a loosely typed mention allowlist into distinct, non-empty ids.
 *
 * Object support is intentionally retained for historical stored rows. New
 * clients send strings only.
 */
export function normalizeMentionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids = new Set<string>();
  for (const entry of value) {
    let id = '';
    if (typeof entry === 'string') {
      id = entry;
    } else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      id = String(record.id ?? record._id ?? '');
    }

    const normalized = id.trim();
    if (normalized) ids.add(normalized);
  }
  return [...ids];
}

/**
 * Return only authorized ids that still have a placeholder in one of `texts`,
 * capped at {@link MAX_MENTIONS_PER_POST}.
 *
 * Ordering follows the bodies rather than the incoming metadata, which makes
 * drafts and payloads deterministic while preserving the first occurrence — and it
 * is what makes the cap deterministic too: the kept set is the first N a reader
 * meets, not an arbitrary subset. Unknown placeholders are deliberately ignored:
 * accepting them would let a hand-typed `[mention:<id>]` create a notification
 * without picker selection.
 *
 * This is the one write boundary EVERY stored mention list passes through — native
 * compose, reply, boost-with-comment, both edit paths, and federated ingest — so it
 * is where the per-post ceiling has to hold. Without it a single 25,000-character
 * body could declare ~750 mentions and make hydration resolve 750 user summaries
 * for one post, every time it is rendered.
 *
 * A placeholder past the cut stays in the body and renders as its literal
 * `[mention:<id>]` text, exactly as an unauthorized placeholder always has (see the
 * rule above — this is why hand-typed placeholder text is already inert rather than
 * dangerous). Truncation therefore adds no rendering exposure that was not already
 * reachable by typing the same characters.
 */
export function reconcileMentionIds(
  texts: Iterable<string | null | undefined>,
  authorizedIds: unknown,
): string[] {
  return reconcileMentionIdsDetailed(texts, authorizedIds).ids;
}

/**
 * {@link reconcileMentionIds} plus the pre-cap `total`, for callers that must be
 * able to SAY that a post's mentions were truncated.
 *
 * The capped list alone cannot tell you: a post that legitimately names exactly
 * `MAX_MENTIONS_PER_POST` people and one that named 700 both come back the same
 * length. Since this module is shared with the client it cannot log, so it reports
 * instead — the server logs off `total` (see `reconcileMentionIdsForPost`). Without
 * this the cap would be exactly the silent drop it exists to prevent.
 */
export function reconcileMentionIdsDetailed(
  texts: Iterable<string | null | undefined>,
  authorizedIds: unknown,
): { ids: string[]; total: number } {
  const authorized = new Set(normalizeMentionIds(authorizedIds));
  if (authorized.size === 0) return { ids: [], total: 0 };

  const reconciled = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.includes('[mention:')) continue;
    for (const id of extractMentionIds(text)) {
      if (authorized.has(id)) reconciled.add(id);
    }
  }
  return {
    ids: [...reconciled].slice(0, MAX_MENTIONS_PER_POST),
    total: reconciled.size,
  };
}

/**
 * Visit each rendition that can authoritatively mention someone, handing the
 * visitor a setter for that same slot.
 *
 * Author variants are the stored source of truth. `content.text` is considered
 * only when there are no author variants (the client write convenience shape).
 * Machine translations never create notification recipients.
 *
 * READ AND WRITE GO THROUGH ONE SELECTION, on purpose. A write boundary that
 * derives a mention from a body has to change that body too — the id it stores
 * only renders if a `[mention:<id>]` placeholder sits in the text, and
 * {@link reconcileMentionIds} drops any id that has none. Two functions, one
 * choosing which renditions may mention and another choosing which to rewrite,
 * would be one edit away from disagreeing and silently dropping the mention they
 * had just authorized. So there is one traversal and both callers walk it.
 */
function forEachMentionText(
  content: unknown,
  visit: (text: string, assign: (next: string) => void) => void,
): void {
  if (!content || typeof content !== 'object') return;
  const record = content as Record<string, unknown>;
  const variants = Array.isArray(record.variants) ? record.variants : [];

  let sawAuthorVariant = false;
  for (const entry of variants) {
    if (!entry || typeof entry !== 'object') continue;
    const variant = entry as Record<string, unknown>;
    if (variant.source === 'machine' || typeof variant.text !== 'string') continue;
    sawAuthorVariant = true;
    visit(variant.text, (next) => {
      variant.text = next;
    });
  }
  if (sawAuthorVariant) return;

  if (typeof record.text === 'string') {
    visit(record.text, (next) => {
      record.text = next;
    });
  }
}

/**
 * Text renditions that can authoritatively mention someone.
 *
 * Author variants are the stored source of truth. `content.text` is considered
 * only when there are no author variants (the client write convenience shape).
 * Machine translations never create notification recipients.
 */
export function mentionTextsFromContent(content: unknown): string[] {
  const texts: string[] = [];
  forEachMentionText(content, (text) => {
    texts.push(text);
  });
  return texts;
}

/**
 * Rewrite, IN PLACE, exactly the renditions {@link mentionTextsFromContent}
 * reads. Returns true when any of them actually changed.
 *
 * In place rather than returning a copy because the callers hold the content
 * they are about to persist — a plain body being assembled, or the content of a
 * post already loaded, with its author variants — and neither can accept a
 * foreign replacement without the caller knowing which one it is holding.
 */
export function mapMentionTexts(
  content: unknown,
  transform: (text: string) => string,
): boolean {
  let changed = false;
  forEachMentionText(content, (text, assign) => {
    const next = transform(text);
    if (next === text) return;
    assign(next);
    changed = true;
  });
  return changed;
}
