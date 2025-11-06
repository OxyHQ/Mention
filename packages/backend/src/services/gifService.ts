// Use built-in fetch if available (Node 18+), otherwise fallback to node-fetch
const fetch = globalThis.fetch || require('node-fetch');

const KLIPY_BASE_URL = 'https://api.klipy.com';

// Get KLIPY_APP_KEY from environment (ensure dotenv is loaded in server.ts)
function getKlipyAppKey(): string {
  const key = process.env.KLIPY_APP_KEY;
  if (!key) {
    console.warn('KLIPY_APP_KEY is not configured in environment variables');
  }
  return key || '';
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

interface GifResponse {
  result: boolean;
  data: {
    data: Array<{
      id: number;
      slug: string;
      title: string;
      file: {
        hd?: {
          gif?: { url: string; width: number; height: number; size: number };
          webp?: { url: string; width: number; height: number; size: number };
          jpg?: { url: string; width: number; height: number; size: number };
        };
        md?: {
          gif?: { url: string; width: number; height: number; size: number };
          webp?: { url: string; width: number; height: number; size: number };
          jpg?: { url: string; width: number; height: number; size: number };
        };
        sm?: {
          gif?: { url: string; width: number; height: number; size: number };
          webp?: { url: string; width: number; height: number; size: number };
          jpg?: { url: string; width: number; height: number; size: number };
        };
      };
      tags: string[];
      type: string;
      blur_preview?: string;
    }>;
    current_page: number;
    per_page: number;
    has_next: boolean;
  };
}

export async function searchGifs(params: SearchGifsParams) {
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

export async function getTrendingGifs(params: TrendingGifsParams) {
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

