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
