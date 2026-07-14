import { decode as decodeEntities } from 'he';
import { normalizeMultilineText } from '@oxyhq/core';

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
