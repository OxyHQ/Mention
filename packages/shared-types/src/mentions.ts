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
 * Extract placeholder ids in first-occurrence order, without duplicates.
 */
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
 * Return only authorized ids that still have a placeholder in one of `texts`.
 *
 * Ordering follows the bodies rather than the incoming metadata, which makes
 * drafts and payloads deterministic while preserving the first occurrence.
 * Unknown placeholders are deliberately ignored: accepting them would let a
 * hand-typed `[mention:<id>]` create a notification without picker selection.
 */
export function reconcileMentionIds(
  texts: Iterable<string | null | undefined>,
  authorizedIds: unknown,
): string[] {
  const authorized = new Set(normalizeMentionIds(authorizedIds));
  if (authorized.size === 0) return [];

  const reconciled = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.includes('[mention:')) continue;
    for (const id of extractMentionIds(text)) {
      if (authorized.has(id)) reconciled.add(id);
    }
  }
  return [...reconciled];
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
