const KLIPY_BASE_URL = 'https://api.klipy.com';

// Get KLIPY_APP_KEY from environment
function getKlipyAppKey(): string {
  return process.env.KLIPY_APP_KEY || '';
}

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

export async function searchGifs(params: SearchGifsParams): Promise<GifResponse> {
  const klipyAppKey = getKlipyAppKey();
  if (!klipyAppKey) {
    throw new Error('KLIPY_APP_KEY is not configured. Please add KLIPY_APP_KEY to your .env file.');
  }

  const { query, page, perPage, customerId } = params;

  const url = new URL(`${KLIPY_BASE_URL}/api/v1/${klipyAppKey}/gifs/search`);
  url.searchParams.append('q', query);
  url.searchParams.append('page', page.toString());
  url.searchParams.append('per_page', perPage.toString());
  url.searchParams.append('customer_id', customerId);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`KLIPY API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as GifResponse;

  if (!data.result) {
    throw new Error('KLIPY API returned unsuccessful result');
  }

  return data;
}

export async function getTrendingGifs(params: TrendingGifsParams): Promise<GifResponse> {
  const klipyAppKey = getKlipyAppKey();
  if (!klipyAppKey) {
    throw new Error('KLIPY_APP_KEY is not configured. Please add KLIPY_APP_KEY to your .env file.');
  }

  const { page, perPage, customerId } = params;

  const url = new URL(`${KLIPY_BASE_URL}/api/v1/${klipyAppKey}/gifs/trending`);
  url.searchParams.append('page', page.toString());
  url.searchParams.append('per_page', perPage.toString());
  url.searchParams.append('customer_id', customerId);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`KLIPY API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as GifResponse;

  if (!data.result) {
    throw new Error('KLIPY API returned unsuccessful result');
  }

  return data;
}
