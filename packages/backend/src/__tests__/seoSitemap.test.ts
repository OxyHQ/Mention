import { describe, expect, it } from 'vitest';
import {
  SITEMAP_BUCKET_COUNT,
  SITEMAP_URL_LIMIT,
  renderSitemapIndex,
  renderUrlSet,
  shardPath,
} from '../services/seoSitemap';

describe('SEO sitemap XML', () => {
  it('escapes URLs and emits real modification timestamps', () => {
    const xml = renderUrlSet([{
      loc: 'https://mention.earth/@a&b',
      lastModified: new Date('2026-09-08T12:00:00.000Z'),
    }]);

    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://mention.earth/@a&amp;b</loc>');
    expect(xml).toContain('<lastmod>2026-09-08T12:00:00.000Z</lastmod>');
  });

  it('builds separate stable profile and post sitemap pages', () => {
    const xml = renderSitemapIndex({
      profiles: [{ bucket: 0, page: 0 }, { bucket: 31, page: 0 }],
      posts: [{ bucket: 63, page: 2 }],
    });

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('https://mention.earth/sitemaps/profiles-00-0.xml');
    expect(xml).toContain('https://mention.earth/sitemaps/profiles-1f-0.xml');
    expect(xml).toContain('https://mention.earth/sitemaps/posts-3f-2.xml');
  });

  it('uses fixed-width stable bucket paths', () => {
    expect(SITEMAP_BUCKET_COUNT).toBe(64);
    expect(shardPath('posts', { bucket: 5, page: 0 })).toBe('/sitemaps/posts-05-0.xml');
  });

  it('fails closed before a child sitemap exceeds the protocol URL limit', () => {
    const urls = Array.from({ length: SITEMAP_URL_LIMIT + 1 }, (_, index) => ({
      loc: `https://mention.earth/p/${index}`,
    }));
    expect(() => renderUrlSet(urls)).toThrow('Sitemap URL limit exceeded');
  });
});
