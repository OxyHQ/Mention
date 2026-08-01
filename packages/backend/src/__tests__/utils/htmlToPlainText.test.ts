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

  it('extracts the href from a link whose text is WRAPPED in elements', () => {
    // The old rule matched only anchors with a TEXT-ONLY child, so an anchor
    // holding any element fell through to plain tag-stripping and lost the URL
    // entirely — the same `[^<]*` accident that made mentions degrade differently
    // per server. The visible text here deliberately does NOT spell the href, so
    // the two branches cannot be confused.
    expect(
      htmlToPlainText('<p>ver <a href="https://example.com/page"><b>aquí</b> mismo</a></p>'),
    ).toBe('ver https://example.com/page');

    // The Mastodon shape that motivates preferring the href: the visible text is
    // a prettified rendition split across spans.
    const mastodonLink =
      '<a href="https://example.com/a/very/long/path" rel="nofollow"><span class="invisible">https://</span><span class="ellipsis">example.com/a/very</span><span class="invisible">/long/path</span></a>';
    expect(htmlToPlainText(mastodonLink)).toBe('https://example.com/a/very/long/path');
  });
});

/**
 * A MENTION anchor degrades to its visible HANDLE, never to its href.
 *
 * The bug: a Sharkey/Akkoma/Misskey mention is a FLAT anchor
 * (`<a class="u-url mention">@user@host</a>`), which the old href-extraction rule
 * matched — so an unresolved mention was stored as a raw
 * `https://mastodon.online/@danirabbit` URL, which the client then rendered as a
 * link with a bogus profile link-preview card attached. The byte-equivalent
 * Mastodon mention (`@<span>user</span>`) was skipped by that same rule purely
 * because it wraps the username in an element, and kept its handle. Same mention,
 * opposite outcomes.
 *
 * The HTML below is captured verbatim from the reported post (the author's
 * Sharkey 2025.4.7 outbox) and from mastodon.social.
 */
describe('htmlToPlainText — mention anchors degrade to their handle', () => {
  const SHARKEY_MENTIONS =
    '<p><a href="https://mastodon.online/@danirabbit" class="u-url mention">@danirabbit@mastodon.online</a> <a href="https://mastodon.social/@elementary" class="u-url mention">@elementary@mastodon.social</a> I used to sponsor elementary a few years ago</p>';

  it('keeps the handle of a FLAT (Sharkey/Akkoma/Misskey) mention anchor', () => {
    expect(htmlToPlainText(SHARKEY_MENTIONS)).toBe(
      '@danirabbit@mastodon.online @elementary@mastodon.social I used to sponsor elementary a few years ago',
    );
  });

  it('never substitutes the profile URL for an unresolved mention', () => {
    const text = htmlToPlainText(SHARKEY_MENTIONS);
    expect(text).not.toContain('https://');
    expect(text).not.toContain('mastodon.online/@');
  });

  it('keeps the handle of a NESTED (Mastodon) mention anchor — unchanged behavior', () => {
    const html =
      '<p><span class="h-card" translate="no"><a href="https://mastodon.social/@indigoparadox" class="u-url mention">@<span>indigoparadox</span></a></span> No, none of that.</p>';
    expect(htmlToPlainText(html)).toBe('@indigoparadox No, none of that.');
  });

  it('reads the h-card wrapper when the anchor itself carries no mention class', () => {
    // GoToSocial-shaped: the anchor says only `u-url` ("the URL of the h-card"),
    // which means nothing on its own — the ENCLOSING h-card is what identifies it.
    const html =
      '<p>hey <span class="h-card"><a href="https://gts.example/@bob" class="u-url" rel="nofollow noreferrer noopener" target="_blank">@<span>bob</span></a></span></p>';
    expect(htmlToPlainText(html)).toBe('hey @bob');
  });

  it('keeps the #tag of a hashtag anchor marked by its CLASS', () => {
    // Pleroma-shaped: `class="hashtag"` and no `rel`. Mastodon's own inner-span
    // shape (`class="mention hashtag" rel="tag"`) is covered by both signals.
    expect(
      htmlToPlainText('<a class="hashtag" href="https://bsky.app/search?q=%23Climate">#Climate</a>'),
    ).toBe('#Climate');
    expect(
      htmlToPlainText(
        '<a href="https://mastodon.social/tags/art" class="mention hashtag" rel="tag">#<span>art</span></a>',
      ),
    ).toBe('#art');
  });

  it('keeps the #tag of a hashtag anchor marked only by rel="tag"', () => {
    // Misskey/Sharkey-shaped: the `rel` is the only marker.
    expect(htmlToPlainText('<a href="https://misskey.example/tags/art" rel="tag">#art</a>')).toBe(
      '#art',
    );
  });

  it('falls back to the href when a mention anchor has no visible text', () => {
    expect(htmlToPlainText('<a href="https://m.example/@ghost" class="u-url mention"></a>')).toBe(
      'https://m.example/@ghost',
    );
  });

  it('falls back to the visible text when an anchor has no parseable href', () => {
    expect(htmlToPlainText("<a href='https://example.com/x'>example.com/x</a>")).toBe(
      'example.com/x',
    );
    expect(htmlToPlainText('<a>bare</a>')).toBe('bare');
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
