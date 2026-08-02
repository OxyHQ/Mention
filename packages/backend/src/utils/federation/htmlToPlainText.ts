import { decode as decodeEntities } from 'he';
import { normalizeInlineText, normalizeMultilineText } from '@oxyhq/core';

/**
 * Any `<a …>…</a>` anchor, capturing its attribute string and its inner HTML
 * separately. Anchors do not nest in AP content HTML, so the non-greedy dotall
 * inner match is safe — and unlike the old `[^<]*` inner pattern it also matches
 * an anchor that WRAPS an element, which is the shape Mastodon uses.
 */
const ANCHOR_REGEX = /<a\b([^>]*)>(.*?)<\/a>/gis;

/** The `href` of an anchor's attribute string (double-quoted, as every server emits). */
const ANCHOR_HREF_REGEX = /\bhref="([^"]*)"/i;

/**
 * Marks an anchor whose VISIBLE TEXT is the payload and whose href is chrome: an
 * @mention or a #hashtag. Every server family marks both — Mastodon, Sharkey,
 * Misskey, Akkoma and Pleroma all emit `class="u-url mention"` on a mention
 * anchor and `class="mention hashtag"` + `rel="tag"` on a hashtag one; Bridgy Fed
 * emits `class="hashtag"` + `rel="tag"`. The microformat `u-url` is deliberately
 * NOT a signal of its own: it means "this is the URL of the surrounding h-card",
 * so on every server that emits it, either `mention` sits beside it or
 * {@link HCARD_OPEN_TAG_REGEX} matches the wrapper it refers to.
 */
const LABEL_ANCHOR_ATTR_REGEX =
  /\bclass="[^"]*\b(?:mention|hashtag)\b[^"]*"|\brel="[^"]*\btag\b[^"]*"/i;

/**
 * The `h-card` microformat wrapper OPENING immediately before an anchor —
 * `<span class="h-card" translate="no"><a …>` — the other signal that the anchor
 * it wraps is a mention, for a server that marks the wrapper but not the anchor.
 */
const HCARD_OPEN_TAG_REGEX = /<span\b[^>]*\bclass="[^"]*\bh-card\b[^"]*"[^>]*>\s*$/i;

/**
 * How far back to look for that wrapper. The longest real one seen is ~40 chars
 * (`<span class="h-card" translate="no">`); the bound keeps the per-anchor
 * lookbehind O(1) instead of O(document) on a long body.
 */
const HCARD_LOOKBEHIND_CHARS = 256;

/** An anchor's visible text: inner markup stripped, surrounding space trimmed. */
function anchorVisibleText(inner: string): string {
  return inner.replace(/<[^>]+>/g, '').trim();
}

/** True when the anchor at `offset` is wrapped by an `h-card` microformat span. */
function isHCardWrapped(html: string, offset: number): boolean {
  const from = Math.max(0, offset - HCARD_LOOKBEHIND_CHARS);
  return HCARD_OPEN_TAG_REGEX.test(html.slice(from, offset));
}

/**
 * Collapse every anchor to the ONE of its two payloads that carries the meaning.
 *
 * A LABEL anchor — an @mention or a #hashtag — means its visible text: the handle
 * or the tag. Its href is a profile/tag page URL the reader never asked for, and
 * substituting it is a catastrophic degradation, which is exactly the bug this
 * rule exists for: an unresolved mention rendered as a raw
 * `https://mastodon.online/@danirabbit` URL (plus a bogus link-preview card)
 * instead of `@danirabbit@mastodon.online`.
 *
 * Any OTHER anchor means its href: remote servers write the visible text of a
 * plain link as a TRUNCATED, prettified rendition of the URL
 * (`<span class="invisible">https://</span>example.com/a…`), so the href is the
 * only complete form — and `LinkifiedText` re-linkifies it downstream.
 *
 * Both classes used to be decided by ACCIDENT rather than by intent: the old rule
 * matched only anchors whose inner HTML held no element (`[^<]*`), so a Mastodon
 * mention (`@<span>user</span>`) fell through to plain tag-stripping and kept its
 * handle, while the byte-identical Sharkey/Akkoma/Misskey mention — flat
 * `<a …>@user@domain</a>` — was replaced by its href. Same mention, opposite
 * results, decided by whether the origin server happened to wrap the username in
 * a `<span>`. Matching every anchor and branching on what the anchor SAYS IT IS
 * makes the two consistent.
 */
function collapseAnchors(html: string): string {
  return html.replace(
    ANCHOR_REGEX,
    (_match: string, attrs: string, inner: string, offset: number, source: string) => {
      const visible = anchorVisibleText(inner);
      if ((LABEL_ANCHOR_ATTR_REGEX.test(attrs) || isHCardWrapped(source, offset)) && visible) {
        return visible;
      }
      const href = ANCHOR_HREF_REGEX.exec(attrs)?.[1]?.trim() ?? '';
      // No href (or an unparseable single-quoted one) → the visible text is all
      // there is, which is what the old tag-stripping fall-through produced.
      return href.length > 0 ? href : visible;
    },
  );
}

/**
 * Convert ActivityPub HTML content to plain text for storage.
 * Preserves paragraph breaks, line breaks, and collapses each link to its href or
 * — for a mention/hashtag anchor — to its visible label (see {@link collapseAnchors}).
 * Uses the `he` library for robust HTML entity decoding.
 *
 * The result is finished with {@link normalizeMultilineText} (the canonical Oxy
 * text normalizer) rather than a local whitespace collapse. Remote servers emit
 * pretty-printed HTML — `<p>\n      Hola\n    </p>` — so the text between the
 * tags carries the source indentation. HTML collapses that whitespace at render
 * time; our clients do NOT (React Native Web renders `Text` with
 * `white-space: pre-wrap`), so it must be normalized at storage time. A bare
 * `\n{3,}` collapse cannot do it: the "blank" line left behind by the indent
 * still CONTAINS spaces, which break the run of `\n` characters, so the blank
 * line and the indent both survive into the UI. The canonical normalizer strips
 * the horizontal whitespace at BOTH ends of every line before collapsing blank
 * lines, which is exactly what that case needs — the author's own paragraph
 * breaks survive, the markup's indentation does not.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';

  let text = html;

  // Paragraph breaks → double newline
  text = text.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  text = text.replace(/<\/?p[^>]*>/gi, '\n');

  // Line breaks
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Links → the href, EXCEPT a mention/hashtag anchor, which becomes its visible
  // label. Runs before the blanket tag strip so the anchor's own markup is still
  // there to be read.
  text = collapseAnchors(text);

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode all HTML entities (named, numeric decimal, numeric hex)
  text = decodeEntities(text);

  // Normalize the whitespace the source markup left behind (see above).
  return normalizeMultilineText(text);
}

/**
 * THE rule for a remote ONE-LINE LABEL that arrives as markup — today the
 * ActivityPub `summary` (the content warning).
 *
 * A CW is a single line: {@link htmlToPlainText} strips the tags and decodes the
 * entities, then the canonical inline normalizer collapses what is left onto one
 * line. Both steps are needed and both are load-bearing — a Mastodon summary
 * arrives as `<p>…</p>` on some servers and as bare text on others.
 *
 * Lives here, below the connector, because TWO callers must produce byte-identical
 * output from the same input: the ingest ({@link extractApSummary}) and the
 * one-shot backfill that re-normalizes the labels stored by the OLD ingest, which
 * persisted the summary raw — HTML included. A backfill that applied only half of
 * this rule would leave `<p>…</p>` sitting in the database forever.
 *
 * Returns undefined when nothing is left, which is what "no content warning" is:
 * the field must be ABSENT, never an empty string.
 *
 * Idempotent — running it over an already-clean label is a no-op.
 */
export function htmlToInlineLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = normalizeInlineText(htmlToPlainText(value));
  return label.length > 0 ? label : undefined;
}
