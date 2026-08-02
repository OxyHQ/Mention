/**
 * The single compiled pattern behind `components/common/LinkifiedText.tsx`.
 *
 * It lives here rather than in the component for the same reason
 * {@link URL_PATTERN_SOURCE} does: it is pure data with no React or React Native
 * dependency, so which characters it accepts can be asserted directly instead of
 * through a rendered tree.
 */

import { HASHTAG_BODY_SOURCE, HASHTAG_BOUNDARY_SOURCE } from '@mention/shared-types/hashtags';
import { URL_PATTERN_SOURCE } from './extractUrls';

/**
 * Matches every inline entity `LinkifiedText` renders, in one pass:
 *
 *   1) Mentions in the backend's `[@DisplayName](username)` form
 *   2) URLs: `http(s)://…` or `www.…` (shared source from `./extractUrls`)
 *   3) Entities preceded by a word boundary capture: hashtags and cashtags
 *
 * Compiled once at module scope (the source is static) so re-rendering many
 * LinkifiedText rows never re-`new RegExp(...)`. The global flag keeps
 * `lastIndex` state, so every caller must reset it before scanning and drain the
 * loop to completion (`exec` → null resets it to 0).
 *
 * The hashtag alternative and its word boundary come from
 * `@mention/shared-types/hashtags` — the same source the backend extractor and
 * the outbound-federation linkifier compile, so a tag that is STORED is also
 * LINKED. It accepts letters of any script, which is what
 * `#BundesländerTurnier` needs; the old `#[A-Za-z][A-Za-z0-9_]*` stopped dead at
 * the `ä` and linked only `#Bundesl`.
 *
 * `u` is required — the shared class bodies carry astral `\u{…}` escapes — and
 * is safe for the rest of the pattern, whose mention, URL and cashtag
 * alternatives already use only escapes that are legal in u-mode. Those class
 * bodies are explicit code-point RANGES, never Unicode property escapes,
 * because this regex is built at module load on Hermes, which has property
 * escapes compiled out and would throw at boot.
 */
export const LINKIFY_PATTERN = new RegExp(
  `(\\[@([^\\]]+)\\]\\(([^)]+)\\))|(${URL_PATTERN_SOURCE})|(^|${HASHTAG_BOUNDARY_SOURCE})(#${HASHTAG_BODY_SOURCE}|\\$[A-Z]{1,6}(?:\\.[A-Z]{1,2})?)`,
  'gu',
);
