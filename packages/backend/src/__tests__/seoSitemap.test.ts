import { describe, expect, it } from 'bun:test';
import {
  SITEMAP_BUCKET_COUNT,
  SITEMAP_URL_LIMIT,
  renderSitemapIndex,
  renderUrlSet,
  shardPath,
} from '../services/webshell/seoSitemap';

describe('SEO sitemap XML', () => {
  it('escapes URLs and emits real modification timestamps', () => {
    const xml = renderUrlSet([
      {
        loc: 'https://mention.earth/@a&b',
        lastModified: new Date('2026-09-08T12:00:00.000Z'),
      },
    ]);

    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://mention.earth/@a&amp;b</loc>');
    expect(xml).toContain('<lastmod>2026-09-08T12:00:00.000Z</lastmod>');
  });

  it('builds separate stable profile and post sitemap pages', () => {
    const xml = renderSitemapIndex({
      profiles: [
        { bucket: 0, page: 0 },
        { bucket: 31, page: 0 },
      ],
      posts: [{ bucket: 63, page: 2 }],
    });

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('https://mention.earth/sitemaps/profiles-00-0.xml');
    expect(xml).toContain('https://mention.earth/sitemaps/profiles-1f-0.xml');
    expect(xml).toContain('https://mention.earth/sitemaps/posts-3f-2.xml');
  });

  it("states each child sitemap's lastmod in the index", () => {
    const xml = renderSitemapIndex({
      profiles: [{ bucket: 0, page: 0, lastmod: '2026-11-20T10:00:00.000Z' }],
      posts: [{ bucket: 0, page: 0 }],
    });

    expect(xml).toContain(
      '<sitemap><loc>https://mention.earth/sitemaps/profiles-00-0.xml</loc><lastmod>2026-11-20T10:00:00.000Z</lastmod></sitemap>',
    );
    // An unknown lastmod is left out, never invented.
    expect(xml).toContain(
      '<sitemap><loc>https://mention.earth/sitemaps/posts-00-0.xml</loc></sitemap>',
    );
  });

  it("lists a page's images with Google's image extension, only when it has some", () => {
    const xml = renderUrlSet([
      { loc: 'https://mention.earth/p/1', images: ['https://cloud.oxy.so/a?x=1&y=2'] },
      { loc: 'https://mention.earth/p/2' },
    ]);

    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(xml).toContain(
      '<url><loc>https://mention.earth/p/1</loc><image:image><image:loc>https://cloud.oxy.so/a?x=1&amp;y=2</image:loc></image:image></url>',
    );
    expect(xml).toContain('<url><loc>https://mention.earth/p/2</loc></url>');
    expect(renderUrlSet([{ loc: 'https://mention.earth/p/2' }])).not.toContain('xmlns:image');
  });

  it('uses fixed-width stable bucket paths', () => {
    // One bucket: only Mention's own content is listed, in id (UUIDv7, time) order.
    expect(SITEMAP_BUCKET_COUNT).toBe(1);
    expect(shardPath('posts', { bucket: 5, page: 0 })).toBe('/sitemaps/posts-05-0.xml');
  });

  it('fails closed before a child sitemap exceeds the protocol URL limit', () => {
    const urls = Array.from({ length: SITEMAP_URL_LIMIT + 1 }, (_, index) => ({
      loc: `https://mention.earth/p/${index}`,
    }));
    expect(() => renderUrlSet(urls)).toThrow('Sitemap URL limit exceeded');
  });
});
