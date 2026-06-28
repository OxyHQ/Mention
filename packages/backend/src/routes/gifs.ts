import express, { Response } from "express";
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { searchGifs, getTrendingGifs, GifResponse, KlipyGifItem } from '../services/gifService';
import { logger } from '../utils/logger';

const router = express.Router();

/**
 * Clean, client-facing GIF DTO. The backend owns the Klipy contract and never
 * leaks Klipy's raw `{ result, data: { data: [...] } }` envelope to clients —
 * the SDK linked client strips a top-level `data` wrapper, which previously
 * collapsed the raw shape and broke the picker.
 */
export interface GifItem {
  id: string;
  slug: string;
  title: string;
  url: string;        // full-size animated url
  thumbnail: string;  // smaller animated url for the grid
  width: number;
  height: number;
}

const DEFAULT_GIF_DIMENSION = 200;

/**
 * Map Klipy's raw items to clean `GifItem`s. Mirrors the previous client-side
 * mapping exactly so behavior is unchanged; items without a usable url or
 * thumbnail are dropped.
 */
function mapKlipyItems(items: KlipyGifItem[]): GifItem[] {
  return items
    .map((g): GifItem => {
      const fullFile = g.file?.hd || g.file?.md || g.file?.sm;
      const thumbnailFile = g.file?.md || g.file?.sm || g.file?.hd;

      return {
        id: String(g.id ?? g.slug ?? ''),
        slug: g.slug || '',
        title: g.title || '',
        url: fullFile?.gif?.url || fullFile?.webp?.url || '',
        thumbnail:
          thumbnailFile?.gif?.url ||
          thumbnailFile?.webp?.url ||
          thumbnailFile?.jpg?.url ||
          '',
        width: fullFile?.gif?.width || thumbnailFile?.gif?.width || DEFAULT_GIF_DIMENSION,
        height: fullFile?.gif?.height || thumbnailFile?.gif?.height || DEFAULT_GIF_DIMENSION,
      };
    })
    .filter((gif) => Boolean(gif.url) && Boolean(gif.thumbnail));
}

/** Build the clean response payload from a raw Klipy envelope. */
function buildGifPayload(result: GifResponse): { gifs: GifItem[]; hasNext: boolean; page: number } {
  return {
    gifs: mapKlipyItems(result.data.data),
    hasNext: Boolean(result.data.has_next),
    page: result.data.current_page,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

// Search GIFs
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

    const result = await searchGifs({
      query: q,
      page: parseInt(page as string, 10),
      perPage: parseInt(per_page as string, 10),
      customerId,
    });

    res.json(buildGifPayload(result));
  } catch (error: unknown) {
    logger.error('[GIFs] GIF search error:', { userId: req.user?.id, query: req.query.q, error });
    res.status(500).json({
      success: false,
      message: "Error searching GIFs",
      error: getErrorMessage(error),
    });
  }
});

// Get trending GIFs
router.get("/trending", async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', per_page = '20' } = req.query;
    const customerId = req.user?.id || 'anonymous';

    const result = await getTrendingGifs({
      page: parseInt(page as string, 10),
      perPage: parseInt(per_page as string, 10),
      customerId,
    });

    res.json(buildGifPayload(result));
  } catch (error: unknown) {
    logger.error('[GIFs] GIF trending error:', { userId: req.user?.id, error });
    res.status(500).json({
      success: false,
      message: "Error fetching trending GIFs",
      error: getErrorMessage(error),
    });
  }
});

export default router;
