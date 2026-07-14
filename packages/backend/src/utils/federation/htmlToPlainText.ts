import { decode as decodeEntities } from 'he';
import { normalizeInlineText, normalizeMultilineText } from '@oxyhq/core';

/**
 * Convert ActivityPub HTML content to plain text for storage.
 * Preserves paragraph breaks, line breaks, and extracts URLs from links.
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

  // Links → extract URL (LinkifiedText will auto-linkify them)
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1');

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
