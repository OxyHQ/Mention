import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';

/**
 * The federated HTML → plain-text conversion, with the whitespace normalization
 * that closes the pretty-printed-markup bug.
 *
 * Many servers emit indented HTML (`<p>\n      Hola\n    </p>`). HTML collapses
 * that whitespace at render time; our clients do NOT (React Native Web renders
 * `Text` with `white-space: pre-wrap`), so what was stored verbatim showed up as
 * a blank line plus an indent. The old `\n{3,}` collapse could not see it: the
 * "blank" line it left behind CONTAINED spaces, which break the run of `\n`.
 */
describe('htmlToPlainText', () => {
  it('collapses the blank line and indent left by pretty-printed HTML', () => {
    expect(htmlToPlainText('<p>\n      Hola\n    </p>')).toBe('Hola');
  });

  it('leaves no blank line between pretty-printed paragraphs', () => {
    const html = '<p>\n      Primer párrafo\n    </p>\n    <p>\n      Segundo párrafo\n    </p>';
    // Exactly one blank line between the two paragraphs — no stray empty line,
    // no whitespace-only line.
    expect(htmlToPlainText(html)).toBe('Primer párrafo\n\nSegundo párrafo');
    expect(htmlToPlainText(html)).not.toMatch(/\n[^\S\n]+\n/);
  });

  it('collapses a whitespace-only line between paragraphs (spaces break a \\n run)', () => {
    // The exact shape the old `\n{3,}` regex missed: the middle line is not
    // empty, it holds spaces, so the newline run was never 3+ long.
    expect(htmlToPlainText('<p>uno</p>\n   \n   \n<p>dos</p>')).toBe('uno\n\ndos');
  });

  it('preserves the author\'s paragraph breaks', () => {
    expect(htmlToPlainText('<p>uno</p><p>dos</p>')).toBe('uno\n\ndos');
    expect(htmlToPlainText('<p>uno<br>dos</p>')).toBe('uno\ndos');
  });

  it('caps three or more line breaks at a single blank line', () => {
    expect(htmlToPlainText('uno<br><br><br><br>dos')).toBe('uno\n\ndos');
  });

  it('decodes entities before normalizing, so an encoded newline collapses too', () => {
    // `&#10;` is a newline and `&nbsp;` a non-breaking space: both are only
    // whitespace once decoded, so decoding must happen first.
    expect(htmlToPlainText('<p>Hola&#10;&#10;&#10;&nbsp;&nbsp;mundo</p>')).toBe('Hola\n\nmundo');
    expect(htmlToPlainText('<p>caf&eacute; &amp; t&eacute;</p>')).toBe('café & té');
  });

  it('normalizes CRLF and tabs from remote markup', () => {
    expect(htmlToPlainText('<p>uno</p>\r\n\r\n\r\n<p>\tdos</p>')).toBe('uno\n\ndos');
  });

  it('extracts the href from a link and strips remaining tags', () => {
    expect(htmlToPlainText('<p>ver <a href="https://example.com/x">example.com/x</a></p>')).toBe(
      'ver https://example.com/x',
    );
    expect(htmlToPlainText('<p><span class="h-card">hola</span></p>')).toBe('hola');
  });

  it('returns an empty string for empty or whitespace-only HTML', () => {
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText('<p>\n   \n</p>')).toBe('');
  });

  it('is idempotent', () => {
    const once = htmlToPlainText('<p>\n   uno\n  </p>\n  <p>\n   dos\n  </p>');
    expect(htmlToPlainText(once)).toBe(once);
  });
});
