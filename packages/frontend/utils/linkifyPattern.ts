/**
 * The entity scan behind `components/common/LinkifiedText.tsx`.
 *
 * It lives here rather than in the component because it is pure data with no
 * React or React Native dependency, so which characters it accepts can be
 * asserted directly instead of through a rendered tree.
 *
 * The scan itself is `scanTextEntities` from `@mention/shared-types/textEntities`
 * — the same function the backend's extractor and the outbound-federation
 * linkifier call, so a tag that is STORED is also LINKED, and a URL that gets a
 * preview card is the same run of characters that gets the link. This module
 * only pins the OPTIONS the reading surface wants.
 */

import {
  createTextEntityPattern,
  scanTextEntities,
  type TextEntity,
} from '@mention/shared-types/textEntities';

/**
 * What `LinkifiedText` renders: the hydrated `[@Display](username)` mention form,
 * URLs including the bare `www.` shorthand, hashtags and cashtags.
 *
 * `mentionPlaceholder` is deliberately absent. A raw `[mention:<id>]` reaching
 * this component means hydration did not resolve it, and the existing behavior —
 * render the literal text — is correct: linkifying it would turn an unresolved
 * or hand-typed id into a profile link nobody authorized.
 */
const LINKIFY_KINDS = ['mentionDisplay', 'url', 'hashtag', 'cashtag'] as const;

/**
 * Locate every entity `LinkifiedText` should linkify, in reading order.
 *
 * Returns spans that partition the text along with the plain runs between them,
 * so the renderer walks the list emitting `text.slice(cursor, start)` and then
 * the entity.
 */
export function scanLinkifyEntities(text: string): TextEntity[] {
  return scanTextEntities(text, { kinds: LINKIFY_KINDS });
}

/**
 * The compiled pattern, exported ONLY so tests can assert on `.source`.
 *
 * That assertion is the Hermes gate: this regex is built at module load on a
 * phone, and Hermes has Unicode property escapes compiled out and throws on
 * every one of them — so a property escape here is a crash at boot that neither
 * a V8 test run nor `hermesc` reproduces. Checking the compiled source is the
 * only check that catches it before a device does.
 */
export const LINKIFY_PATTERN_SOURCE = createTextEntityPattern({ kinds: LINKIFY_KINDS }).source;
