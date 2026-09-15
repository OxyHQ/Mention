import { and, asc, eq, isNotNull, isNull, max, or, sql } from 'drizzle-orm';
import { normalizeUserIdentity, type User } from '@oxy.so/core';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { userSettings } from '../db/schema/userProfile';
import { discoverySafeSql } from '../mtn/feed/feedSafety';
import { config } from '../config';
import { createCache } from '../utils/cache';
import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { canonicalProfilePath } from './webShellRenderer';

/** Safely below Google's 50,000-URL and 50 MB limits. */
export const SITEMAP_URL_LIMIT = 40_000;
/** Stable hash buckets keep new rows from reshuffling the whole sitemap catalog. */
export const SITEMAP_BUCKET_COUNT = 64;
const OXY_BULK_BATCH_SIZE = 100;
const OXY_BULK_CONCURRENCY = 2;
const SITEMAP_CACHE_PREFIX = 'seo:sitemap:v5:';
const SITEMAP_FAILURE_PREFIX = 'seo:sitemap:failed:v1:';
/**
 * Sitemaps change slowly and a shard rebuild costs up to
 * `SITEMAP_URL_LIMIT / OXY_BULK_BATCH_SIZE` Oxy calls, all drawn from the ONE
 * per-egress-IP budget this backend shares with user-facing reads (feed privacy
 * lists). So a built sitemap is fresh for hours, and kept for days so a failed
 * refresh keeps serving the last good copy instead of re-asking Oxy.
 */
const SITEMAP_FRESH_MS = 6 * 60 * 60 * 1000;
const SITEMAP_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * After a failed build, every request for that sitemap answers 503 without
 * rebuilding for this long. Crawlers retry a 503 within seconds; without the
 * cooldown each retry repeated the whole Oxy fan-out against an exhausted budget.
 */
export const SITEMAP_FAILURE_COOLDOWN_SECONDS = 10 * 60;

const sitemapCache = createCache({
  name: 'seoSitemapCache',
  ttlSeconds: SITEMAP_TTL_SECONDS,
  staleAfterMs: SITEMAP_FRESH_MS,
});
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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

/** A sitemap build skipped because the same build failed moments ago. */
export class SitemapBuildCoolingDownError extends Error {
  constructor(cacheKey: string) {
    super(`Sitemap build ${cacheKey} failed recently; cooling down`);
    this.name = 'SitemapBuildCoolingDownError';
  }
}

/**
 * Serve a sitemap artifact from its long-lived SWR cache. A cold miss builds
 * inline; a stale hit is served while one background rebuild runs. Either kind
 * of rebuild is skipped during the failure cooldown, and a failed rebuild starts
 * one — so an Oxy outage or 429 costs one fan-out per cooldown, not one per
 * crawler retry.
 */
export async function cachedSitemapArtifact<T>(cacheKey: string, build: () => Promise<T>): Promise<T> {
  const failureKey = SITEMAP_FAILURE_PREFIX + cacheKey;
  return sitemapCache.getOrCompute<T>(SITEMAP_CACHE_PREFIX + cacheKey, async () => {
    if (await sitemapCache.has(failureKey)) {
      throw new SitemapBuildCoolingDownError(cacheKey);
    }
    try {
      return await build();
    } catch (error) {
      await sitemapCache.set(failureKey, true, { ttlSeconds: SITEMAP_FAILURE_COOLDOWN_SECONDS });
      logger.warn('[seoSitemap] Build failed; cooling down before the next attempt', {
        cacheKey,
        cooldownSeconds: SITEMAP_FAILURE_COOLDOWN_SECONDS,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }
  });
}

export async function sitemapCatalog(): Promise<SitemapCatalog> {
  return cachedSitemapArtifact('catalog', buildSitemapCatalog);
}

/**
 * Resolve users through Oxy's bulk endpoint in bounded batches. Deliberately NOT
 * `getUsersByIds`: that SDK method logs and swallows a failed chunk, which here
 * meant a 429 storm produced silently truncated sitemaps AND kept firing every
 * remaining batch into the exhausted budget. The first failed batch stops the
 * whole resolution and fails the build.
 */
export async function bulkUsers(ids: string[]): Promise<User[]> {
  const unique = Array.from(new Set(ids));
  const batches = Array.from(
    { length: Math.ceil(unique.length / OXY_BULK_BATCH_SIZE) },
    (_, index) => unique.slice(index * OXY_BULK_BATCH_SIZE, (index + 1) * OXY_BULK_BATCH_SIZE),
  );
  const resolved: User[][] = Array.from({ length: batches.length });
  let nextBatch = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(OXY_BULK_CONCURRENCY, batches.length) }, async () => {
    while (!failed && nextBatch < batches.length) {
      const index = nextBatch++;
      try {
        const users = await getServiceOxyClient().makeServiceRequest<User[]>(
          'POST',
          '/users/by-ids',
          { ids: batches[index] },
        );
        resolved[index] = Array.isArray(users) ? users.map((user) => normalizeUserIdentity(user)) : [];
      } catch (error) {
        failed = true;
        throw error;
      }
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

  // Oxy's bulk endpoint already applies the same archived/restricted
  // discoverability predicate as its public username route and returns only the
  // public DTO. Re-resolving every username here is both semantically redundant
  // and an N+1 request storm large enough to hit Oxy's public-profile limiter.
  return users;
}

async function cachedSitemapXml(cacheKey: string, build: () => Promise<string>): Promise<string> {
  const cached = await cachedSitemapArtifact<CompressedXml>(cacheKey, async () => ({
    encoding: 'gzip-base64-v1',
    data: (await gzipAsync(await build())).toString('base64'),
  }));
  if (cached.encoding !== 'gzip-base64-v1') {
    throw new Error('Sitemap cache entry has an unexpected encoding');
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
    `profiles:${shard.bucket}:${shard.page}`,
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
    `posts:${shard.bucket}:${shard.page}`,
    () => buildPostSitemap(shard),
  );
}
