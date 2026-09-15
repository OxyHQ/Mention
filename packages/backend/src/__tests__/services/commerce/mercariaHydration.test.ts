/**
 * Consumer conformance for `@mercaria.co/sdk` (Mercaria#1017, Mention#951).
 *
 * Proves a persisted Mercaria ref is hydrated THROUGH the SDK, not through a
 * Mention-local HTTP client. Nothing Mercaria-shaped is mocked: the production
 * entry point (`hydrateMercariaProductRefs` → `getMercariaClient()` → the real
 * SDK) runs unmodified, and the only double is the platform `fetch` the SDK
 * resolves at request time. The double speaks Mercaria's real wire contract —
 * the `{ success, data }` / `{ success: false, error, message }` envelope on
 * `GET /public/v1/...` — so every state asserted below is the SDK's own reading
 * of a response, not Mention's.
 *
 * The wire strings (`/public/v1/products/`) are written out literally on
 * purpose: they pin what actually leaves the process. Test files are outside
 * `validate:commerce-boundary`'s population for exactly this reason.
 */

import {
  DEFAULT_MERCARIA_API_BASE_URL,
  DEFAULT_MERCARIA_WEB_BASE_URL,
  type MercariaFetchInit,
} from '@mercaria.co/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../../config';
import {
  hydrateMercariaProductRefs,
  resolveMercariaCollection,
  resolveMercariaStore,
} from '../../../services/commerce/mercariaHydration';
import { logger } from '../../../utils/logger';

const API_BASE = config.mercaria.apiUrl ?? DEFAULT_MERCARIA_API_BASE_URL;
const WEB_BASE = config.mercaria.webUrl ?? DEFAULT_MERCARIA_WEB_BASE_URL;

function productWire(id: string): Record<string, unknown> {
  return {
    ref: { kind: 'product', id },
    title: 'Night City Jacket',
    primaryImage: { url: 'https://cdn.example.test/p/1.jpg', alt: 'Jacket' },
    price: { amount: 12_900, currency: 'EUR' },
    compareAtPrice: null,
    priceRange: null,
    availability: 'in_stock',
    condition: { key: 'new', group: 'new' },
    seller: {
      kind: 'store',
      store: { kind: 'store', id: 'store_conformance' },
      handle: 'night-city-goods',
      name: 'Night City Goods',
      logoUrl: null,
    },
    url: `${WEB_BASE}/products/${encodeURIComponent(id)}`,
    description: 'A jacket.',
    images: [{ url: 'https://cdn.example.test/p/1.jpg', alt: null }],
    purchaseOptions: [
      {
        ref: { kind: 'variant', productId: id, variantId: 'var_m' },
        title: 'M',
        price: { amount: 12_900, currency: 'EUR' },
        compareAtPrice: null,
        availability: 'in_stock',
      },
    ],
    updatedAt: '2026-09-01T12:00:00.000Z',
    viewer: null,
  };
}

function storeWire(id: string): Record<string, unknown> {
  return {
    ref: { kind: 'store', id },
    handle: 'night-city-goods',
    name: 'Night City Goods',
    description: null,
    logoUrl: null,
    coverImageUrl: null,
    brandColor: '#112233',
    rating: null,
    reviewCount: 0,
    url: `${WEB_BASE}/stores/night-city-goods`,
  };
}

function collectionWire(id: string): Record<string, unknown> {
  return {
    ref: { kind: 'collection', id },
    store: { kind: 'store', id: 'store_conformance' },
    title: 'Launch',
    description: null,
    image: null,
    url: `${WEB_BASE}/stores/night-city-goods?collection=${encodeURIComponent(id)}`,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What the fake Mercaria answers for each path under `/public/v1`. */
const ROUTES: Record<string, () => Response | Promise<Response>> = {
  // An unknown field (`sku`) rides along: the SDK must not pass it through.
  '/products/prod_available': () => json(200, { success: true, data: { ...productWire('prod_available'), sku: 'SKU-PRIVATE-1' } }),
  '/products/prod_second': () => json(200, { success: true, data: productWire('prod_second') }),
  '/products/prod_gone': () => json(410, { success: false, error: 'GONE', message: 'No longer available' }),
  '/products/prod_missing': () => json(404, { success: false, error: 'NOT_FOUND', message: 'Product not found' }),
  '/products/prod_network': () => Promise.reject(new TypeError('fetch failed')),
  '/products/prod_throttled': () =>
    new Response('Too Many Requests', { status: 429, headers: { 'content-type': 'text/plain' } }),
  // A 404 with no Mercaria body is a proxy talking, and proves nothing about the product.
  '/products/prod_proxy_404': () => new Response('<html>Not Found</html>', { status: 404 }),
  '/products/prod_down': () => json(503, { success: false, error: 'SERVICE_UNAVAILABLE', message: 'Try later' }),
  '/stores/store_conformance': () => json(200, { success: true, data: storeWire('store_conformance') }),
  '/stores/store_closed': () => json(410, { success: false, error: 'GONE', message: 'Store closed' }),
  '/collections/col_conformance': () => json(200, { success: true, data: collectionWire('col_conformance') }),
};

interface RecordedRequest {
  url: string;
  init: MercariaFetchInit;
}

let requests: RecordedRequest[];

function installFakeMercaria(): void {
  requests = [];
  const prefix = `${API_BASE}/public/v1`;
  vi.stubGlobal('fetch', async (url: string, init: MercariaFetchInit) => {
    requests.push({ url, init });
    const route = url.startsWith(prefix) ? ROUTES[url.slice(prefix.length)] : undefined;
    if (!route) return json(404, { success: false, error: 'UNKNOWN_ROUTE', message: 'unexpected request' });
    return route();
  });
}

const productRefValue = (id: string): unknown => JSON.parse(JSON.stringify({ kind: 'product', id }));

beforeEach(() => {
  vi.clearAllMocks();
  installFakeMercaria();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hydrateMercariaProductRefs — through @mercaria.co/sdk', () => {
  it('hydrates an available product from the real wire envelope, with the SDK canonical link', async () => {
    const [result] = await hydrateMercariaProductRefs([productRefValue('prod_available')]);

    expect(requests.map((request) => request.url)).toEqual([`${API_BASE}/public/v1/products/prod_available`]);
    expect(result.state).toBe('available');
    if (result.state !== 'available') return;

    expect(result.ref).toEqual({ kind: 'product', id: 'prod_available' });
    expect(result.product.title).toBe('Night City Jacket');
    expect(result.product.price).toEqual({ amount: 12_900, currency: 'EUR' });
    expect(result.url).toBe(`${WEB_BASE}/products/prod_available`);
    // The SDK parses into fresh objects holding contract fields only.
    expect(result.product).not.toHaveProperty('sku');
    expect(result.product).toEqual(productWire('prod_available'));
  });

  it('sends an anonymous GET shaped by the SDK transport, not a hand-rolled request', async () => {
    await hydrateMercariaProductRefs([productRefValue('prod_available')]);

    expect(requests).toHaveLength(1);
    const { init } = requests[0];
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.headers.Accept).toBe('application/json');
    expect(Object.keys(init.headers).map((name) => name.toLowerCase())).not.toContain('authorization');
  });

  it('maps every Mercaria answer to its state, index-aligned with the input', async () => {
    const results = await hydrateMercariaProductRefs([
      productRefValue('prod_gone'),
      productRefValue('prod_missing'),
      productRefValue('prod_network'),
      productRefValue('prod_throttled'),
      productRefValue('prod_proxy_404'),
      productRefValue('prod_down'),
      productRefValue('prod_second'),
    ]);

    expect(results.map((result) => result.state)).toEqual([
      'gone',
      'not_found',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'available',
    ]);
    expect(results[0]).toEqual({ state: 'gone', ref: { kind: 'product', id: 'prod_gone' } });
    expect(results[1]).toEqual({ state: 'not_found', ref: { kind: 'product', id: 'prod_missing' } });
    expect(results[2]).toEqual({ state: 'unavailable', ref: { kind: 'product', id: 'prod_network' }, retryable: true });
    expect(results[3]).toEqual({ state: 'unavailable', ref: { kind: 'product', id: 'prod_throttled' }, retryable: true });
    // Never `not_found`: a bare 404 must not tell a caller a valid ref is dead.
    expect(results[4]).toEqual({ state: 'unavailable', ref: { kind: 'product', id: 'prod_proxy_404' }, retryable: false });
    expect(results[5]).toEqual({ state: 'unavailable', ref: { kind: 'product', id: 'prod_down' }, retryable: true });

    expect(requests.map((request) => request.url).sort()).toEqual(
      ['prod_gone', 'prod_missing', 'prod_network', 'prod_throttled', 'prod_proxy_404', 'prod_down', 'prod_second']
        .map((id) => `${API_BASE}/public/v1/products/${id}`)
        .sort(),
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[MercariaHydration] Mercaria read failed',
      expect.objectContaining({ kind: 'product', code: 'RATE_LIMITED', status: 429, retryable: true }),
    );
  });

  it('yields `invalid` for malformed persisted refs without sending any request', async () => {
    const results = await hydrateMercariaProductRefs([
      null,
      'prod_available',
      { kind: 'product' },
      { kind: 'product', id: '' },
      { kind: 'product', id: 'prod_available', title: 'a cached title makes it not a ref' },
      { kind: 'store', id: 'store_conformance' },
      { kind: 'variant', productId: 'prod_available', variantId: 'var_m' },
      [{ kind: 'product', id: 'prod_available' }],
    ]);

    expect(results).toHaveLength(8);
    expect(results.every((result) => result.state === 'invalid')).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('treats a ref the SDK refuses to put in a path as `invalid`, still without a request', async () => {
    const results = await hydrateMercariaProductRefs([{ kind: 'product', id: '..' }, productRefValue('prod_second')]);

    expect(results.map((result) => result.state)).toEqual(['invalid', 'available']);
    expect(requests.map((request) => request.url)).toEqual([`${API_BASE}/public/v1/products/prod_second`]);
  });

  it('reads each distinct ref once and shares the result across duplicates', async () => {
    const results = await hydrateMercariaProductRefs([
      productRefValue('prod_available'),
      { kind: 'bogus' },
      productRefValue('prod_available'),
      productRefValue('prod_gone'),
      productRefValue('prod_available'),
    ]);

    expect(results.map((result) => result.state)).toEqual(['available', 'invalid', 'available', 'gone', 'available']);
    expect(results[2]).toBe(results[0]);
    expect(results[4]).toBe(results[0]);
    expect(requests.map((request) => request.url).sort()).toEqual([
      `${API_BASE}/public/v1/products/prod_available`,
      `${API_BASE}/public/v1/products/prod_gone`,
    ]);
  });

  it('bounds concurrent reads at the configured pool size', async () => {
    const limit = config.mercaria.hydrationConcurrency;
    const ids = Array.from({ length: limit * 3 }, (_, index) => `prod_pool_${index}`);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal('fetch', async (url: string, init: MercariaFetchInit) => {
      requests.push({ url, init });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      return json(200, { success: true, data: productWire(id) });
    });

    const results = await hydrateMercariaProductRefs(ids.map(productRefValue));

    expect(results.every((result) => result.state === 'available')).toBe(true);
    expect(requests).toHaveLength(ids.length);
    // Equal, not `<=`: a serial implementation would also stay under the bound.
    expect(maxInFlight).toBe(limit);
  });

  it('returns an empty array for no refs', async () => {
    await expect(hydrateMercariaProductRefs([])).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe('resolveMercariaStore / resolveMercariaCollection — through @mercaria.co/sdk', () => {
  it('hydrates a store with the SDK store link, and maps a closed store to `gone`', async () => {
    const available = await resolveMercariaStore({ kind: 'store', id: 'store_conformance' });
    const closed = await resolveMercariaStore({ kind: 'store', id: 'store_closed' });

    expect(available.state).toBe('available');
    if (available.state === 'available') {
      expect(available.store.handle).toBe('night-city-goods');
      expect(available.url).toBe(`${WEB_BASE}/stores/night-city-goods`);
    }
    expect(closed).toEqual({ state: 'gone', ref: { kind: 'store', id: 'store_closed' } });
    expect(requests.map((request) => request.url)).toEqual([
      `${API_BASE}/public/v1/stores/store_conformance`,
      `${API_BASE}/public/v1/stores/store_closed`,
    ]);
  });

  it('hydrates a collection with its canonical url', async () => {
    const result = await resolveMercariaCollection({ kind: 'collection', id: 'col_conformance' });

    expect(result.state).toBe('available');
    if (result.state === 'available') {
      expect(result.collection.title).toBe('Launch');
      expect(result.url).toBe(`${WEB_BASE}/stores/night-city-goods?collection=col_conformance`);
    }
    expect(requests.map((request) => request.url)).toEqual([`${API_BASE}/public/v1/collections/col_conformance`]);
  });

  it('refuses a ref of the wrong kind without a request', async () => {
    await expect(resolveMercariaStore({ kind: 'product', id: 'prod_available' })).resolves.toEqual({ state: 'invalid' });
    await expect(resolveMercariaCollection({ kind: 'store', id: 'store_conformance' })).resolves.toEqual({
      state: 'invalid',
    });
    expect(requests).toHaveLength(0);
  });
});
