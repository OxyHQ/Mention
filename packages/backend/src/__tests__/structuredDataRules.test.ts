/**
 * The JSON-LD Mention serves, checked against Google's structured-data rules
 * (developers.google.com/search/docs/appearance/structured-data: Breadcrumb,
 * Profile page, Discussion forum / social media posting, Site names), offline.
 *
 * A local validator rather than the Rich Results Test: it walks every entity in
 * a document, nested ones included, the way Google's parser does, and fails on
 * a missing required property.
 */
import { describe, expect, it } from 'bun:test';
import type { HydratedPost } from '@mention/shared-types';
import { siteStructuredData } from '@mention/shared-types/seo';
import {
  mapHashtagOg,
  mapHomepageOg,
  mapPostOg,
  mapProfileOg,
} from '../services/webshell/webShellRenderer';

type Entity = Record<string, unknown>;

/** Every typed entity in a JSON-LD document, at any depth. */
function entities(node: unknown, found: Entity[] = []): Entity[] {
  if (Array.isArray(node)) {
    for (const item of node) entities(item, found);
  } else if (node && typeof node === 'object') {
    const entity = node as Entity;
    if (typeof entity['@type'] === 'string') found.push(entity);
    for (const value of Object.values(entity)) entities(value, found);
  }
  return found;
}

const isUrl = (value: unknown) => typeof value === 'string' && /^https?:\/\//.test(value);

/** Google's required properties, per type; the errors a Rich Results Test would report. */
function violations(document: unknown): string[] {
  const errors: string[] = [];
  for (const entity of entities(document)) {
    switch (entity['@type']) {
      case 'BreadcrumbList': {
        const items = entity.itemListElement as Entity[] | undefined;
        if (!Array.isArray(items) || items.length < 2) errors.push('BreadcrumbList: < 2 items');
        items?.forEach((item, index) => {
          if (item['@type'] !== 'ListItem') errors.push('BreadcrumbList: item is not a ListItem');
          if (item.position !== index + 1) errors.push('BreadcrumbList: position out of order');
          if (typeof item.name !== 'string' || !item.name) errors.push('BreadcrumbList: no name');
          if (index < items.length - 1 && !isUrl(item.item)) errors.push('BreadcrumbList: no item');
        });
        break;
      }
      case 'ProfilePage': {
        const main = entity.mainEntity as Entity | undefined;
        if (!main || !['Person', 'Organization'].includes(String(main['@type'])))
          errors.push('ProfilePage: mainEntity is not a Person or an Organization');
        if (!main?.name) errors.push('ProfilePage: mainEntity has no name');
        break;
      }
      case 'SocialMediaPosting': {
        const author = entity.author as Entity | undefined;
        if (!author?.name) errors.push('SocialMediaPosting: author has no name');
        if (!entity.datePublished) errors.push('SocialMediaPosting: no datePublished');
        if (!entity.text && !entity.image && !entity.video)
          errors.push('SocialMediaPosting: no text, image or video');
        break;
      }
      case 'SearchAction': {
        const target = entity.target as Entity | undefined;
        const template = String(target?.urlTemplate ?? '');
        if (!template.includes('{search_term_string}'))
          errors.push('SearchAction: urlTemplate lacks the placeholder');
        if (entity['query-input'] !== 'required name=search_term_string')
          errors.push('SearchAction: query-input does not name the placeholder');
        break;
      }
      case 'WebSite':
        if (!entity.name || !isUrl(entity.url)) errors.push('WebSite: no name or url');
        break;
    }
  }
  return errors;
}

const post = {
  id: 'p1',
  user: { id: 'u1', username: 'nate', name: { displayName: 'Nate' } },
  content: { text: 'hello world' },
  metadata: { createdAt: '2026-10-01T10:00:00.000Z' },
} as unknown as HydratedPost;

describe("Mention's structured data, against Google's rules", () => {
  it('a post: a valid SocialMediaPosting with a breadcrumb trail', () => {
    const jsonLd = mapPostOg(post, 'p1', { requiresWarning: false }).jsonLd;
    expect(violations(jsonLd)).toEqual([]);
    expect(entities(jsonLd).map((entity) => entity['@type'])).toContain('BreadcrumbList');
  });

  it('a profile: a valid ProfilePage with a breadcrumb trail', () => {
    const jsonLd = mapProfileOg({
      id: 'u1',
      username: 'nate',
      name: { displayName: 'Nate' },
    })?.jsonLd;
    expect(violations(jsonLd)).toEqual([]);
    expect(entities(jsonLd).map((entity) => entity['@type'])).toContain('BreadcrumbList');
  });

  it('a hashtag: a trail from the site to the tag', () => {
    const jsonLd = mapHashtagOg('cats', true).jsonLd;
    expect(violations(jsonLd)).toEqual([]);
    expect(entities(jsonLd).map((entity) => entity['@type'])).toContain('BreadcrumbList');
  });

  it('the homepage: a WebSite whose SearchAction names the search page', () => {
    const jsonLd = mapHomepageOg().jsonLd;
    expect(violations(jsonLd)).toEqual([]);
    const action = entities(jsonLd).find((entity) => entity['@type'] === 'SearchAction');
    expect((action?.target as Entity).urlTemplate).toBe(
      'https://mention.earth/search?q={search_term_string}',
    );
    expect(siteStructuredData({ origin: 'https://x.test', name: 'X' })).toBeTruthy();
  });

  it('the validator itself catches a broken trail', () => {
    expect(
      violations({
        '@type': 'BreadcrumbList',
        itemListElement: [{ '@type': 'ListItem', position: 2, name: '' }],
      }),
    ).not.toEqual([]);
  });
});
