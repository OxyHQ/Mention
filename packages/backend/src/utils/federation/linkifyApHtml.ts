import { scanTextEntities, trimUrlTrailingPunctuation } from '@mention/shared-types/textEntities';
import { escapeApHtml, escapeApHtmlAttr, normalizeApBody, wrapApParagraphs } from './plainTextToApHtml';

/**
 * A resolved @mention link: the actor `href` (the anchor target AND the Note's
 * `Mention` tag href) and the visible handle WITHOUT the leading `@` (`alice` for
 * a local user, `bob@remote.social` for a federated one). Built by the async
 * caller (`FollowService.resolveMentionContext`) from the post's declared
 * `mentions` ids; the pure linkifier only RENDERS it.
 */
export interface ApMentionLink {
  /** Actor href — a local minted actor URL or a remote actor URI. */
  href: string;
  /** Visible handle, no leading `@`: `alice` (local) or `bob@remote.social` (federated). */
  handle: string;
}

/** Options for {@link linkifyApHtml}. */
export interface LinkifyApHtmlOptions {
  /**
   * Resolved mention links keyed by the placeholder's Oxy user id. A
   * `[mention:<id>]` whose id is ABSENT here (undeclared, or unresolvable) is
   * DROPPED — the internal placeholder must never survive into federated
   * `content`. Omit the whole map to drop every placeholder.
   */
  mentions?: ReadonlyMap<string, ApMentionLink>;
  /**
   * Build the href for a `#hashtag` anchor from the RAW captured tag (no `#`). The
   * caller supplies this so a content `#tag` and its machine-readable `Hashtag`
   * tag point at the same URL (both go through the same `hashtagUrl` helper). When
   * omitted, hashtags stay plain (escaped) text.
   */
  hashtagHref?: (rawTag: string) => string;
}

/**
 * The three inline reference kinds a Mention post body carries, as the shared
 * scanner names them. Precedence — URL before hashtag, so a `#fragment` inside a
 * link is consumed by the link and never re-matched as a tag — is fixed inside
 * `scanTextEntities`, which is the point of it living there.
 *
 *  - `url`               a bare `http(s)://…` run
 *  - `mentionPlaceholder` the id inside a `[mention:<id>]` placeholder
 *  - `hashtag`           the tag text after `#`
 *
 * `urlTerminator: 'html'` stops a URL run at `<` as well as at whitespace: the
 * output of this function is HTML, so a run that swallowed a following tag would
 * put markup inside an `href`.
 *
 * `bareWww: false` — a scheme-less `www.…` is not linkified outbound. The anchor
 * this builds is consumed by other servers, so a synthesized `https://` on
 * something the author never wrote as a link is a guess this path should not
 * make on their behalf.
 *
 * Cashtags are absent: they resolve to a Mention search route that means nothing
 * on a remote instance.
 */
const AP_ENTITY_KINDS = ['url', 'mentionPlaceholder', 'hashtag'] as const;

/** Mastodon-compatible mention anchor. `href` is attribute-escaped, label is text-escaped. */
function mentionAnchor(link: ApMentionLink): string {
  return `<a href="${escapeApHtmlAttr(link.href)}" class="u-url mention">@${escapeApHtml(link.handle)}</a>`;
}

/** Mastodon-compatible hashtag anchor (`class="mention hashtag" rel="tag"`). */
function hashtagAnchor(rawTag: string, href: string): string {
  return `<a href="${escapeApHtmlAttr(href)}" class="mention hashtag" rel="tag">#${escapeApHtml(rawTag)}</a>`;
}

/** Bare-URL anchor — the same string is the (attribute-escaped) href and (text-escaped) label. */
function urlAnchor(url: string): string {
  return `<a href="${escapeApHtmlAttr(url)}">${escapeApHtml(url)}</a>`;
}

/**
 * Convert an author-written PLAIN-TEXT post body into safe ActivityPub `content`
 * HTML, LINKIFYING @mentions, #hashtags and bare URLs — the body transform the
 * Note builder uses so a federated post never ships an internal `[mention:<id>]`
 * placeholder (and so `#tags`/URLs render as links on Mastodon).
 *
 * ESCAPING (the correctness core — no naive chained replaces over escaped text):
 * the raw body is tokenized into spans (plain text | mention placeholder | URL |
 * hashtag). ONLY plain-text spans and the VISIBLE label of each link are
 * HTML-escaped, and every `href` is attribute-escaped; the anchors are assembled
 * from those already-safe pieces. Nothing is ever escaped twice, and an injected
 * anchor is never re-escaped.
 *
 * PARAGRAPHING composes AROUND linkification: the escaped-and-linkified body is
 * then run through the SAME `<p>`/`<br>` structuring as {@link plainTextToApHtml}
 * (blank line → new paragraph, single newline → `<br>`). Anchors carry no newline,
 * so the newline-based split only ever cuts at plain-text boundaries.
 *
 * Pure and side-effect free. An empty/whitespace-only body returns `''`.
 */
export function linkifyApHtml(text: string, options: LinkifyApHtmlOptions = {}): string {
  const normalized = normalizeApBody(text);
  if (normalized.length === 0) return '';

  const { mentions, hashtagHref } = options;

  let out = '';
  let cursor = 0;

  const entities = scanTextEntities(normalized, {
    kinds: AP_ENTITY_KINDS,
    urlTerminator: 'html',
    bareWww: false,
  });

  for (const entity of entities) {
    // Plain text between the previous token and this one — escaped as element text.
    if (entity.start > cursor) out += escapeApHtml(normalized.slice(cursor, entity.start));

    if (entity.kind === 'url') {
      const { url, trailing } = trimUrlTrailingPunctuation(entity.value);
      out += urlAnchor(url);
      if (trailing) out += escapeApHtml(trailing);
    } else if (entity.kind === 'mentionPlaceholder') {
      // Resolved → a mention anchor. Undeclared/unresolvable → DROP: the internal
      // `[mention:<id>]` placeholder must never leak to the wire.
      const link = mentions?.get(entity.value);
      if (link) out += mentionAnchor(link);
    } else if (entity.kind === 'hashtag') {
      const href = hashtagHref?.(entity.value);
      out += href ? hashtagAnchor(entity.value, href) : escapeApHtml(entity.raw);
    }

    cursor = entity.end;
  }

  if (cursor < normalized.length) out += escapeApHtml(normalized.slice(cursor));

  return wrapApParagraphs(out);
}
