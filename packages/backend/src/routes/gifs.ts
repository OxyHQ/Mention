import express, { Response } from "express";
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { searchGifs, getTrendingGifs, GifResponse } from '../services/gifService';
import {
  GifImportCandidate,
  ensureImported,
  getImportedByKlipyIds,
  getLocalTrending,
  importKlipyItem,
  mapKlipyItemsToCandidates,
  recordUse,
  searchLocal,
} from '../services/gifLibrary/gifLibraryService';
import {
  GIF_DEFAULT_DIMENSION,
  GIF_LIBRARY_WRITE_ENABLED,
  GIF_LOCAL_HITS_LIMIT,
} from '../services/gifLibrary/constants';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import type { IGif } from '../models/Gif';
import { logger } from '../utils/logger';

const router = express.Router();

/**
 * Clean, client-facing GIF DTO. The backend owns the Klipy contract and never
 * leaks Klipy's raw `{ result, data: { data: [...] } }` envelope to clients.
 *
 * A GIF is either:
 *  - IMPORTED — owned by Mention. `id` is our `Gif._id`; `mp4Url`/`previewUrl`
 *    are `cloud.oxy.so/<fileId>` (served from our own S3/CDN).
 *  - NOT-YET-IMPORTED — a Klipy passthrough surfaced for the first time. `id` is
 *    `''`; `mp4Url`/`previewUrl` point at Klipy so the picker still renders while
 *    the background import copies it into the library.
 */
export interface GifItem {
  id: string;
  klipyId: string;
  slug: string;
  title: string;
  mp4Url: string;     // full looping muted mp4 — attached to the post via /gifs/use
  previewUrl: string; // small looping muted mp4 for the grid tile
  width: number;
  height: number;
}

interface GifPayload {
  gifs: GifItem[];
  hasNext: boolean;
  page: number;
}

interface UseGifBody {
  klipyId?: unknown;
  slug?: unknown;
  title?: unknown;
  mp4Url?: unknown;
  previewUrl?: unknown;
  width?: unknown;
  height?: unknown;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asDimension(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : GIF_DEFAULT_DIMENSION;
}

/** Map an owned library row to the client DTO (served from our own CDN). */
function toImportedGifItem(gif: IGif): GifItem {
  const client = getServiceOxyClient();
  return {
    id: String(gif._id),
    klipyId: gif.klipyId,
    slug: gif.slug,
    title: gif.title,
    mp4Url: client.getFileDownloadUrl(gif.mp4FileId),
    previewUrl: client.getFileDownloadUrl(gif.previewFileId || gif.mp4FileId),
    width: gif.width,
    height: gif.height,
  };
}

/** Map a not-yet-imported Klipy candidate to the client DTO (passthrough urls). */
function toKlipyGifItem(candidate: GifImportCandidate): GifItem {
  return {
    id: '',
    klipyId: candidate.klipyId,
    slug: candidate.slug,
    title: candidate.title,
    mp4Url: candidate.mp4Url,
    previewUrl: candidate.previewUrl || candidate.mp4Url,
    width: candidate.width,
    height: candidate.height,
  };
}

/**
 * Build the merged response: owned local hits first, then the Klipy page (with an
 * owned copy preferred when we already have one), deduped by `klipyId`. Also fires
 * best-effort imports for surfaced Klipy items we do not yet own — detached, so
 * the response NEVER waits on (or fails because of) an import.
 */
async function buildMergedPayload(
  localHits: IGif[],
  klipy: GifResponse | null,
  pageNum: number,
  queryTerm: string | undefined,
): Promise<GifPayload> {
  const candidates = klipy ? mapKlipyItemsToCandidates(klipy.data.data) : [];
  const importedMap = await getImportedByKlipyIds(candidates.map((c) => c.klipyId));

  const seen = new Set<string>();
  const gifs: GifItem[] = [];

  for (const gif of localHits) {
    if (seen.has(gif.klipyId)) continue;
    seen.add(gif.klipyId);
    gifs.push(toImportedGifItem(gif));
  }

  for (const candidate of candidates) {
    if (seen.has(candidate.klipyId)) continue;
    seen.add(candidate.klipyId);
    const owned = importedMap.get(candidate.klipyId);
    gifs.push(owned ? toImportedGifItem(owned) : toKlipyGifItem(candidate));
  }

  // Fire-and-forget import of surfaced Klipy items we do not yet own. Detached:
  // the request returns immediately; importKlipyItem is best-effort and bounded.
  if (GIF_LIBRARY_WRITE_ENABLED) {
    for (const candidate of candidates) {
      if (importedMap.has(candidate.klipyId)) continue;
      void importKlipyItem(candidate, queryTerm).catch((error: unknown) => {
        logger.warn('[GIFs] Background import rejected', {
          klipyId: candidate.klipyId,
          reason: getErrorMessage(error),
        });
      });
    }
  }

  return {
    gifs,
    hasNext: klipy ? Boolean(klipy.data.has_next) : false,
    page: klipy ? klipy.data.current_page : pageNum,
  };
}

// Search GIFs — local-first, Klipy top-up, import what's new.
router.get("/search", async (req: AuthRequest, res: Response) => {
  try {
    const { q, page = '1', per_page = '20' } = req.query;
    const customerId = req.user?.id || 'anonymous';

    if (!q || typeof q !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Search query (q) is required',
      });
    }

    const pageNum = parseInt(page as string, 10) || 1;
    const perPage = parseInt(per_page as string, 10) || 20;

    // Local text-search hits lead the FIRST page only (later pages are pure Klipy
    // pagination — re-prepending the same local hits on every page would dup them).
    const localHits = pageNum === 1 ? await searchLocal(q, GIF_LOCAL_HITS_LIMIT) : [];

    let klipy: GifResponse | null = null;
    try {
      klipy = await searchGifs({ query: q, page: pageNum, perPage, customerId });
    } catch (error: unknown) {
      // Klipy being unavailable must NOT break local-first results.
      logger.warn('[GIFs] Klipy search failed; serving local results only', {
        query: q,
        error: getErrorMessage(error),
      });
    }

    res.json(await buildMergedPayload(localHits, klipy, pageNum, q));
  } catch (error: unknown) {
    logger.error('[GIFs] GIF search error:', { userId: req.user?.id, query: req.query.q, error });
    res.status(500).json({
      success: false,
      message: "Error searching GIFs",
      error: getErrorMessage(error),
    });
  }
});

// Trending GIFs — owned trending first, Klipy top-up, import what's new.
router.get("/trending", async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', per_page = '20' } = req.query;
    const customerId = req.user?.id || 'anonymous';

    const pageNum = parseInt(page as string, 10) || 1;
    const perPage = parseInt(per_page as string, 10) || 20;

    const localHits = pageNum === 1 ? await getLocalTrending(GIF_LOCAL_HITS_LIMIT) : [];

    let klipy: GifResponse | null = null;
    try {
      klipy = await getTrendingGifs({ page: pageNum, perPage, customerId });
    } catch (error: unknown) {
      logger.warn('[GIFs] Klipy trending failed; serving local results only', {
        error: getErrorMessage(error),
      });
    }

    res.json(await buildMergedPayload(localHits, klipy, pageNum, undefined));
  } catch (error: unknown) {
    logger.error('[GIFs] GIF trending error:', { userId: req.user?.id, error });
    res.status(500).json({
      success: false,
      message: "Error fetching trending GIFs",
      error: getErrorMessage(error),
    });
  }
});

// Select / post a GIF — import on demand (if new), record the use, return the
// SHARED Oxy file id the post will reference.
router.post("/use", async (req: AuthRequest, res: Response) => {
  try {
    const body = (req.body ?? {}) as UseGifBody;
    const klipyId = asString(body.klipyId).trim();

    if (!klipyId) {
      return res.status(400).json({
        success: false,
        message: 'klipyId is required',
      });
    }

    const candidate: GifImportCandidate = {
      klipyId,
      slug: asString(body.slug),
      title: asString(body.title),
      mp4Url: asString(body.mp4Url),
      previewUrl: asString(body.previewUrl),
      width: asDimension(body.width),
      height: asDimension(body.height),
    };

    // Safety valve: when the library write side is OFF, fall back to a pure Klipy
    // passthrough (no import, no file id). The default is ON, so this is rare.
    if (!GIF_LIBRARY_WRITE_ENABLED) {
      return res.json({ gifId: '', fileId: '', mp4Url: candidate.mp4Url });
    }

    const gif = await ensureImported(candidate);
    if (!gif) {
      // Import failed (e.g. source unreachable) — degrade to Klipy passthrough so
      // the composer still works rather than hard-failing the selection.
      logger.warn('[GIFs] ensureImported returned null; passthrough', { klipyId });
      return res.json({ gifId: '', fileId: '', mp4Url: candidate.mp4Url });
    }

    await recordUse(String(gif._id));

    const fileId = gif.mp4FileId;
    res.json({
      gifId: String(gif._id),
      fileId,
      mp4Url: getServiceOxyClient().getFileDownloadUrl(fileId),
    });
  } catch (error: unknown) {
    logger.error('[GIFs] GIF use error:', { userId: req.user?.id, error });
    res.status(500).json({
      success: false,
      message: "Error selecting GIF",
      error: getErrorMessage(error),
    });
  }
});

export default router;
