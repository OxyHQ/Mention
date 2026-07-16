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
 * Left-to-right token scanner for the three inline reference kinds a Mention post
 * body carries. URL is tried FIRST so a `#fragment` (or any trailing text) inside
 * a link is consumed by the URL token and never re-matched as a hashtag.
 *  - `url`       — a bare `http(s)://…` run (up to whitespace or `<`)
 *  - `mentionId` — the id inside a `[mention:<id>]` placeholder
 *  - `hashtag`   — the tag text after `#` (ASCII word chars, mirroring the stored
 *                  hashtag extraction so a content `#tag` matches the `tag` array)
 */
const TOKEN_REGEX = /(?<url>https?:\/\/[^\s<]+)|\[mention:(?<mentionId>[^\]]+)\]|#(?<hashtag>[A-Za-z0-9_]+)/g;

/**
 * Sentence punctuation that is almost never part of a URL and should stay OUTSIDE
 * the link. A closing paren is handled separately (only trimmed when unbalanced),
 * so a Wikipedia-style `…_(disambiguation)` URL survives intact.
 */
const TRAILING_URL_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '’', '”', '»']);

/**
 * Split a raw matched URL run into the real URL and any trailing prose punctuation
 * (`see https://x.com.` → the `.` is a sentence end, not part of the URL). The
 * trimmed suffix is re-emitted as escaped plain text by the caller.
 */
function splitTrailingUrlPunctuation(raw: string): { url: string; trailing: string } {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (ch === ')') {
      const head = raw.slice(0, end);
      const opens = (head.match(/\(/g) ?? []).length;
      const closes = (head.match(/\)/g) ?? []).length;
      if (closes <= opens) break; // balanced → the ')' belongs to the URL
    } else if (!TRAILING_URL_PUNCTUATION.has(ch)) {
      break;
    }
    end -= 1;
  }
  return { url: raw.slice(0, end), trailing: raw.slice(end) };
}

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

  for (const match of normalized.matchAll(TOKEN_REGEX)) {
    const index = match.index ?? 0;

    // Plain text between the previous token and this one — escaped as element text.
    if (index > cursor) out += escapeApHtml(normalized.slice(cursor, index));

    const groups = match.groups ?? {};
    if (groups.url !== undefined) {
      const { url, trailing } = splitTrailingUrlPunctuation(groups.url);
      out += urlAnchor(url);
      if (trailing) out += escapeApHtml(trailing);
    } else if (groups.mentionId !== undefined) {
      // Resolved → a mention anchor. Undeclared/unresolvable → DROP: the internal
      // `[mention:<id>]` placeholder must never leak to the wire.
      const link = mentions?.get(groups.mentionId);
      if (link) out += mentionAnchor(link);
    } else if (groups.hashtag !== undefined) {
      const href = hashtagHref?.(groups.hashtag);
      out += href ? hashtagAnchor(groups.hashtag, href) : escapeApHtml(match[0]);
    }

    cursor = index + match[0].length;
  }

  if (cursor < normalized.length) out += escapeApHtml(normalized.slice(cursor));

  return wrapApParagraphs(out);
}
