import { decode as decodeEntities } from 'he';

/**
 * Convert ActivityPub HTML content to plain text for storage.
 * Preserves paragraph breaks, line breaks, and extracts URLs from links.
 * Uses the `he` library for robust HTML entity decoding.
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

  // Collapse excessive whitespace/newlines
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
