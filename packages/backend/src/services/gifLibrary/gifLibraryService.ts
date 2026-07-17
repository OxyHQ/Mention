import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';

import Gif, { type IGif } from '../../models/Gif';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
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
/** MongoDB duplicate-key error code (raced concurrent import of the same klipyId). */
const MONGO_DUPLICATE_KEY = 11000;

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
 * The `$text` index uses `default_language: 'none'`, so this is the ONLY place
 * stemming-free token hygiene happens (queries AND stored terms go through it).
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
 * Local-first text search over the owned library. Ranked by `$text` relevance,
 * then most-posted, then most-recently-used. Never throws — a search failure
 * degrades to "no local hits" so the route still tops up from Klipy.
 */
export async function searchLocal(queryTerms: string, limit: number): Promise<IGif[]> {
  const search = normalizeToTerms(queryTerms).join(' ');
  if (!search) return [];
  try {
    return await Gif.find({ $text: { $search: search } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' }, useCount: -1, lastUsedAt: -1 })
      .limit(limit)
      .exec();
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
 */
export async function getLocalTrending(limit: number): Promise<IGif[]> {
  try {
    return await Gif.find({ useCount: { $gte: 1 } })
      .sort({ useCount: -1, lastUsedAt: -1 })
      .limit(limit)
      .exec();
  } catch (error) {
    logger.warn('[GifLibrary] getLocalTrending failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
}

/** Resolve which of the given provider ids are already imported (klipyId → row). */
export async function getImportedByKlipyIds(klipyIds: string[]): Promise<Map<string, IGif>> {
  const ids = [...new Set(klipyIds.filter((id) => Boolean(id)))];
  if (ids.length === 0) return new Map();
  try {
    const docs = await Gif.find({ klipyId: { $in: ids } }).exec();
    return new Map(docs.map((doc) => [doc.klipyId, doc]));
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
const inFlight = new Map<string, Promise<IGif | null>>();

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

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === MONGO_DUPLICATE_KEY
  );
}

/** Append a candidate's terms to an existing row and count the resurfacing. */
async function appendSearchTerms(
  existing: IGif,
  candidate: GifImportCandidate,
  queryTerm?: string,
): Promise<IGif> {
  const terms = buildSearchTerms(candidate, queryTerm);
  try {
    const updated = await Gif.findOneAndUpdate(
      { klipyId: existing.klipyId },
      { $addToSet: { searchTerms: { $each: terms } }, $inc: { searchHitCount: 1 } },
      { new: true },
    ).exec();
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
async function importGif(candidate: GifImportCandidate, queryTerm?: string): Promise<IGif | null> {
  const { klipyId } = candidate;

  const existing = await Gif.findOne({ klipyId }).exec();
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

    const created = await Gif.create({
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
    });

    logger.info('[GifLibrary] Imported GIF', {
      klipyId,
      gifId: String(created._id),
      mp4FileId,
      previewFileId,
    });
    return created;
  } catch (error) {
    // A concurrent process imported the same klipyId between our check and create.
    if (isDuplicateKeyError(error)) {
      const winner = await Gif.findOne({ klipyId }).exec();
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
function importSingleFlight(candidate: GifImportCandidate, queryTerm?: string): Promise<IGif | null> {
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
): Promise<IGif | null> {
  if (!GIF_LIBRARY_WRITE_ENABLED) return null;
  const klipyId = candidate.klipyId?.trim();
  if (!klipyId) return null;

  try {
    const existing = await Gif.findOne({ klipyId }).exec();
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
export async function ensureImported(candidate: GifImportCandidate): Promise<IGif | null> {
  if (!GIF_LIBRARY_WRITE_ENABLED) return null;
  const klipyId = candidate.klipyId?.trim();
  if (!klipyId) return null;

  const found = await Gif.findOne({ klipyId }).exec();
  if (found) return found;

  return importSingleFlight(candidate);
}

/** Record a post of this GIF: bump `useCount` and stamp `lastUsedAt`. Never throws. */
export async function recordUse(gifId: string): Promise<void> {
  try {
    await Gif.findByIdAndUpdate(gifId, {
      $inc: { useCount: 1 },
      $set: { lastUsedAt: new Date() },
    }).exec();
  } catch (error) {
    logger.warn('[GifLibrary] recordUse failed', {
      gifId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}
