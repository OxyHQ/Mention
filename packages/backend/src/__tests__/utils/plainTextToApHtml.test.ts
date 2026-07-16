import { describe, expect, it } from 'vitest';
import { plainTextToApHtml } from '../../utils/federation/plainTextToApHtml';

/**
 * The OUTBOUND plain-text → ActivityPub `content` HTML transform — the inverse of
 * {@link htmlToPlainText}. ActivityPub `content` is HTML, where a bare newline is
 * insignificant whitespace: emitting a stored plain-text body raw dropped the
 * author's blank lines and line breaks the moment Mastodon rendered it. This
 * converter wraps paragraphs in `<p>`, turns single newlines into `<br>`, and
 * HTML-escapes the body so `<`/`&` never mis-render.
 */
describe('plainTextToApHtml', () => {
  it('wraps a single-line body in one <p>, no <br>', () => {
    expect(plainTextToApHtml('hello world')).toBe('<p>hello world</p>');
  });

  it('splits blank-line-separated paragraphs into <p> blocks', () => {
    expect(plainTextToApHtml('hola mundo.\n\nAhora\n\nPorque')).toBe(
      '<p>hola mundo.</p><p>Ahora</p><p>Porque</p>',
    );
  });

  it('converts a single newline inside a paragraph to <br>', () => {
    expect(plainTextToApHtml('line one\nline two')).toBe('<p>line one<br>line two</p>');
  });

  it('mixes paragraph breaks and line breaks', () => {
    expect(plainTextToApHtml('a\nb\n\nc\nd')).toBe('<p>a<br>b</p><p>c<br>d</p>');
  });

  it('HTML-escapes &, < and > (and escapes & first, never double-escaping)', () => {
    expect(plainTextToApHtml('a < b && c > d')).toBe('<p>a &lt; b &amp;&amp; c &gt; d</p>');
    expect(plainTextToApHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    // An ampersand-led entity in the source must not be re-escaped into `&amp;amp;`.
    expect(plainTextToApHtml('AT&T & Co')).toBe('<p>AT&amp;T &amp; Co</p>');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(plainTextToApHtml('')).toBe('');
    expect(plainTextToApHtml('   ')).toBe('');
    expect(plainTextToApHtml('\n\n  \n')).toBe('');
  });

  it('collapses 3+ consecutive newlines to a single paragraph break — no empty <p>', () => {
    expect(plainTextToApHtml('uno\n\n\n\ndos')).toBe('<p>uno</p><p>dos</p>');
  });

  it('tolerates horizontal whitespace on the blank line between paragraphs', () => {
    // A "blank" line that holds spaces still separates paragraphs.
    expect(plainTextToApHtml('uno\n   \n   \ndos')).toBe('<p>uno</p><p>dos</p>');
  });

  it('normalizes CRLF and lone CR before processing', () => {
    expect(plainTextToApHtml('uno\r\n\r\ndos')).toBe('<p>uno</p><p>dos</p>');
    expect(plainTextToApHtml('uno\rdos')).toBe('<p>uno<br>dos</p>');
  });

  it('trims leading/trailing blank lines so it never opens with an empty <p> or a stray <br>', () => {
    expect(plainTextToApHtml('\n\nhola\n\n')).toBe('<p>hola</p>');
    expect(plainTextToApHtml('hola\n')).toBe('<p>hola</p>');
  });

  it('does NOT linkify URLs, hashtags or mentions (out of scope — carried by AP tags)', () => {
    expect(plainTextToApHtml('see https://example.com/x #news @bob')).toBe(
      '<p>see https://example.com/x #news @bob</p>',
    );
  });
});
