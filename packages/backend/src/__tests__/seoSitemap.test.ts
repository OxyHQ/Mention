import { describe, expect, it } from 'vitest';
import { renderSitemapIndex, renderUrlSet } from '../services/seoSitemap';

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
    const xml = renderSitemapIndex(2, 1);

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('https://mention.earth/sitemaps/profiles-0.xml');
    expect(xml).toContain('https://mention.earth/sitemaps/profiles-1.xml');
    expect(xml).toContain('https://mention.earth/sitemaps/posts-0.xml');
  });
});
