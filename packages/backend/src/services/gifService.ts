import { getKlipyAppKey } from '../config';

const KLIPY_BASE_URL = 'https://api.klipy.com';

/** Klipy sits on the GIF picker's request path: a hung upstream must not hold the request open. */
const KLIPY_TIMEOUT_MS = 8_000;

interface SearchGifsParams {
  query: string;
  page: number;
  perPage: number;
  customerId: string;
}

interface TrendingGifsParams {
  page: number;
  perPage: number;
  customerId: string;
}

/** A single encoded media file (one format within a size bucket). */
export interface KlipyMediaVariant {
  url: string;
  width: number;
  height: number;
  size: number;
}

/** The set of formats available for a given size bucket. */
export interface KlipyFileVariants {
  gif?: KlipyMediaVariant;
  webp?: KlipyMediaVariant;
  jpg?: KlipyMediaVariant;
  mp4?: KlipyMediaVariant;
  webm?: KlipyMediaVariant;
}

/** A single GIF entry returned by Klipy. */
export interface KlipyGifItem {
  id: number;
  slug: string;
  title: string;
  file: {
    hd?: KlipyFileVariants;
    md?: KlipyFileVariants;
    sm?: KlipyFileVariants;
    xs?: KlipyFileVariants;
  };
  tags?: string[];
  type?: string;
  blur_preview?: string;
}

/** Raw Klipy API envelope. Owned by this service; never sent to clients verbatim. */
export interface GifResponse {
  result: boolean;
  data: {
    data: KlipyGifItem[];
    current_page: number;
    per_page: number;
    has_next: boolean;
  };
}

/** One Klipy `gifs/<endpoint>` call; `query` holds the endpoint's own parameters. */
async function klipyGifs(
  endpoint: 'search' | 'trending',
  query: Record<string, string>,
): Promise<GifResponse> {
  const klipyAppKey = getKlipyAppKey();
  if (!klipyAppKey) {
    throw new Error('KLIPY_APP_KEY is not configured. Please add KLIPY_APP_KEY to your .env file.');
  }

  const url = new URL(`${KLIPY_BASE_URL}/api/v1/${klipyAppKey}/gifs/${endpoint}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.append(key, value);

  const response = await fetch(url, { signal: AbortSignal.timeout(KLIPY_TIMEOUT_MS) });

  if (!response.ok) {
    throw new Error(`KLIPY API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as GifResponse;

  if (!data.result) {
    throw new Error('KLIPY API returned unsuccessful result');
  }

  return data;
}

export function searchGifs({ query, page, perPage, customerId }: SearchGifsParams) {
  return klipyGifs('search', {
    q: query,
    page: String(page),
    per_page: String(perPage),
    customer_id: customerId,
  });
}

export function getTrendingGifs({ page, perPage, customerId }: TrendingGifsParams) {
  return klipyGifs('trending', {
    page: String(page),
    per_page: String(perPage),
    customer_id: customerId,
  });
}
