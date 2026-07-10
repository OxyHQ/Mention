import { describe, it, expect } from 'vitest';
import type { HydratedPost } from '@mention/shared-types';
import {
  escapeHtml,
  buildOgMetaHtml,
  renderShellWithOg,
  mapProfileOg,
  mapPostOg,
  OgData,
} from '../services/webShellRenderer';

const SHELL =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mention</title>' +
  '<link rel="icon" href="/favicon.ico" /></head><body><div id="root"></div>' +
  '<script src="/_expo/static/js/web/entry.js" defer></script></body></html>';

describe('escapeHtml', () => {
  it('escapes the dangerous set (& < > ")', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('does not escape safe characters', () => {
    expect(escapeHtml("O'Brien — 5$")).toBe("O'Brien — 5$");
  });
});

describe('buildOgMetaHtml', () => {
  const og: OgData = {
    title: 'Nate (@nate) on Mention',
    description: 'hello <world> & "friends"',
    image: 'https://cloud.oxy.so/abc?variant=thumb',
    url: 'https://mention.earth/@nate',
    type: 'profile',
  };

  it('emits all OG/Twitter tags with escaped values', () => {
    const html = buildOgMetaHtml(og);
    expect(html).toContain('<meta property="og:type" content="profile">');
    expect(html).toContain('<meta property="og:site_name" content="Mention">');
    expect(html).toContain('<meta property="og:url" content="https://mention.earth/@nate">');
    expect(html).toContain('<meta property="og:title" content="Nate (@nate) on Mention">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    // description is escaped everywhere it appears
    expect(html).toContain('content="hello &lt;world&gt; &amp; &quot;friends&quot;"');
    expect(html).not.toContain('hello <world>');
  });

  it('emits image tags only when an image is present', () => {
    const withImage = buildOgMetaHtml(og);
    expect(withImage).toContain('<meta property="og:image" content="https://cloud.oxy.so/abc?variant=thumb">');
    expect(withImage).toContain('<meta name="twitter:image" content="https://cloud.oxy.so/abc?variant=thumb">');

    const noImage = buildOgMetaHtml({ ...og, image: undefined });
    expect(noImage).not.toContain('og:image');
    expect(noImage).not.toContain('twitter:image');
  });
});

describe('renderShellWithOg', () => {
  const og: OgData = {
    title: 'Nate (@nate) on Mention',
    description: 'bio',
    url: 'https://mention.earth/@nate',
    type: 'profile',
  };

  it('replaces the existing <title> and injects the meta before </head>', () => {
    const html = renderShellWithOg(SHELL, og);
    expect(html).toContain('<title>Nate (@nate) on Mention</title>');
    expect(html).not.toContain('<title>Mention</title>');
    // the whole OG block is injected inside <head>, ending right before </head>
    expect(html).toContain('<meta property="og:title" content="Nate (@nate) on Mention">');
    expect(html).toContain('<meta name="description" content="bio"></head>');
    expect(html.indexOf('og:title')).toBeLessThan(html.indexOf('</head>'));
    // exactly one title tag remains
    expect(html.match(/<title>/g)?.length).toBe(1);
  });

  it('returns the shell verbatim when og is null', () => {
    expect(renderShellWithOg(SHELL, null)).toBe(SHELL);
  });

  it('does not treat a $ in the title as a replace back-reference', () => {
    const html = renderShellWithOg(SHELL, { ...og, title: 'Deal $5 & $1' });
    expect(html).toContain('<title>Deal $5 &amp; $1</title>');
  });
});

describe('mapProfileOg', () => {
  it('builds the display-name title and profile url', () => {
    const og = mapProfileOg({ username: 'nate', name: { displayName: 'Nate' }, bio: 'hi there' });
    expect(og).not.toBeNull();
    expect(og?.title).toBe('Nate (@nate) on Mention');
    expect(og?.description).toBe('hi there');
    expect(og?.url).toBe('https://mention.earth/@nate');
    expect(og?.type).toBe('profile');
  });

  it('falls back to the handle title when there is no display name', () => {
    expect(mapProfileOg({ username: 'nate' })?.title).toBe('@nate on Mention');
  });

  it('passes through an absolute avatar URL and resolves a bare file id via the CDN helper', () => {
    expect(mapProfileOg({ username: 'a', avatar: 'https://remote.example/x.png' })?.image).toBe(
      'https://remote.example/x.png',
    );
    expect(mapProfileOg({ username: 'a', avatar: 'file123' })?.image).toBe(
      'https://cloud.oxy.so/file123?variant=thumb',
    );
  });

  it('omits the image when there is no avatar', () => {
    expect(mapProfileOg({ username: 'a' })?.image).toBeUndefined();
  });

  it('returns null for an unknown handle (no username)', () => {
    expect(mapProfileOg(null)).toBeNull();
    expect(mapProfileOg({})).toBeNull();
  });

  it('prefers bio over description and trims', () => {
    expect(mapProfileOg({ username: 'a', bio: '  b  ', description: 'd' })?.description).toBe('b');
    expect(mapProfileOg({ username: 'a', description: '  d  ' })?.description).toBe('d');
  });
});

describe('mapPostOg', () => {
  const base = {
    id: 'p1',
    // Canonical Oxy `User` shape: `name.displayName`, `username`, and an absolute
    // federated avatar URL (Bloom would render it directly; OG uses it as-is).
    user: { id: 'u1', username: 'nate', name: { displayName: 'Nate' }, avatar: 'https://cdn/a.png' },
    content: { text: 'hello world' },
  } as unknown as HydratedPost;

  it('builds the author title, sliced description, and post url', () => {
    const og = mapPostOg(base, 'p1');
    expect(og.title).toBe('Nate on Mention');
    expect(og.description).toBe('hello world');
    expect(og.url).toBe('https://mention.earth/p/p1');
    expect(og.type).toBe('article');
    // no media/linkPreview → falls back to author avatar (absolute URL passthrough)
    expect(og.image).toBe('https://cdn/a.png');
  });

  it('falls back to @handle when the author has no display name', () => {
    const post = { ...base, user: { ...base.user, name: {} } } as HydratedPost;
    expect(mapPostOg(post, 'p1').title).toBe('@nate on Mention');
  });

  it('truncates the description to 200 characters', () => {
    const post = { ...base, content: { text: 'x'.repeat(500) } } as HydratedPost;
    expect(mapPostOg(post, 'p1').description).toHaveLength(200);
  });

  it('prefers media url over thumb/poster/linkPreview/avatar', () => {
    const post = {
      ...base,
      content: { text: 't', media: [{ id: 'm', type: 'image', url: 'https://m/u.jpg', thumbUrl: 'https://m/t.jpg' }] },
      linkPreview: { url: 'https://l', image: 'https://l/i.jpg' },
    } as unknown as HydratedPost;
    expect(mapPostOg(post, 'p1').image).toBe('https://m/u.jpg');
  });

  it('uses the link-preview image when there is no media', () => {
    const post = {
      ...base,
      content: { text: 't' },
      linkPreview: { url: 'https://l', image: 'https://l/i.jpg' },
    } as unknown as HydratedPost;
    expect(mapPostOg(post, 'p1').image).toBe('https://l/i.jpg');
  });
});
