/**
 * Canonical mention-placeholder helpers shared by every write boundary.
 *
 * A placeholder is only a stable reference in the body. It is NOT authority by
 * itself: callers must also supply the corresponding id in their mention
 * allowlist. Reconciliation therefore intersects the two sources instead of
 * inferring recipients from arbitrary text a user typed.
 */

const MENTION_PLACEHOLDER_PATTERN = /\[mention:([^\]\s]+)\]/g;

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
  return text.replace(MENTION_PLACEHOLDER_PATTERN, ' ');
}

export function extractMentionIds(text: string): string[] {
  if (!text) return [];

  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION_PLACEHOLDER_PATTERN)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
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
 * Text renditions that can authoritatively mention someone.
 *
 * Author variants are the stored source of truth. `content.text` is considered
 * only when there are no author variants (the client write convenience shape).
 * Machine translations never create notification recipients.
 */
export function mentionTextsFromContent(content: unknown): string[] {
  if (!content || typeof content !== 'object') return [];
  const record = content as Record<string, unknown>;
  const variants = Array.isArray(record.variants) ? record.variants : [];

  const authorTexts = variants.flatMap((entry): string[] => {
    if (!entry || typeof entry !== 'object') return [];
    const variant = entry as Record<string, unknown>;
    if (variant.source === 'machine' || typeof variant.text !== 'string') return [];
    return [variant.text];
  });
  if (authorTexts.length > 0) return authorTexts;

  return typeof record.text === 'string' ? [record.text] : [];
}
