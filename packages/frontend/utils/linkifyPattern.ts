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
 * pins the OPTIONS the reading surface wants, and adds the one thing that is
 * purely a reading decision: a URL pointing at a profile on THIS instance is
 * shown as a mention rather than as a URL (see {@link asOwnProfileMention}).
 */

import {
  createTextEntityPattern,
  scanTextEntities,
  trimUrlTrailingPunctuation,
  type TextEntity,
} from '@mention/shared-types/textEntities';
import { ownProfileLinkHandle } from '@/utils/ownProfileLinks';

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
 * A URL that names a profile on THIS instance, re-read as the mention it is.
 *
 * Somebody who pastes `https://mention.earth/@alice` into a post has written
 * alice's name; showing them a naked URL is showing them the plumbing. So the
 * span is re-labelled as a mention and renders like every other mention.
 *
 * This is a RENDERING, and only a rendering. It creates no mention record, adds
 * nobody to the post's `mentions` allowlist, notifies nobody, and does not touch
 * what the author stored — the conversion happens here, downstream of everything
 * that decides who a post addresses, precisely so it cannot. Pasting a link is
 * not the same act as picking somebody out of the mention picker, and this must
 * never make it one.
 *
 * Only OUR OWN host converts, and that is the entire safety argument: for a URL
 * on this instance the mention and the link have the SAME destination (`/@alice`
 * is the page `https://<us>/@alice` serves), so there is no new way to be wrong —
 * a handle nobody holds was already a link to a profile page nobody holds. A
 * fediverse or upstream profile URL on ANY other host is a different question,
 * because whether we hold that account is not answerable from the characters, and
 * a mention of somebody we cannot resolve is worse than the link it replaced. See
 * the inbound-ingest path (`apMentions.ts`), which answers it at write time and
 * against stored identities.
 *
 * The label carries the `@` itself: a hydrated mention's label is the mentioned
 * user's display name, and we do not have one here — only the handle. That is the
 * same `displayName || handle` fallback hydration applies when a user has no
 * display name, so the two agree.
 */
function asOwnProfileMention(entity: TextEntity): TextEntity {
  if (entity.kind !== 'url') return entity;

  // Punctuation that merely trailed the URL is not part of it. Cutting the span
  // short here is also what leaves that punctuation in the text: the renderer
  // emits everything between two entities as prose, so the `.` in
  // `…/@alice.` needs no further handling.
  const { url } = trimUrlTrailingPunctuation(entity.value);
  if (!url) return entity;

  const handle = ownProfileLinkHandle(url);
  if (!handle) return entity;

  return {
    kind: 'mentionDisplay',
    raw: url,
    start: entity.start,
    end: entity.start + url.length,
    value: handle,
    label: `@${handle}`,
  };
}

/**
 * Locate every entity `LinkifiedText` should linkify, in reading order.
 *
 * Returns spans that partition the text along with the plain runs between them,
 * so the renderer walks the list emitting `text.slice(cursor, start)` and then
 * the entity.
 */
export function scanLinkifyEntities(text: string): TextEntity[] {
  return scanTextEntities(text, { kinds: LINKIFY_KINDS }).map(asOwnProfileMention);
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
