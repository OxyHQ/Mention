import { describe, expect, it } from 'vitest';
import { linkifyApHtml, type ApMentionLink, type LinkifyApHtmlOptions } from '../../utils/federation/linkifyApHtml';

/**
 * The outbound plain-text → ActivityPub `content` HTML LINKIFIER: it turns
 * `[mention:<id>]` placeholders into Mastodon mention anchors, `#tags` into
 * hashtag anchors, and bare URLs into links — while preserving the paragraph/`<br>`
 * structure of {@link plainTextToApHtml} and, critically, NEVER leaking the
 * internal placeholder to the wire.
 *
 * These pin the SEGMENT/TOKEN escaping contract: only plain-text spans and the
 * VISIBLE label of a link are HTML-escaped, every href is attribute-escaped, and
 * nothing is escaped twice or corrupts an injected anchor.
 */

const MENTIONS: ReadonlyMap<string, ApMentionLink> = new Map([
  ['u1', { href: 'https://mention.earth/ap/users/alice', handle: 'alice' }],
  ['u2', { href: 'https://remote.social/users/bob', handle: 'bob@remote.social' }],
]);

// A hashtag href builder mirroring the real one (normalize → lowercase → encode)
// so the anchor href matches the Note's `Hashtag` tag shape.
const hashtagHref = (tag: string): string => `https://mention.earth/hashtag/${encodeURIComponent(tag.toLowerCase())}`;

const opts: LinkifyApHtmlOptions = { mentions: MENTIONS, hashtagHref };

describe('linkifyApHtml — @mentions', () => {
  it('renders a LOCAL mention as a Mastodon mention anchor (@username)', () => {
    expect(linkifyApHtml('hi [mention:u1]!', opts)).toBe(
      '<p>hi <a href="https://mention.earth/ap/users/alice" class="u-url mention">@alice</a>!</p>',
    );
  });

  it('renders a FEDERATED mention as @user@domain pointing at the remote actor uri', () => {
    expect(linkifyApHtml('cc [mention:u2]', opts)).toBe(
      '<p>cc <a href="https://remote.social/users/bob" class="u-url mention">@bob@remote.social</a></p>',
    );
  });

  it('resolves every occurrence of a repeated placeholder and NEVER leaves a [mention: substring', () => {
    const out = linkifyApHtml('[mention:u1] and again [mention:u1]', opts);
    expect(out).toBe(
      '<p><a href="https://mention.earth/ap/users/alice" class="u-url mention">@alice</a> and again ' +
        '<a href="https://mention.earth/ap/users/alice" class="u-url mention">@alice</a></p>',
    );
    expect(out).not.toContain('[mention:');
  });

  it('DROPS an unresolved/undeclared placeholder — the internal id must never reach the wire', () => {
    expect(linkifyApHtml('who is [mention:u9]?', opts)).toBe('<p>who is ?</p>');
    // With no mentions map at all, every placeholder is dropped too; a trailing
    // placeholder leaves no stray space (the paragraph trim cleans it).
    expect(linkifyApHtml('gone [mention:u1]', { hashtagHref })).toBe('<p>gone</p>');
  });
});

describe('linkifyApHtml — #hashtags', () => {
  it('wraps a #tag, preserving case in the label but normalizing the href', () => {
    expect(linkifyApHtml('big #News today', opts)).toBe(
      '<p>big <a href="https://mention.earth/hashtag/news" class="mention hashtag" rel="tag">#News</a> today</p>',
    );
  });

  it('leaves #tags as plain text when no hashtagHref is supplied', () => {
    expect(linkifyApHtml('big #News', {})).toBe('<p>big #News</p>');
  });

  // The reported bug, on the outbound-federation path: the ASCII-only class cut
  // the anchor at the first non-ASCII letter, so remote instances received a
  // link to `#Bundesl` plus a stray `änderTurnier` in the text.
  it('wraps a non-ASCII #tag WHOLE, not truncated at the first accent', () => {
    expect(linkifyApHtml('Das #BundesländerTurnier war toll', opts)).toBe(
      '<p>Das <a href="https://mention.earth/hashtag/bundesl%C3%A4nderturnier" class="mention hashtag" rel="tag">#BundesländerTurnier</a> war toll</p>',
    );
  });

  it('wraps a #tag in a non-Latin script', () => {
    expect(linkifyApHtml('big #東京 today', opts)).toBe(
      '<p>big <a href="https://mention.earth/hashtag/%E6%9D%B1%E4%BA%AC" class="mention hashtag" rel="tag">#東京</a> today</p>',
    );
  });

  it('does not link a digit-leading tag', () => {
    expect(linkifyApHtml('see you in #2026', opts)).toBe('<p>see you in #2026</p>');
  });
});

describe('linkifyApHtml — URLs', () => {
  it('wraps a bare http(s) URL', () => {
    expect(linkifyApHtml('see https://example.com/x', opts)).toBe(
      '<p>see <a href="https://example.com/x">https://example.com/x</a></p>',
    );
  });

  it('leaves trailing sentence punctuation OUTSIDE the link', () => {
    expect(linkifyApHtml('go to https://example.com.', opts)).toBe(
      '<p>go to <a href="https://example.com">https://example.com</a>.</p>',
    );
  });

  it('escapes an ampersand in a query string in BOTH the href and the label (no double-escape)', () => {
    expect(linkifyApHtml('https://x.com/a?b=1&c=2', opts)).toBe(
      '<p><a href="https://x.com/a?b=1&amp;c=2">https://x.com/a?b=1&amp;c=2</a></p>',
    );
  });

  it('keeps a balanced closing paren but trims an unbalanced one', () => {
    expect(linkifyApHtml('(see https://en.wikipedia.org/wiki/Foo_(bar))', opts)).toBe(
      '<p>(see <a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>)</p>',
    );
  });
});

describe('linkifyApHtml — escaping correctness', () => {
  it('escapes < & > in surrounding text but never re-escapes the injected anchors', () => {
    const out = linkifyApHtml('a < b && [mention:u1] <x>', opts);
    expect(out).toBe(
      '<p>a &lt; b &amp;&amp; <a href="https://mention.earth/ap/users/alice" class="u-url mention">@alice</a> &lt;x&gt;</p>',
    );
    // The anchor markup is intact (not turned into &lt;a&gt;), and no double-escape.
    expect(out).not.toContain('&amp;lt;');
    expect(out).not.toContain('&lt;a ');
  });
});

describe('linkifyApHtml — composes with paragraphs / <br>', () => {
  it('linkifies across paragraph and line breaks', () => {
    expect(linkifyApHtml('hi [mention:u1]\nsecond line\n\nbye #tag', opts)).toBe(
      '<p>hi <a href="https://mention.earth/ap/users/alice" class="u-url mention">@alice</a><br>second line</p>' +
        '<p>bye <a href="https://mention.earth/hashtag/tag" class="mention hashtag" rel="tag">#tag</a></p>',
    );
  });

  it('mixes a URL, a hashtag and two mentions in one body', () => {
    expect(linkifyApHtml('[mention:u1] pinged [mention:u2] re https://ex.com #hi', opts)).toBe(
      '<p><a href="https://mention.earth/ap/users/alice" class="u-url mention">@alice</a> pinged ' +
        '<a href="https://remote.social/users/bob" class="u-url mention">@bob@remote.social</a> re ' +
        '<a href="https://ex.com">https://ex.com</a> ' +
        '<a href="https://mention.earth/hashtag/hi" class="mention hashtag" rel="tag">#hi</a></p>',
    );
  });

  it('returns an empty string for an empty/whitespace-only body', () => {
    expect(linkifyApHtml('', opts)).toBe('');
    expect(linkifyApHtml('   \n\n ', opts)).toBe('');
  });
});

describe('linkifyApHtml — shared entity definitions', () => {
  it('renders a whitespace-bearing placeholder as literal text', () => {
    // This file used to carry its own `[^\]]+` placeholder pattern while the
    // write boundary used `[^\]\s]+`. Under the loose one this was consumed as a
    // placeholder — and then DROPPED, since no authorized id can contain a
    // space, silently deleting text the author typed.
    expect(linkifyApHtml('hi [mention:foo bar] there', opts)).toBe(
      '<p>hi [mention:foo bar] there</p>',
    );
  });

  it('linkifies a non-ASCII hashtag whole, matching what is stored', () => {
    expect(linkifyApHtml('das #BundesländerTurnier', opts)).toContain(
      '>#BundesländerTurnier</a>',
    );
  });

  it('leaves a digit-leading #2026 as plain text, as the extractor does', () => {
    expect(linkifyApHtml('see you in #2026', opts)).toBe('<p>see you in #2026</p>');
  });

  it('does not linkify a scheme-less www. run', () => {
    // Outbound anchors are consumed by other servers; synthesizing a scheme onto
    // something the author never wrote as a link is not this path's call.
    expect(linkifyApHtml('visit www.example.com', opts)).toBe('<p>visit www.example.com</p>');
  });

  it('stops a URL at a following tag rather than swallowing it', () => {
    // The `html` terminator — a run taken to the next whitespace would put
    // markup inside the href.
    expect(linkifyApHtml('see https://ex.com/a<b', opts)).toBe(
      '<p>see <a href="https://ex.com/a">https://ex.com/a</a>&lt;b</p>',
    );
  });

  it('keeps a balanced closing paren inside the URL', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(linkifyApHtml(`see ${url}`, opts)).toBe(
      `<p>see <a href="${url}">${url}</a></p>`,
    );
  });
});
