import { describe, expect, it } from 'bun:test';
import type { HydratedPost } from '@mention/shared-types';
import {
  firstPaintFontUrl,
  injectPrerender,
  prerenderPost,
  prerenderStyle,
  renderPrerenderPost,
} from '../services/webshell/prerender';

/**
 * The first frame: the page's own words, author and media in the initial HTML,
 * as a layer the app removes once its route has committed the same content.
 */

const post = {
  id: 'p1',
  user: {
    id: 'u1',
    username: 'nate',
    name: { displayName: 'Nate <script>' },
    avatar: 'https://cdn.example/a.png',
  },
  content: {
    text: 'Read https://example.com/x, then #Cats and <b>this</b>',
    media: [
      {
        id: 'm1',
        type: 'image',
        url: 'https://cdn.example/m1.jpg',
        thumbUrl: 'https://cdn.example/m1.jpg?variant=w320',
        width: 1600,
        height: 900,
        alt: 'A dog in the snow',
      },
      { id: 'm2', type: 'image', thumbUrl: 'https://cdn.example/m2.jpg?variant=w320' },
    ],
  },
  metadata: { createdAt: '2026-11-21T11:04:00.000Z' },
  engagement: { likes: 3, downvotes: 0, reposts: 1, replies: 2 },
} as unknown as HydratedPost;

describe('the first frame of a post', () => {
  const html = renderPrerenderPost(prerenderPost(post), '/p/p1');

  it('names the author with a link to their profile, escaped', () => {
    expect(html).toContain('<h1 class="mp-name"><a href="/@nate">Nate &lt;script&gt;</a></h1>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('@nate');
  });

  it("shows the post's words with real links, someone else's link not vouched for", () => {
    expect(html).toContain(
      '<a href="https://example.com/x" rel="nofollow ugc noopener" target="_blank">https://example.com/x</a>,',
    );
    expect(html).toContain('<a href="/hashtag/cats">#Cats</a>');
    expect(html).toContain('&lt;b&gt;this&lt;/b&gt;');
  });

  it("shows the media at the card's URL with its alt text, the first one eagerly, the box reserved", () => {
    expect(html).toContain(
      'src="https://cdn.example/m1.jpg?variant=w320" alt="A dog in the snow" fetchpriority="high" loading="eager"',
    );
    // No author alt: a description, never an image without one.
    expect(html).toContain('alt="Image by Nate &lt;script&gt;" loading="lazy"');
    expect(html).toContain('aspect-ratio:1.7778');
  });

  it('carries the time and the counts row the app shows', () => {
    expect(html).toContain('<time datetime="2026-11-21T11:04:00.000Z">');
    expect(html).toContain('<b>3</b> likes');
    expect(html).toContain('<b>1</b> repost');
    expect(html).not.toContain('quotes');
  });
});

describe('the layer in the document', () => {
  it('goes before #root, so the app boots underneath it untouched', () => {
    const doc = injectPrerender(
      '<html><body><div id="root"></div></body></html>',
      '<div id="mention-prerender"></div>',
    );
    expect(doc).toBe(
      '<html><body><div id="mention-prerender"></div><div id="root"></div></body></html>',
    );
    expect(injectPrerender('<html><body><div id="root"></div></body></html>', '')).toBe(
      '<html><body><div id="root"></div></body></html>',
    );
  });

  it("uses the document's preloaded Inter without swapping it in late", () => {
    const shell =
      '<link rel="preload" href="/assets/Inter.abc.woff2" as="font" type="font/woff2" crossorigin data-first-paint-font>';
    expect(firstPaintFontUrl(shell)).toBe('/assets/Inter.abc.woff2');
    expect(prerenderStyle('/assets/Inter.abc.woff2')).toContain('font-display:optional');
    expect(prerenderStyle()).not.toContain('@font-face');
  });
});

describe('the words of the frame', () => {
  it('draws **bold** as the app does', () => {
    const page = prerenderPost({
      ...post,
      content: { text: 'Plain **strong words** end' },
    } as HydratedPost);
    expect(renderPrerenderPost(page, '/p/p1')).toContain('Plain <strong>strong words</strong> end');
  });
});
