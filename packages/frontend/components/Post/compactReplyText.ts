/** Match Compose/backend's UTF-16 string length, including emoji surrogate pairs. */
export const COMPACT_REPLY_TEXT_LIMIT = 250;

/** Existing longer drafts stay intact and editable toward the limit, never silently truncated. */
export function acceptsCompactReplyText(current: string, next: string): boolean {
  return (
    next.length <= COMPACT_REPLY_TEXT_LIMIT ||
    (current.length > COMPACT_REPLY_TEXT_LIMIT && next.length <= current.length)
  );
}
