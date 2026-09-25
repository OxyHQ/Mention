/**
 * The SEO sitemaps: `/sitemap.xml` and its 64 stable profile and post buckets.
 *
 * ## Built in one pass, off the request path (#1160)
 *
 * Each child sitemap used to be built on demand by its own query, and every one
 * of those queries read the whole eligible half of `posts` to keep one bucket in
 * 64: in Performance Insights the profile query cost ~30 s and the post query
 * ~18 s per call. Entries went stale after six hours on each task separately, so
 * a crawler walking the index rebuilt up to 128 of them per window per task —
 * ~50 profile builds an hour, 70% of Mention's database load, each holding a
 * request-pool connection for half a minute.
 *
 * Now {@link buildAllSitemaps} produces every child sitemap at once, from ONE
 * grouped read for the profiles and ONE streamed, bucket-ordered read for the
 * posts, and writes them to Redis followed by the catalog. It runs in
 * {@link SitemapBuildJob} on the scheduler leader, when the catalog is older than
 * {@link SITEMAP_REFRESH_MS}. Requests only READ that cache: no crawler, however
 * many URLs it asks for, can make this service query the database for a sitemap.
 *
 * A child sitemap that is not in the catalog is 404, never a build; an empty
 * cache (a fresh deployment, a flushed Redis) is 503 with a Retry-After until
 * the leader's first build lands.
 */

import { and, asc, eq, isNotNull, isNull, max, or, sql } from 'drizzle-orm';
import { normalizeUserIdentity, type User } from '@oxy.so/core';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { getDb, getPostgresClient } from '../db/postgres';
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
/**
 * Unchanged from the on-demand builder, deliberately: every child sitemap keeps
 * the key and the value shape it had, so the entries already in Redis keep
 * serving across the deploy that introduces the job, until its first build
 * replaces them.
 */
const SITEMAP_CACHE_PREFIX = 'seo:sitemap:v5:';
const CATALOG_KEY = `${SITEMAP_CACHE_PREFIX}catalog`;
/** How old the catalog may get before the leader rebuilds everything. */
export const SITEMAP_REFRESH_MS = 6 * 60 * 60 * 1000;
/**
 * Kept for days, so a run of failed builds (Oxy down, a deploy storm) keeps
 * serving the last good sitemaps rather than 503s.
 */
const SITEMAP_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Rows fetched per round trip while streaming the post sitemaps. */
const POST_STREAM_BATCH = 5_000;

/**
 * `staleAfterMs` is set only to keep the stored `{ value, cachedAt }` envelope,
 * which is the shape the entries already in Redis have; nothing here uses
 * `getOrCompute`, so it decides nothing else.
 */
const sitemapCache = createCache({
  name: 'seoSitemapCache',
  ttlSeconds: SITEMAP_TTL_SECONDS,
  staleAfterMs: SITEMAP_REFRESH_MS,
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

export type SitemapKind = 'profiles' | 'posts';

interface SitemapUrl {
  loc: string;
  lastModified?: Date | string;
}

export interface SitemapCatalog {
  profiles: SitemapShard[];
  posts: SitemapShard[];
  /**
   * When the build that wrote this catalog finished. Absent on a catalog left
   * by the on-demand builder, which the job therefore treats as due.
   */
  builtAt?: string;
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

/** The ONE definition of which bucket a post or profile lives in. */
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

export function shardPath(kind: SitemapKind, shard: SitemapShard): string {
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

function shardKey(kind: SitemapKind, shard: SitemapShard): string {
  return `${SITEMAP_CACHE_PREFIX}${kind}:${shard.bucket}:${shard.page}`;
}

/**
 * Resolve users through Oxy's bulk endpoint in bounded batches. Deliberately NOT
 * `getUsersByIds`: that SDK method logs and swallows a failed chunk, which here
 * meant a 429 storm produced silently truncated sitemaps AND kept firing every
 * remaining batch into the exhausted budget. The first failed batch stops the
 * whole resolution and fails the build.
 *
 * Oxy's bulk endpoint applies the same archived/restricted discoverability
 * predicate as its public username route and returns only the public DTO, so a
 * user it omits is one that must not be listed.
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

// ---------------------------------------------------------------------------
// Serving: cache reads only
// ---------------------------------------------------------------------------

/** No build has landed in this cache yet; answer 503 and let the crawler retry. */
export class SitemapNotReadyError extends Error {
  constructor() {
    super('No sitemap has been built yet');
    this.name = 'SitemapNotReadyError';
  }
}

export type SitemapShardLookup =
  | { status: 'ok'; xml: string; builtAt?: string }
  | { status: 'absent' };

export async function readSitemapCatalog(): Promise<SitemapCatalog | undefined> {
  return sitemapCache.get<SitemapCatalog>(CATALOG_KEY);
}

/** The root index, from the cached catalog. */
export async function sitemapIndex(): Promise<{ xml: string; builtAt?: string }> {
  const catalog = await readSitemapCatalog();
  if (!catalog) throw new SitemapNotReadyError();
  return { xml: renderSitemapIndex(catalog), builtAt: catalog.builtAt };
}

function inCatalog(catalog: SitemapCatalog, kind: SitemapKind, shard: SitemapShard): boolean {
  return catalog[kind].some((entry) => entry.bucket === shard.bucket && entry.page === shard.page);
}

/**
 * One child sitemap, from the cache. A shard the catalog does not list is
 * `absent` — a crawler probing bucket/page numbers gets a cheap 404, never a
 * query.
 */
export async function sitemapShard(kind: SitemapKind, shard: SitemapShard): Promise<SitemapShardLookup> {
  const catalog = await readSitemapCatalog();
  if (!catalog) throw new SitemapNotReadyError();
  if (!inCatalog(catalog, kind, shard)) return { status: 'absent' };
  const cached = await sitemapCache.get<CompressedXml>(shardKey(kind, shard));
  if (!cached) throw new SitemapNotReadyError();
  if (cached.encoding !== 'gzip-base64-v1') {
    throw new Error('Sitemap cache entry has an unexpected encoding');
  }
  const xml = (await gunzipAsync(Buffer.from(cached.data, 'base64'))).toString('utf8');
  return { status: 'ok', xml, builtAt: catalog.builtAt };
}

// ---------------------------------------------------------------------------
// Building: the leader's job
// ---------------------------------------------------------------------------

async function writeShard(kind: SitemapKind, shard: SitemapShard, urls: SitemapUrl[]): Promise<void> {
  const value: CompressedXml = {
    encoding: 'gzip-base64-v1',
    data: (await gzipAsync(renderUrlSet(urls))).toString('base64'),
  };
  await sitemapCache.set(shardKey(kind, shard), value);
}

/** Write one bucket's URLs as as many pages as it needs; returns the pages written. */
async function writeBucket(kind: SitemapKind, bucket: number, urls: SitemapUrl[]): Promise<SitemapShard[]> {
  const pages: SitemapShard[] = [];
  for (let page = 0; page * SITEMAP_URL_LIMIT < urls.length; page += 1) {
    const shard = { bucket, page };
    await writeShard(kind, shard, urls.slice(page * SITEMAP_URL_LIMIT, (page + 1) * SITEMAP_URL_LIMIT));
    pages.push(shard);
  }
  return pages;
}

interface ProfileRow {
  bucket: number;
  oxyUserId: string | null;
  lastModified: Date | string | null;
}

/**
 * Every profile sitemap, from ONE grouped read of the eligible posts. Returns
 * the pages written and the authors Oxy resolved as publicly listable, which is
 * exactly the author set the post sitemaps may list.
 */
async function buildProfileSitemaps(): Promise<{ pages: SitemapShard[]; listable: Set<string>; authors: number }> {
  const bucket = stableBucket(posts.oxyUserId);
  const rows: ProfileRow[] = await getDb()
    .select({ bucket, oxyUserId: posts.oxyUserId, lastModified: max(posts.updatedAt) })
    .from(posts)
    .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
    .where(publicSeoPost())
    .groupBy(posts.oxyUserId)
    .orderBy(asc(posts.oxyUserId));

  const ids = rows.flatMap((row) => row.oxyUserId ? [row.oxyUserId] : []);
  const users = await bulkUsers(ids);
  if (ids.length > 0 && users.length === 0) {
    throw new Error('Oxy returned no users for a non-empty author set');
  }
  const userById = new Map(users.filter((user) => user.username).map((user) => [user.id, user]));

  const urlsByBucket = new Map<number, SitemapUrl[]>();
  for (const row of rows) {
    const user = row.oxyUserId ? userById.get(row.oxyUserId) : undefined;
    if (!user) continue;
    const urls = urlsByBucket.get(row.bucket) ?? [];
    urls.push({
      loc: `${config.web.origin}${canonicalProfilePath(user)}`,
      lastModified: user.updatedAt ?? row.lastModified ?? undefined,
    });
    urlsByBucket.set(row.bucket, urls);
  }

  const pages: SitemapShard[] = [];
  for (const bucketId of [...urlsByBucket.keys()].sort((a, b) => a - b)) {
    pages.push(...await writeBucket('profiles', bucketId, urlsByBucket.get(bucketId) ?? []));
  }
  return { pages, listable: new Set(userById.keys()), authors: ids.length };
}

interface PostStreamRow {
  bucket: number;
  id: string;
  oxy_user_id: string | null;
  updated_at: Date | string | null;
}

/**
 * Every post sitemap, from ONE read streamed in bucket order: at most one
 * bucket's URLs are held in memory at a time, never the ~1.4M eligible rows.
 * The Redis writes for a finished bucket happen inside the cursor callback,
 * which holds the read's connection meanwhile; 64 buckets of a few hundred KB
 * each is well inside what that costs.
 */
async function buildPostSitemaps(listable: Set<string>): Promise<{ pages: SitemapShard[]; rows: number }> {
  const bucket = stableBucket(posts.id);
  const query = getDb()
    .select({
      bucket: sql<number>`${bucket}`.as('bucket'),
      id: posts.id,
      oxyUserId: posts.oxyUserId,
      updatedAt: posts.updatedAt,
    })
    .from(posts)
    .leftJoin(userSettings, eq(userSettings.oxyUserId, posts.oxyUserId))
    .where(publicSeoPost())
    .orderBy(asc(bucket), asc(posts.id))
    .toSQL();

  const pages: SitemapShard[] = [];
  let currentBucket: number | null = null;
  let urls: SitemapUrl[] = [];
  let rows = 0;

  const flush = async (): Promise<void> => {
    if (currentBucket !== null && urls.length > 0) {
      pages.push(...await writeBucket('posts', currentBucket, urls));
    }
    urls = [];
  };

  const consume = async (batch: PostStreamRow[]): Promise<void> => {
    for (const row of batch) {
      rows += 1;
      if (row.bucket !== currentBucket) {
        await flush();
        currentBucket = row.bucket;
      }
      if (row.oxy_user_id && listable.has(row.oxy_user_id)) {
        urls.push({
          loc: `${config.web.origin}/p/${encodeURIComponent(row.id)}`,
          lastModified: row.updated_at ?? undefined,
        });
      }
    }
  };

  await getPostgresClient().begin('read only', async (tx) => {
    // A cursor tells the planner only the first rows matter (`cursor_tuple_fraction`
    // defaults to 0.1), which prices an ordered index walk over a sort — and on
    // this table that walk fetches ~1.4M heap rows in hash order, i.e. at random.
    // Every row is read here, so plan for all of them: measured in production
    // (2026-09-25) the scan-and-sort plan is 11.2 s for the whole set.
    await tx.unsafe('set local cursor_tuple_fraction = 1');
    // postgres.js (3.4.x) awaits the callback for every FULL batch, but calls it
    // WITHOUT awaiting for the final partial one (`CommandComplete` in its
    // connection.js), so the cursor resolves while that batch is still being
    // consumed. Chaining the batches here, and awaiting the chain, is what
    // makes "the stream is done" true before the last bucket is flushed.
    let chain: Promise<void> = Promise.resolve();
    await tx
      .unsafe<PostStreamRow[]>(query.sql, query.params as never[])
      .cursor(POST_STREAM_BATCH, (batch) => {
        chain = chain.then(() => consume(batch));
        // Handled here so the final, unawaited batch cannot surface as an
        // unhandled rejection; `await chain` below still throws it.
        chain.catch(() => undefined);
        return chain;
      });
    await chain;
  });
  await flush();
  return { pages, rows };
}

export interface SitemapBuildReport {
  profilePages: number;
  postPages: number;
  authors: number;
  postRows: number;
  durationMs: number;
}

/**
 * Build and publish every sitemap. The catalog is written LAST, so the index
 * never names a child sitemap this build has not written; a build that fails
 * part-way leaves the previous catalog and its children serving.
 */
export async function buildAllSitemaps(): Promise<SitemapBuildReport> {
  const startedAt = Date.now();
  const profiles = await buildProfileSitemaps();
  const postSitemaps = await buildPostSitemaps(profiles.listable);
  const catalog: SitemapCatalog = {
    profiles: profiles.pages,
    posts: postSitemaps.pages,
    builtAt: new Date().toISOString(),
  };
  await sitemapCache.set(CATALOG_KEY, catalog);
  return {
    profilePages: profiles.pages.length,
    postPages: postSitemaps.pages.length,
    authors: profiles.authors,
    postRows: postSitemaps.rows,
    durationMs: Date.now() - startedAt,
  };
}

/** Whether the cached sitemaps are missing or older than {@link SITEMAP_REFRESH_MS}. */
export async function sitemapsAreDue(now: number = Date.now()): Promise<boolean> {
  const catalog = await readSitemapCatalog();
  if (!catalog?.builtAt) return true;
  const builtAt = Date.parse(catalog.builtAt);
  return !Number.isFinite(builtAt) || now - builtAt >= SITEMAP_REFRESH_MS;
}

/** How often the leader checks whether a build is due. */
export const SITEMAP_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** First check after boot, so a deploy's startup is never contended. */
export const SITEMAP_START_DELAY_MS = 2 * 60 * 1000;
/** After a failed build, wait this long before the next attempt. */
export const SITEMAP_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Leader-gated sitemap builder. Due-ness is read from the catalog's `builtAt`
 * in Redis, not from this timer: the service redeploys several times a day, so
 * a six-hour `setInterval` on the leader would rarely get to fire.
 */
export class SitemapBuildJob {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private building = false;
  private lastFailureAt = 0;

  start(): void {
    if (this.interval || this.startTimeout) return;
    this.startTimeout = setTimeout(() => {
      this.startTimeout = null;
      void this.tick();
      this.interval = setInterval(() => void this.tick(), SITEMAP_CHECK_INTERVAL_MS);
      this.interval.unref?.();
    }, SITEMAP_START_DELAY_MS);
    this.startTimeout.unref?.();
    logger.info('[SitemapBuildJob] started (leader-gated sitemap builds)');
  }

  stop(): void {
    if (this.startTimeout) clearTimeout(this.startTimeout);
    if (this.interval) clearInterval(this.interval);
    this.startTimeout = null;
    this.interval = null;
  }

  /** Build if due. Never throws; a failure is logged and backs off. */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.building) return;
    if (now - this.lastFailureAt < SITEMAP_FAILURE_BACKOFF_MS) return;
    this.building = true;
    try {
      if (!(await sitemapsAreDue(now))) return;
      const report = await buildAllSitemaps();
      logger.info('[SitemapBuildJob] built every sitemap', { ...report });
    } catch (error) {
      this.lastFailureAt = now;
      logger.warn('[SitemapBuildJob] build failed; keeping the previous sitemaps', {
        reason: error instanceof Error ? error.message : 'unknown',
        retryAfterMs: SITEMAP_FAILURE_BACKOFF_MS,
      });
    } finally {
      this.building = false;
    }
  }
}

export const sitemapBuildJob = new SitemapBuildJob();
