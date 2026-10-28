/** Real profile/grid/query observers; the commerce API boundary is a seller-curation fixture. */
import { APP_ORIGIN, PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';

const storeRef = { kind: 'store', id: 'featured-store' };
const collection = (id: string) => ({
  ref: { kind: 'collection', id },
  store: storeRef,
  title: `Shelf ${id}`,
  description: null,
  image: null,
  url: `https://mercaria.co/collections/${id}`,
});
const product = (id: string) => ({
  ref: { kind: 'product', id },
  title: `Featured product ${id}`,
  primaryImage: null,
  price: { amount: 12900, currency: 'EUR' },
  compareAtPrice: null,
  priceRange: null,
  availability: 'in_stock',
  condition: { key: 'new', group: 'new' },
  seller: {
    kind: 'store',
    store: storeRef,
    handle: 'fixture',
    name: 'Fixture shop',
    logoUrl: null,
  },
  url: `https://mercaria.co/products/${id}`,
  description: '',
  images: [],
  purchaseOptions: [],
  updatedAt: '2026-10-28T00:00:00Z',
  viewer: null,
});

test('seller shelf order survives pagination and removed or failing shelves stop presenting products', async ({
  page,
  context,
  candidate,
}) => {
  let selected = ['b', 'a'];
  let outage = false;
  let pendingPage = false;
  let canceledPage = false;
  let releasePage: (() => Promise<void>) | undefined;
  const batches: number[] = [];
  page.on('requestfailed', (request) => {
    if (request.url().includes('cursor=b-next')) canceledPage = true;
  });
  await page.clock.install();
  await context.route('**/commerce/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
    };
    const json = (body: unknown, status = 200) => route.fulfill({ headers, json: body, status });
    if (request.method() === 'OPTIONS') return route.fulfill({ headers, status: 204 });
    if (url.pathname.endsWith('/hydrate')) {
      const refs = request.postDataJSON().refs as { id: string }[];
      batches.push(refs.length);
      return json({
        items: refs.map((ref) => {
          const item = product(ref.id);
          return { state: 'available', ref: item.ref, product: item, url: item.url };
        }),
      });
    }
    if (url.pathname.includes('/metrics/')) return route.fulfill({ headers, status: 204 });
    if (url.pathname.endsWith('/featured-collections'))
      return json({ items: selected.map(collection), nextCursor: null });
    if (url.pathname.includes('/featured-collections/') && url.pathname.endsWith('/products')) {
      const id = url.pathname.split('/').at(-2);
      if (!id) throw new Error('Missing collection id in fixture request');
      if (!selected.includes(id)) return json({ message: 'Withdrawn' }, 404);
      if (outage) return json({ message: 'Unavailable' }, 503);
      if (url.searchParams.has('cursor')) {
        pendingPage = true;
        await new Promise<void>((resolve) => {
          releasePage = async () => {
            await json({ items: [product('late')], nextCursor: null });
            resolve();
          };
        });
        return;
      }
      return json({ items: [product(id)], nextCursor: id === 'b' ? 'b-next' : null });
    }
    if (url.pathname.endsWith('/products') || url.pathname.endsWith('/collections'))
      return json({ items: [], nextCursor: null });
    const store = {
      ref: storeRef,
      oxyAccountId: url.pathname.split('/').at(-1),
      handle: 'fixture',
      name: 'Featured fixture shop',
      description: null,
      logoUrl: null,
      coverImageUrl: null,
      brandColor: '#123456',
      rating: null,
      reviewCount: 0,
      url: 'https://mercaria.co/stores/fixture',
    };
    return json({ state: 'available', ref: store.ref, store, url: store.url });
  });
  await page.goto(`${APP_ORIGIN}/@${PROFILE_HANDLE}/shop`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Featured product b', { exact: true })).toBeVisible();
  await expect(page.getByText('Featured product a', { exact: true })).toBeVisible();
  expect(await page.getByRole('heading', { name: /^Shelf / }).allTextContents()).toEqual([
    'Shelf b',
    'Shelf a',
  ]);
  // Put the pending page just before the shelf refresh. Its 15s transport
  // timeout must not be what cancels it when the seller withdraws the shelf.
  await page.clock.fastForward(29_000);
  await page.getByRole('button', { name: 'Load more · Shelf b', exact: true }).click();
  await expect.poll(() => pendingPage).toBe(true);
  const pendingAt = await page.evaluate(() => Date.now());
  selected = ['a'];
  await page.clock.fastForward(2_000);
  await expect(page.getByRole('heading', { name: 'Shelf b', exact: true })).toHaveCount(0);
  await expect(page.getByText('Featured product b', { exact: true })).toHaveCount(0);
  await expect.poll(() => canceledPage).toBe(true);
  expect((await page.evaluate(() => Date.now())) - pendingAt).toBeLessThan(15_000);
  await releasePage?.();
  await expect(page.getByText('Featured product late', { exact: true })).toHaveCount(0);
  outage = true;
  await page.clock.fastForward(31_000);
  await expect(page.getByText('Featured product a', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('The catalog is temporarily unavailable. Try again shortly.', { exact: true }),
  ).toBeVisible();
  selected = [];
  await page.clock.fastForward(31_000);
  await expect(
    page.getByRole('heading', { name: 'Featured collections', exact: true }),
  ).toHaveCount(0);
  expect(batches.every((count) => count <= 24)).toBe(true);
  expect(candidate.scriptErrors).toEqual([]);
});
