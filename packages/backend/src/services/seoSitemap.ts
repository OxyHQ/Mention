import { and, asc, eq, isNotNull, isNull, max, or, sql } from 'drizzle-orm';
import type { User } from '@oxyhq/core';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { userSettings } from '../db/schema/userProfile';
import { discoverySafeSql } from '../mtn/feed/feedSafety';
import { config } from '../config';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { createCache } from '../utils/cache';
import { canonicalProfilePath } from './webShellRenderer';
import { getShellCached } from './webShellOgCache';

/** Safely below Google's 50,000-URL and 50 MB limits. */
export const SITEMAP_URL_LIMIT = 40_000;
/** Stable hash buckets keep new rows from reshuffling the whole sitemap catalog. */
export const SITEMAP_BUCKET_COUNT = 64;
const OXY_BULK_BATCH_SIZE = 200;
const OXY_BULK_CONCURRENCY = 5;
const PROFILE_RESOLUTION_CONCURRENCY = 25;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const publicProfileCache = createCache({ name: 'seoSitemapPublicProfiles', ttlSeconds: 60 * 60 });
const PUBLIC_PROFILE_CACHE_PREFIX = 'sitemap:public-profile:v1:';

interface CompressedXml {
  encoding: 'gzip-base64-v1';
  data: string;
}

export interface SitemapShard {
  bucket: number;
  page: number;
}

interface SitemapUrl {
  loc: string;
  lastModified?: Date | string;
}

interface BucketCount {
  bucket: number;
  count: number;
}

export interface SitemapCatalog {
  profiles: SitemapShard[];
  posts: SitemapShard[];
}

export async function isMentionProfilePublic(oxyUserId: string | undefined): Promise<boolean> {
  if (!oxyUserId) return true;
  const [settings] = await getDb()
    .select({ visibility: userSettings.privacyProfileVisibility })
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, oxyUserId))
    .limit(1);
  return !settings || settings.visibility === 'public';
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

/** PostgreSQL expression shared by catalog counts and shard reads. */
function stableBucket(value: typeof posts.id | typeof posts.oxyUserId) {
  return sql<number>`mod(('x' || substr(md5(${value}), 1, 8))::bit(32)::bigint, ${sql.raw(String(SITEMAP_BUCKET_COUNT))})::int`;
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
  if (urls.length > SITEMAP_URL_LIMIT) throw new Error('Sitemap URL limit exceeded');
  const entries = urls.map(({ loc, lastModified }) => {
    const lastmod = isoDate(lastModified);
    return `<url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

export function shardPath(kind: 'profiles' | 'posts', shard: SitemapShard): string {
  const bucket = shard.bucket.toString(16).padStart(2, '0');
  return `/sitemaps/${kind}-${bucket}-${shard.page}.xml`;
}

export function renderSitemapIndex(catalog: SitemapCatalog): string {
  const urls = [
    ...catalog.profiles.map((shard) => `${config.web.origin}${shardPath('profiles', shard)}`),
    ...catalog.posts.map((shard) => `${config.web.origin}${shardPath('posts', shard)}`),
  ];
  if (urls.length > 50_000) throw new Error('Sitemap index limit exceeded');
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((loc) => `<sitemap><loc>${xmlEscape(loc)}</loc></sitemap>`).join('')}</sitemapindex>`;
}

function expandBuckets(rows: BucketCount[]): SitemapShard[] {
  return rows.flatMap(({ bucket, count }) =>
    Array.from({ length: Math.ceil(count / SITEMAP_URL_LIMIT) }, (_, page) => ({ bucket, page })),
  );
}

async function buildSitemapCatalog(): Promise<SitemapCatalog> {
  const postBucket = stableBucket(posts.id);
  const profileBucket = stableBucket(posts.oxyUserId);
  const [postRows, profileRows] = await Promise.all([
    getDb()
      .select({ bucket: postBucket, count: sql<number>`count(*)::int` })
      .from(posts)
      .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
      .where(publicSeoPost())
      .groupBy(postBucket)
      .orderBy(asc(postBucket)),
    getDb()
      .select({ bucket: profileBucket, count: sql<number>`count(distinct ${posts.oxyUserId})::int` })
      .from(posts)
      .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
      .where(publicSeoPost())
      .groupBy(profileBucket)
      .orderBy(asc(profileBucket)),
  ]);
  return { profiles: expandBuckets(profileRows), posts: expandBuckets(postRows) };
}

export async function sitemapCatalog(): Promise<SitemapCatalog> {
  const cached = await getShellCached('sitemap:catalog:v3', buildSitemapCatalog, { rethrow: true });
  if (!cached) throw new Error('Sitemap catalog unexpectedly empty');
  return cached;
}

async function bulkUsers(ids: string[]): Promise<User[]> {
  const unique = Array.from(new Set(ids));
  const batches = Array.from(
    { length: Math.ceil(unique.length / OXY_BULK_BATCH_SIZE) },
    (_, index) => unique.slice(index * OXY_BULK_BATCH_SIZE, (index + 1) * OXY_BULK_BATCH_SIZE),
  );
  const resolved: User[][] = Array.from({ length: batches.length });
  let nextBatch = 0;
  const workers = Array.from({ length: Math.min(OXY_BULK_CONCURRENCY, batches.length) }, async () => {
    while (nextBatch < batches.length) {
      const index = nextBatch++;
      resolved[index] = await getServiceOxyClient().getUsersByIds(batches[index]);
    }
  });
  await Promise.all(workers);
  return resolved.flat();
}

async function publiclyResolvableUsers(ids: string[]): Promise<User[]> {
  const users = await bulkUsers(ids);
  if (ids.length > 0 && users.length === 0) {
    throw new Error('Oxy returned no users for a non-empty sitemap shard');
  }

  const cacheKeys = users.map((user) => `${PUBLIC_PROFILE_CACHE_PREFIX}${user.id}`);
  const cachedProfiles = await publicProfileCache.getMany<User | null>(cacheKeys);
  const visibleById = new Map<string, User>();
  const missingUsers: User[] = [];
  cachedProfiles.forEach((profile, index) => {
    if (profile === undefined) {
      missingUsers.push(users[index]);
    } else if (profile) {
      visibleById.set(profile.id, profile);
    }
  });

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(PROFILE_RESOLUTION_CONCURRENCY, missingUsers.length) },
    async () => {
      while (nextIndex < missingUsers.length) {
        const user = missingUsers[nextIndex++];
        if (!user?.username) continue;
        try {
          const profile = await getServiceOxyClient().getProfileByUsername(user.username);
          visibleById.set(profile.id, profile);
          await publicProfileCache.set(`${PUBLIC_PROFILE_CACHE_PREFIX}${user.id}`, profile);
        } catch (error) {
          if (errorStatus(error) === 404) {
            await publicProfileCache.set(`${PUBLIC_PROFILE_CACHE_PREFIX}${user.id}`, null, { ttlSeconds: 5 * 60 });
            continue;
          }
          throw error;
        }
      }
    },
  );
  await Promise.all(workers);
  return users.flatMap((user) => visibleById.get(user.id) ?? []);
}

async function cachedSitemapXml(cacheKey: string, build: () => Promise<string>): Promise<string> {
  const cached = await getShellCached<CompressedXml>(cacheKey, async () => ({
    encoding: 'gzip-base64-v1',
    data: (await gzipAsync(await build())).toString('base64'),
  }), { rethrow: true });
  if (!cached || cached.encoding !== 'gzip-base64-v1') {
    throw new Error('Sitemap cache unexpectedly empty');
  }
  return (await gunzipAsync(Buffer.from(cached.data, 'base64'))).toString('utf8');
}

function validateShard(shard: SitemapShard): void {
  if (!Number.isSafeInteger(shard.bucket) || shard.bucket < 0 || shard.bucket >= SITEMAP_BUCKET_COUNT) {
    throw new Error('Invalid sitemap bucket');
  }
  if (!Number.isSafeInteger(shard.page) || shard.page < 0) throw new Error('Invalid sitemap page');
}

async function buildProfileSitemap(shard: SitemapShard): Promise<string> {
  validateShard(shard);
  const bucket = stableBucket(posts.oxyUserId);
  const rows = await getDb()
    .select({ oxyUserId: posts.oxyUserId, lastModified: max(posts.updatedAt) })
    .from(posts)
    .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
    .where(and(publicSeoPost(), eq(bucket, shard.bucket)))
    .groupBy(posts.oxyUserId)
    .orderBy(asc(posts.oxyUserId))
    .limit(SITEMAP_URL_LIMIT)
    .offset(shard.page * SITEMAP_URL_LIMIT);

  const ids = rows.flatMap((row) => row.oxyUserId ? [row.oxyUserId] : []);
  const users = await publiclyResolvableUsers(ids);
  const modifiedById = new Map(rows.flatMap((row) => row.oxyUserId ? [[row.oxyUserId, row.lastModified] as const] : []));
  return renderUrlSet(users.flatMap((user) => user.username ? [{
    loc: `${config.web.origin}${canonicalProfilePath(user)}`,
    lastModified: user.updatedAt ?? modifiedById.get(user.id) ?? undefined,
  }] : []));
}

export async function profileSitemap(shard: SitemapShard): Promise<string> {
  validateShard(shard);
  return cachedSitemapXml(
    `sitemap:profiles:v4:${shard.bucket}:${shard.page}`,
    () => buildProfileSitemap(shard),
  );
}

async function buildPostSitemap(shard: SitemapShard): Promise<string> {
  validateShard(shard);
  const bucket = stableBucket(posts.id);
  const rows = await getDb()
    .select({ id: posts.id, oxyUserId: posts.oxyUserId, lastModified: posts.updatedAt })
    .from(posts)
    .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
    .where(and(publicSeoPost(), eq(bucket, shard.bucket)))
    .orderBy(asc(posts.id))
    .limit(SITEMAP_URL_LIMIT)
    .offset(shard.page * SITEMAP_URL_LIMIT);

  const authorIds = Array.from(new Set(rows.flatMap((row) => row.oxyUserId ? [row.oxyUserId] : [])));
  const users = await publiclyResolvableUsers(authorIds);
  const visibleAuthors = new Set(users.map((user) => user.id));
  return renderUrlSet(rows.flatMap((row) =>
    row.oxyUserId && visibleAuthors.has(row.oxyUserId)
      ? [{ loc: `${config.web.origin}/p/${encodeURIComponent(row.id)}`, lastModified: row.lastModified }]
      : [],
  ));
}

export async function postSitemap(shard: SitemapShard): Promise<string> {
  validateShard(shard);
  return cachedSitemapXml(
    `sitemap:posts:v4:${shard.bucket}:${shard.page}`,
    () => buildPostSitemap(shard),
  );
}
