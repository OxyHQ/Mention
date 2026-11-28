/**
 * The one rule for reading a handle someone typed, linked or routed.
 *
 * A handle reaches Mention in many spellings — `@alice` from a URL segment,
 * `from:@alice` in a search, `@alice@host` in a fediverse mention tag, `alice`
 * from the session — and every reader must agree on what it names. These are
 * the only places the prefix is removed; callers do not write their own regex.
 */

/**
 * The handle without its leading `@` marks and surrounding whitespace, case
 * preserved: `' @@Alice '` → `'Alice'`, `'@alice@x.com'` → `'alice@x.com'`.
 *
 * Every leading `@` goes, not just one. A single `@` is the conventional
 * prefix; a doubled one is a typo or a prefixed value prefixed again, and no
 * handle anywhere begins with `@`, so there is nothing a stricter rule could
 * preserve. The domain of a federated handle is kept: only the PREFIX is
 * removed, never an `@host` suffix.
 *
 * Use this when the value is looked up, displayed or put back into a URL.
 * To compare two handles, use {@link handleKey}.
 */
export function stripHandlePrefix(handle: string): string {
  return handle.trim().replace(/^@+/, '').trim();
}

/**
 * The case-insensitive comparison key for a handle: {@link stripHandlePrefix}
 * lowercased. `'@Alice'`, `'alice'` and `' @ALICE'` share one key.
 *
 * Only for equality and cache keys — handles are matched case-insensitively,
 * but they are displayed as their owner spelled them, so never show or route
 * by this value.
 */
export function handleKey(handle: string): string {
  return stripHandlePrefix(handle).toLowerCase();
}

/**
 * An atproto handle: a DNS domain name (≥2 labels, e.g. `alice.bsky.social` or a
 * custom domain `example.com`). The TLD label must be alphabetic so a bare IP or
 * numeric form never matches.
 */
export const ATPROTO_HANDLE_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * True when `subject` is an atproto handle: a bare DNS name with no `@` (that is
 * a fediverse `user@host` acct), no URL scheme and no space.
 */
export function isAtprotoHandle(subject: string): boolean {
  if (subject.includes('@') || subject.includes('://') || subject.includes(' ')) return false;
  return ATPROTO_HANDLE_RE.test(subject);
}

/**
 * `@alice.bsky.social` is how Bluesky writes a handle, but the `@` is not part of
 * it. One leading `@` is dropped when what remains is an atproto handle; any
 * other query is returned trimmed and otherwise untouched (`@alice` stays a local
 * username, `@user@host` a fediverse acct).
 */
export function stripAtprotoHandlePrefix(raw: string): string {
  const query = raw.trim();
  const bare = query.replace(/^@/, '');
  return bare !== query && isAtprotoHandle(bare) ? bare : query;
}
