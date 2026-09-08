import { and, asc, countDistinct, eq, isNotNull, isNull, max, or, sql } from 'drizzle-orm';
import type { User } from '@oxyhq/core';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { userSettings } from '../db/schema/userProfile';
import { discoverySafeSql } from '../mtn/feed/feedSafety';
import { config } from '../config';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { canonicalProfilePath } from './webShellRenderer';

export const SITEMAP_PAGE_SIZE = 250;
const PROFILE_RESOLUTION_CONCURRENCY = 10;

interface SitemapUrl {
  loc: string;
  lastModified?: Date | string;
}

function publicSeoPost(): ReturnType<typeof and> {
  return and(
    eq(posts.visibility, 'public'),
    eq(posts.status, 'published'),
    discoverySafeSql(),
    isNotNull(posts.oxyUserId),
    or(isNull(userSettings.privacyProfileVisibility), eq(userSettings.privacyProfileVisibility, 'public')),
  );
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isoDate(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = 'status' in error ? error.status : undefined;
  if (typeof direct === 'number') return direct;
  const response = 'response' in error ? error.response : undefined;
  if (!response || typeof response !== 'object' || !('status' in response)) return undefined;
  return typeof response.status === 'number' ? response.status : undefined;
}

export function renderUrlSet(urls: SitemapUrl[]): string {
  const entries = urls.map(({ loc, lastModified }) => {
    const lastmod = isoDate(lastModified);
    return `<url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

export function renderSitemapIndex(profilePages: number, postPages: number): string {
  const urls = [
    ...Array.from({ length: profilePages }, (_, page) => `${config.web.origin}/sitemaps/profiles-${page}.xml`),
    ...Array.from({ length: postPages }, (_, page) => `${config.web.origin}/sitemaps/posts-${page}.xml`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((loc) => `<sitemap><loc>${xmlEscape(loc)}</loc></sitemap>`).join('')}</sitemapindex>`;
}

export async function sitemapPageCounts(): Promise<{ profiles: number; posts: number }> {
  const [postCountRows, profileCountRows] = await Promise.all([
    getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
      .where(publicSeoPost()),
    getDb()
      .select({ count: countDistinct(posts.oxyUserId) })
      .from(posts)
      .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
      .where(publicSeoPost()),
  ]);
  return {
    profiles: Math.ceil(Number(profileCountRows[0]?.count ?? 0) / SITEMAP_PAGE_SIZE),
    posts: Math.ceil(Number(postCountRows[0]?.count ?? 0) / SITEMAP_PAGE_SIZE),
  };
}

async function publiclyResolvableUsers(ids: string[]): Promise<User[]> {
  const users = await getServiceOxyClient().getUsersByIds(ids);
  if (ids.length > 0 && users.length === 0) {
    throw new Error('Oxy returned no users for a non-empty sitemap page');
  }

  // `/users/by-ids` intentionally supports private-account feed hydration, so
  // it cannot decide search indexability. Re-read by public username: that
  // endpoint applies Oxy's people-search privacy gate and 404s private,
  // restricted, and archived accounts. Keep concurrency bounded because a
  // sitemap page may contain hundreds of distinct authors.
  const visible: User[] = [];
  let nextIndex = 0;
  let successfulLookups = 0;
  const workers = Array.from(
    { length: Math.min(PROFILE_RESOLUTION_CONCURRENCY, users.length) },
    async () => {
      while (nextIndex < users.length) {
        const user = users[nextIndex++];
        if (!user?.username) continue;
        try {
          const profile = await getServiceOxyClient().getProfileByUsername(user.username);
          successfulLookups += 1;
          visible.push(profile);
        } catch (error) {
          // A private/restricted/archived profile is deliberately absent from
          // this public endpoint. Mixed failures therefore fail closed per row.
          if (errorStatus(error) === 404) successfulLookups += 1;
        }
      }
    },
  );
  await Promise.all(workers);
  if (users.length > 0 && successfulLookups === 0) {
    throw new Error('Oxy public profile lookups all failed for a sitemap page');
  }
  return visible;
}

export async function profileSitemap(page: number): Promise<string> {
  const rows = await getDb()
    .select({
      oxyUserId: posts.oxyUserId,
      lastModified: max(posts.updatedAt),
    })
    .from(posts)
    .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
    .where(publicSeoPost())
    .groupBy(posts.oxyUserId)
    .orderBy(asc(posts.oxyUserId))
    .limit(SITEMAP_PAGE_SIZE)
    .offset(page * SITEMAP_PAGE_SIZE);

  const ids = rows.flatMap((row) => row.oxyUserId ? [row.oxyUserId] : []);
  const users = await publiclyResolvableUsers(ids);
  const modifiedById = new Map(rows.flatMap((row) => row.oxyUserId ? [[row.oxyUserId, row.lastModified] as const] : []));
  return renderUrlSet(users.flatMap((user) => user.username ? [{
    loc: `${config.web.origin}${canonicalProfilePath(user)}`,
    lastModified: user.updatedAt ?? modifiedById.get(user.id) ?? undefined,
  }] : []));
}

export async function postSitemap(page: number): Promise<string> {
  const rows = await getDb()
    .select({ id: posts.id, oxyUserId: posts.oxyUserId, lastModified: posts.updatedAt })
    .from(posts)
    .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
    .where(publicSeoPost())
    .orderBy(asc(posts.id))
    .limit(SITEMAP_PAGE_SIZE)
    .offset(page * SITEMAP_PAGE_SIZE);

  const authorIds = Array.from(new Set(rows.flatMap((row) => row.oxyUserId ? [row.oxyUserId] : [])));
  const users = await publiclyResolvableUsers(authorIds);
  const visibleAuthors = new Set(users.map((user) => user.id));
  return renderUrlSet(rows.flatMap((row) =>
    row.oxyUserId && visibleAuthors.has(row.oxyUserId)
      ? [{ loc: `${config.web.origin}/p/${encodeURIComponent(row.id)}`, lastModified: row.lastModified }]
      : [],
  ));
}
