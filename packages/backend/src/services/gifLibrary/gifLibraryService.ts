import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';

import { desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { isUniqueViolation, qualified } from '@oxyhq/db';
import { getDb } from '../../db/postgres';
import { gifs } from '../../db/schema/discovery';
import { logger } from '../../utils/logger';
import { SsrfRejection } from '@oxyhq/core/server';
import { fetchUpstreamFollowingRedirects } from '../../utils/safeUpstreamFetch';
import { uploadGifLibraryMedia } from '../mediaCache/oxyMediaStore';
import type { KlipyGifItem } from '../gifService';
import {
  GIF_DEFAULT_DIMENSION,
  GIF_DOWNLOAD_SOCKET_TIMEOUT_MS,
  GIF_IMPORT_CONCURRENCY,
  GIF_IMPORT_MAX_BYTES,
  GIF_LIBRARY_WRITE_ENABLED,
  GIF_SEARCH_TERM_MAX,
  GIF_STOPWORDS,
  GIF_TEMP_DIR_PREFIX,
  GIF_TEMP_NAME_RANDOM_BYTES,
  GIF_TERM_MAX_LEN,
  GIF_UPLOAD_CONTENT_TYPE,
} from './constants';

/** HTTP status that carries a full body we can import. */
const HTTP_OK = 200;

/** One row of the owned GIF library, exactly as the database stores it. */
export type GifRecord = typeof gifs.$inferSelect;

/**
 * `ts_rank` weights for GIF search, in Postgres's `{D, C, B, A}` order.
 *
 * Mongo's `gif_search_text` index declares `weights: { searchTerms: 5, title: 1 }`,
 * so a term hit in `searchTerms` must count FIVE times a hit in `title`. Postgres's
 * defaults are `{0.1, 0.2, 0.4, 1.0}` and reproduce nothing of the sort — a
 * default-ranked search compiles, runs, and returns a different order.
 *
 * The buckets are D and B rather than the A and B the schema's docblock names,
 * and that is measured rather than assumed: `gifs.search_vector` is built as
 * `setweight(array_to_tsvector(search_terms), 'A') || setweight(to_tsvector('simple', title), 'B')`,
 * and **`setweight` on an `array_to_tsvector` result is a no-op** —
 * `array_to_tsvector` emits lexemes with NO positions (`'alpha' 'beta'`), a weight
 * label lives on a position, so there is nothing to label and `ts_rank` scores
 * those lexemes in the default D bucket. `to_tsvector('simple', title)` does carry
 * positions, so the title half really is labelled B (`'alpha':1B`). Verified
 * against PostgreSQL 17.5: `setweight(array_to_tsvector(array['alpha']),'A')`
 * renders `'alpha'`, unchanged.
 *
 * Hence D = 1.0 (searchTerms) and B = 0.2 (title): 1.0 / 0.2 = 5, Mongo's ratio.
 * C and A are 0 because nothing in this vector can carry those labels — and if a
 * future schema change makes the `A` label real, `gifSearchVectorLabels` in
 * `__tests__/services/gifLibraryService.test.ts` goes red and names this constant
 * rather than letting the ordering silently invert.
 */
const GIF_RANK_WEIGHTS = '{1.0, 0, 0.2, 0}';

/**
 * Normalized, provider-agnostic shape the importer consumes. Built from a raw
 * Klipy item (search/trending top-up) or from the client-sent `GifItem` (the
 * `POST /use` body for a GIF that may not yet be in the library).
 */
export interface GifImportCandidate {
  /** Provider id (dedup key). */
  klipyId: string;
  slug: string;
  title: string;
  /** Full mp4 URL to download as the shared post source. */
  mp4Url: string;
  /** Small mp4 URL to download as the picker preview (falls back to `mp4Url`). */
  previewUrl: string;
  width: number;
  height: number;
  /** Optional extra tokens (provider tags) folded into `searchTerms`. */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize free text into search-term tokens: lowercase, strip diacritics and
 * punctuation, split on whitespace, drop stop words / empty / over-long tokens.
 *
 * This is the ONLY place stemming-free token hygiene happens, and BOTH the stored
 * terms and every query go through it. That was the meaning of the Mongo index's
 * `default_language: 'none'`, and it is what makes the Postgres port faithful:
 * `search_terms` is indexed with `array_to_tsvector` (each element a lexeme
 * verbatim, no dictionary) and matched against a bare `::tsquery` cast (also no
 * dictionary), so the two sides can only agree because this function already
 * made them agree. Output is `[a-z0-9]+` tokens, which {@link toTsQuery} relies on.
 */
export function normalizeToTerms(input: string | undefined | null): string[] {
  if (!input || typeof input !== 'string') return [];
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 0 && token.length <= GIF_TERM_MAX_LEN && !GIF_STOPWORDS.has(token),
    );
}

/** Build the deduped, capped search-term set for a candidate (+ surfaced query term). */
function buildSearchTerms(candidate: GifImportCandidate, queryTerm?: string): string[] {
  const tokens: string[] = [];
  if (queryTerm) tokens.push(...normalizeToTerms(queryTerm));
  tokens.push(...normalizeToTerms(candidate.title));
  tokens.push(...normalizeToTerms(candidate.slug?.replace(/-/g, ' ')));
  for (const tag of candidate.tags ?? []) tokens.push(...normalizeToTerms(tag));
  return [...new Set(tokens)].slice(0, GIF_SEARCH_TERM_MAX);
}

// ---------------------------------------------------------------------------
// Klipy mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Klipy item to a normalized {@link GifImportCandidate}. Returns null
 * when the item has no id or no usable mp4 (we import GIFs as mp4 only). The
 * preview prefers the small/extra-small mp4 per the design (`sm.mp4` → `xs.mp4`
 * → `md.mp4` → full).
 */
export function klipyItemToCandidate(item: KlipyGifItem): GifImportCandidate | null {
  const klipyId = String(item.id ?? item.slug ?? '').trim();
  if (!klipyId) return null;

  const fullFile = item.file?.hd || item.file?.md || item.file?.sm;
  const thumbnailFile = item.file?.md || item.file?.sm || item.file?.hd;

  const mp4Url = fullFile?.mp4?.url || thumbnailFile?.mp4?.url || '';
  if (!mp4Url) return null;

  const previewUrl =
    item.file?.sm?.mp4?.url ||
    item.file?.xs?.mp4?.url ||
    item.file?.md?.mp4?.url ||
    mp4Url;

  const width =
    fullFile?.mp4?.width || fullFile?.gif?.width || thumbnailFile?.gif?.width || GIF_DEFAULT_DIMENSION;
  const height =
    fullFile?.mp4?.height || fullFile?.gif?.height || thumbnailFile?.gif?.height || GIF_DEFAULT_DIMENSION;

  return {
    klipyId,
    slug: item.slug || '',
    title: item.title || '',
    mp4Url,
    previewUrl,
    width,
    height,
    tags: item.tags,
  };
}

/** Map a page of raw Klipy items to importable candidates, dropping unusable ones. */
export function mapKlipyItemsToCandidates(items: KlipyGifItem[]): GifImportCandidate[] {
  return items
    .map(klipyItemToCandidate)
    .filter((candidate): candidate is GifImportCandidate => candidate !== null);
}

// ---------------------------------------------------------------------------
// Local reads
// ---------------------------------------------------------------------------

/**
 * The `tsquery` for a set of already-normalized terms — an OR over them, which is
 * what Mongo's `$text` did with a space-separated string.
 *
 * The lexemes are spelled out and the whole thing is CAST from text rather than
 * run through `to_tsquery`/`plainto_tsquery`, because the stored `search_terms`
 * half of the vector is `array_to_tsvector`: every element is a lexeme VERBATIM,
 * with no dictionary applied. `tsquery`'s input function is the only spelling
 * that matches that — it applies no dictionary either. That equivalence is what
 * `default_language: 'none'` meant on the Mongo index, and {@link normalizeToTerms}
 * (which both the stored terms and the query go through) is what makes it safe.
 *
 * Quoting is unconditional but the tokens cannot contain a quote: `normalizeToTerms`
 * emits `[a-z0-9]+` only. The value is bound as a PARAMETER regardless, so the
 * worst a malformed token could do is raise a `tsquery` syntax error, which the
 * callers already degrade to "no local hits".
 */
function toTsQuery(terms: string[]): string {
  return terms.map((term) => `'${term}'`).join(' | ');
}

/**
 * Local-first text search over the owned library. Ranked by text relevance — with
 * the EXPLICIT weights that reproduce Mongo's 5:1 `searchTerms`:`title` ratio, see
 * {@link GIF_RANK_WEIGHTS} — then most-posted, then most-recently-used, then `id`.
 *
 * `id` is not decoration: rank, `use_count` and `last_used_at` can all tie (they
 * do, routinely, between two GIFs imported in the same burst), and a `limit` over
 * a non-total order returns an arbitrary, run-to-run-varying slice of the tied
 * rows. Mongo had the same hole; a keyset that can repeat or skip is worse here
 * because the picker merges these hits with a paginated Klipy page.
 *
 * Never throws — a search failure degrades to "no local hits" so the route still
 * tops up from Klipy.
 */
export async function searchLocal(queryTerms: string, limit: number): Promise<GifRecord[]> {
  const terms = normalizeToTerms(queryTerms);
  if (terms.length === 0) return [];
  const query = toTsQuery(terms);
  try {
    return await getDb()
      .select()
      .from(gifs)
      .where(sql`${gifs.searchVector} @@ ${query}::tsquery`)
      .orderBy(
        sql`ts_rank(${GIF_RANK_WEIGHTS}::float4[], ${gifs.searchVector}, ${query}::tsquery) desc`,
        desc(gifs.useCount),
        desc(gifs.lastUsedAt),
        desc(gifs.id),
      )
      .limit(limit);
  } catch (error) {
    logger.warn('[GifLibrary] searchLocal failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
}

/**
 * Local trending: the most-posted owned GIFs (requires at least one real use so a
 * fresh, never-posted import is not mislabeled as trending). Never throws.
 *
 * `id` closes the same non-total-order hole as in {@link searchLocal}.
 */
export async function getLocalTrending(limit: number): Promise<GifRecord[]> {
  try {
    return await getDb()
      .select()
      .from(gifs)
      .where(gte(gifs.useCount, 1))
      .orderBy(desc(gifs.useCount), desc(gifs.lastUsedAt), desc(gifs.id))
      .limit(limit);
  } catch (error) {
    logger.warn('[GifLibrary] getLocalTrending failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
}

/** Resolve which of the given provider ids are already imported (klipyId → row). */
export async function getImportedByKlipyIds(klipyIds: string[]): Promise<Map<string, GifRecord>> {
  const ids = [...new Set(klipyIds.filter((id) => Boolean(id)))];
  if (ids.length === 0) return new Map();
  try {
    // `inArray`, never `= any(${ids})`: a raw JS array interpolated into `sql`
    // binds as a ROW constructor and Postgres refuses it outright.
    const rows = await getDb().select().from(gifs).where(inArray(gifs.klipyId, ids));
    return new Map(rows.map((row) => [row.klipyId, row]));
  } catch (error) {
    logger.warn('[GifLibrary] getImportedByKlipyIds failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Import (download → upload → index)
// ---------------------------------------------------------------------------

/** Single-flight guard so the same klipyId is never downloaded/uploaded twice concurrently. */
const inFlight = new Map<string, Promise<GifRecord | null>>();

/** Token-passing semaphore bounding concurrent NEW background imports. */
let activeImports = 0;
const importWaiters: Array<() => void> = [];

function acquireImportSlot(): Promise<void> {
  if (activeImports < GIF_IMPORT_CONCURRENCY) {
    activeImports += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => importWaiters.push(resolve));
}

function releaseImportSlot(): void {
  const next = importWaiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter (activeImports stays constant).
    next();
  } else {
    activeImports -= 1;
  }
}

/**
 * Look up one owned row by its provider id, or `null`.
 *
 * No id-shape guard, and none is wanted: `klipy_id` is a provider string, and one
 * that names no row already answers "not imported".
 */
async function findByKlipyId(klipyId: string): Promise<GifRecord | null> {
  const [row] = await getDb().select().from(gifs).where(eq(gifs.klipyId, klipyId)).limit(1);
  return row ?? null;
}

/**
 * Append a candidate's terms to an existing row and count the resurfacing.
 *
 * The append stays a SINGLE statement, as Mongo's `$addToSet` + `$inc` was: two
 * concurrent surfacings of the same GIF (the picker fans these out) would lose
 * one another's terms through a read-merge-write. The set semantics are spelled
 * out because Postgres arrays have no `$addToSet`: only terms not already present
 * are appended, in their incoming order, so existing order is preserved exactly
 * as `$addToSet` preserved it.
 *
 * `qualified()` on the correlated reference is defensive rather than load-bearing
 * HERE, and the distinction is measured: drizzle 0.45.2 strips a column's table
 * prefix in exactly one position — the SELECT LIST of a single-table select — and
 * an `update … set` is not it, so this renders `"gifs"."search_terms"` either
 * way. It is written out because that property belongs to the surrounding
 * statement, not to this expression, and a bare reference that silently starts
 * resolving elsewhere would either duplicate every term or drop every new one
 * with nothing failing.
 *
 * `sql.param(terms)` rather than `${terms}`: a raw JS array interpolated into
 * `sql` binds as a ROW CONSTRUCTOR (`($1, $2)`), which `unnest` refuses at
 * runtime with nothing to catch it at compile time.
 */
async function appendSearchTerms(
  existing: GifRecord,
  candidate: GifImportCandidate,
  queryTerm?: string,
): Promise<GifRecord> {
  const terms = buildSearchTerms(candidate, queryTerm);
  try {
    const [updated] = await getDb()
      .update(gifs)
      .set({
        searchTerms: sql`${gifs.searchTerms} || (
          select coalesce(array_agg(incoming.term order by incoming.ord), '{}'::text[])
          from unnest(${sql.param(terms)}::text[]) with ordinality as incoming(term, ord)
          where not (incoming.term = any(${qualified(gifs.searchTerms)}))
        )`,
        searchHitCount: sql`${gifs.searchHitCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(gifs.klipyId, existing.klipyId))
      .returning();
    return updated ?? existing;
  } catch (error) {
    logger.warn('[GifLibrary] appendSearchTerms failed', {
      klipyId: existing.klipyId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return existing;
  }
}

interface DownloadedMedia {
  filePath: string;
  sizeBytes: number;
}

/**
 * Stream a remote GIF source URL to a temp file, SSRF-guarded and size-capped.
 * Never throws — returns null on any failure (best-effort import path).
 */
async function downloadToTempFile(url: string, dir: string): Promise<DownloadedMedia | null> {
  const abortController = new AbortController();
  let response: IncomingMessage;
  try {
    const upstream = await fetchUpstreamFollowingRedirects(url, {}, abortController.signal);
    response = upstream.response;
  } catch (error) {
    if (error instanceof SsrfRejection) {
      logger.warn('[GifLibrary] SSRF rejected GIF source', { reason: error.message });
    } else {
      logger.warn('[GifLibrary] GIF source fetch failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return null;
  }

  const status = response.statusCode ?? 0;
  if (status !== HTTP_OK) {
    response.resume();
    logger.warn('[GifLibrary] GIF source returned non-OK', { status });
    return null;
  }

  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > GIF_IMPORT_MAX_BYTES) {
    response.destroy();
    logger.warn('[GifLibrary] GIF source over cap (declared)', { declared });
    return null;
  }

  const filePath = join(dir, `${randomBytes(GIF_TEMP_NAME_RANDOM_BYTES).toString('hex')}.mp4`);
  response.setTimeout(GIF_DOWNLOAD_SOCKET_TIMEOUT_MS, () => {
    response.destroy(new Error('GIF source socket idle timeout'));
  });

  let streamed = 0;
  let overCap = false;
  response.on('data', (chunk: Buffer) => {
    streamed += chunk.length;
    if (streamed > GIF_IMPORT_MAX_BYTES && !overCap) {
      overCap = true;
      response.destroy(new Error('GIF source exceeds size cap'));
    }
  });

  try {
    await pipeline(response, createWriteStream(filePath));
  } catch (error) {
    if (overCap) {
      logger.warn('[GifLibrary] GIF source over cap (streamed)', { streamed });
    } else {
      logger.warn('[GifLibrary] GIF source stream-to-disk failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return null;
  }

  const { size } = await stat(filePath);
  return { filePath, sizeBytes: size };
}

/** Build a stable, safe upload filename for a GIF object. */
function deriveUploadName(candidate: GifImportCandidate, role: 'mp4' | 'preview.mp4'): string {
  const base = (candidate.slug || candidate.klipyId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  return `gif-${base}-${role}`;
}

/**
 * Actually import a not-yet-owned GIF: re-check the DB (it may have been imported
 * since the caller looked), download the full mp4 + small preview, upload BOTH to
 * the shared `gif-library` namespace on Oxy S3, and create the `Gif` row. Best
 * effort: returns null (never throws) on any failure; tolerates a concurrent
 * cross-process import via the unique-key race handler.
 */
async function importGif(candidate: GifImportCandidate, queryTerm?: string): Promise<GifRecord | null> {
  const { klipyId } = candidate;

  const existing = await findByKlipyId(klipyId);
  if (existing) return appendSearchTerms(existing, candidate, queryTerm);

  if (!candidate.mp4Url) {
    logger.warn('[GifLibrary] Skipping import — candidate has no mp4Url', { klipyId });
    return null;
  }

  const dir = await mkdtemp(join(tmpdir(), GIF_TEMP_DIR_PREFIX));
  try {
    const full = await downloadToTempFile(candidate.mp4Url, dir);
    if (!full) return null;

    const mp4 = await uploadGifLibraryMedia({
      filePath: full.filePath,
      contentType: GIF_UPLOAD_CONTENT_TYPE,
      originalName: deriveUploadName(candidate, 'mp4'),
      sizeBytes: full.sizeBytes,
    });
    const mp4FileId = mp4.oxyFileId;

    // Preview: best-effort small mp4. Fall back to the full mp4 file id so the
    // picker tile always has a usable source even if the preview download fails
    // or the provider only gave us one size.
    let previewFileId = mp4FileId;
    if (candidate.previewUrl && candidate.previewUrl !== candidate.mp4Url) {
      const preview = await downloadToTempFile(candidate.previewUrl, dir);
      if (preview) {
        const uploadedPreview = await uploadGifLibraryMedia({
          filePath: preview.filePath,
          contentType: GIF_UPLOAD_CONTENT_TYPE,
          originalName: deriveUploadName(candidate, 'preview.mp4'),
          sizeBytes: preview.sizeBytes,
        });
        previewFileId = uploadedPreview.oxyFileId;
      }
    }

    const [created] = await getDb()
      .insert(gifs)
      .values({
        klipyId,
        source: 'klipy',
        slug: candidate.slug || '',
        title: candidate.title || '',
        searchTerms: buildSearchTerms(candidate, queryTerm),
        width: candidate.width || GIF_DEFAULT_DIMENSION,
        height: candidate.height || GIF_DEFAULT_DIMENSION,
        mp4FileId,
        previewFileId,
        useCount: 0,
        searchHitCount: 1,
        lastUsedAt: new Date(),
      })
      .returning();

    logger.info('[GifLibrary] Imported GIF', {
      klipyId,
      gifId: created.id,
      mp4FileId,
      previewFileId,
    });
    return created;
  } catch (error) {
    // A concurrent process imported the same klipyId between our check and insert.
    // The constraint is NAMED: `isUniqueViolation(error)` alone would also match a
    // future index on this table and send an unrelated failure down the "someone
    // else won the race" path.
    if (isUniqueViolation(error, 'gifs_klipy_id_key')) {
      const winner = await findByKlipyId(klipyId);
      if (winner) return appendSearchTerms(winner, candidate, queryTerm);
    }
    logger.warn('[GifLibrary] GIF import failed', {
      klipyId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn('[GifLibrary] Failed to remove GIF import temp dir', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    });
  }
}

/** Single-flight wrapper: dedup concurrent imports of the same klipyId. */
function importSingleFlight(candidate: GifImportCandidate, queryTerm?: string): Promise<GifRecord | null> {
  const { klipyId } = candidate;
  const pending = inFlight.get(klipyId);
  if (pending) return pending;

  const task = importGif(candidate, queryTerm).finally(() => inFlight.delete(klipyId));
  inFlight.set(klipyId, task);
  return task;
}

/**
 * BACKGROUND, bounded import used by the search/trending top-up (fire-and-forget).
 * Never throws into the request path. If the GIF is already owned it just appends
 * the surfaced query term and counts the hit (no download). Otherwise it imports
 * under the concurrency semaphore so search fan-out cannot stampede Oxy/S3.
 */
export async function importKlipyItem(
  candidate: GifImportCandidate,
  queryTerm?: string,
): Promise<GifRecord | null> {
  if (!GIF_LIBRARY_WRITE_ENABLED) return null;
  const klipyId = candidate.klipyId?.trim();
  if (!klipyId) return null;

  try {
    const existing = await findByKlipyId(klipyId);
    if (existing) return appendSearchTerms(existing, candidate, queryTerm);

    // Join an in-flight import (foreground or background) without taking a slot.
    const pending = inFlight.get(klipyId);
    if (pending) return pending;

    await acquireImportSlot();
    try {
      return await importSingleFlight(candidate, queryTerm);
    } finally {
      releaseImportSlot();
    }
  } catch (error) {
    logger.warn('[GifLibrary] importKlipyItem failed', {
      klipyId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

/**
 * FOREGROUND import for the use/post flow: return the owned row if present, else
 * import NOW (synchronously awaited, not bounded by the background semaphore — a
 * user selecting a GIF must not wait behind search fan-out). Joins any in-flight
 * background import of the same GIF via the single-flight map.
 */
export async function ensureImported(candidate: GifImportCandidate): Promise<GifRecord | null> {
  if (!GIF_LIBRARY_WRITE_ENABLED) return null;
  const klipyId = candidate.klipyId?.trim();
  if (!klipyId) return null;

  const found = await findByKlipyId(klipyId);
  if (found) return found;

  return importSingleFlight(candidate);
}

/**
 * Record a post of this GIF: bump `useCount` and stamp `lastUsedAt`. Never throws.
 *
 * No id-shape guard. `findByIdAndUpdate` used to throw a `CastError` on anything
 * that was not 24-char hex; a `text` id that names no row simply updates nothing,
 * which is the same outcome this best-effort counter always wanted.
 */
export async function recordUse(gifId: string): Promise<void> {
  try {
    await getDb()
      .update(gifs)
      .set({ useCount: sql`${gifs.useCount} + 1`, lastUsedAt: new Date() })
      .where(eq(gifs.id, gifId));
  } catch (error) {
    logger.warn('[GifLibrary] recordUse failed', {
      gifId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}
