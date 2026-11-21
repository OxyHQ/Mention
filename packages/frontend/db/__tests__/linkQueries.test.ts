import { openNodeSqlite } from '@/test-support/nodeSqlite';
import { runMigrations } from '../migrations';

const mockDb = { current: null as ReturnType<typeof openNodeSqlite> | null };
jest.mock('../database', () => ({ getDb: () => mockDb.current }));

import {
  clearAllLinks,
  getLink,
  invalidateLink,
  isLinkCached,
  pruneExpiredLinks,
  upsertLink,
} from '../linkQueries';

/** The link-preview cache, on `mention.db`'s real schema. */
beforeEach(() => {
  mockDb.current = openNodeSqlite();
  runMigrations(mockDb.current as never);
});

const card = (url: string) => ({ url, title: 'Title', siteName: 'Site', fetchedAt: 0 });

describe('link preview cache', () => {
  it('stores a card under its normalised URL and reads it back by any spelling', () => {
    upsertLink(card('example.com/news/'));
    expect(getLink('https://example.com/news')).toMatchObject({
      url: 'https://example.com/news',
      title: 'Title',
      siteName: 'Site',
    });
    expect(isLinkCached('example.com/news/')).toBe(true);
    expect(isLinkCached('https://example.com/other')).toBe(false);
  });

  it('ignores what is not a URL', () => {
    upsertLink(card(''));
    upsertLink(card('http://[not a host'));
    expect(getLink('')).toBeNull();
    expect(isLinkCached('   ')).toBe(false);
    expect(mockDb.current?.getAllSync('SELECT url FROM link_previews')).toEqual([]);
  });

  it('expires a card after its time to live, lazily on read and all at once on prune', () => {
    upsertLink(card('https://a.example'));
    upsertLink(card('https://b.example'));
    mockDb.current?.runSync('UPDATE link_previews SET fetched_at = 0');
    expect(isLinkCached('https://a.example')).toBe(false);
    expect(getLink('https://a.example')).toBeNull();
    expect(pruneExpiredLinks()).toBe(1);
    expect(mockDb.current?.getAllSync('SELECT url FROM link_previews')).toEqual([]);
  });

  it('forgets one card, or all of them', () => {
    upsertLink(card('https://a.example'));
    upsertLink(card('https://b.example'));
    invalidateLink('a.example');
    expect(getLink('https://a.example')).toBeNull();
    expect(getLink('https://b.example')).not.toBeNull();
    clearAllLinks();
    expect(getLink('https://b.example')).toBeNull();
  });

  it('does nothing without a database (web)', () => {
    mockDb.current = null;
    upsertLink(card('https://a.example'));
    expect(getLink('https://a.example')).toBeNull();
    expect(isLinkCached('https://a.example')).toBe(false);
    expect(pruneExpiredLinks()).toBe(0);
    clearAllLinks();
    invalidateLink('https://a.example');
  });
});
