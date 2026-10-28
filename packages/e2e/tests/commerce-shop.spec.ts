/** Real exported profile/router/list; only the Mention commerce HTTP boundary is a fixture. */
import { APP_ORIGIN, PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';

function product(index: number) {
  return {
    ref: { kind: 'product', id: `commerce-fixture-${index}` },
    title: `Commerce fixture product ${index}`,
    primaryImage: null,
    price: { amount: 12900, currency: 'EUR' },
    compareAtPrice: null,
    priceRange: null,
    availability: 'in_stock',
    condition: { key: 'new', group: 'new' },
    seller: {
      kind: 'store',
      store: { kind: 'store', id: 'commerce-fixture-store' },
      handle: 'fixture',
      name: 'Fixture shop',
      logoUrl: null,
    },
    url: `https://mercaria.co/products/commerce-fixture-${index}`,
    description: '',
    images: [],
    purchaseOptions: [],
    updatedAt: '2026-10-28T00:00:00Z',
    viewer: null,
  };
}

test('shop pages remain virtualized and disappear when the store connection becomes unavailable', async ({
  page,
  context,
  candidate,
}) => {
  let available = true;
  let listed = 0;
  const hydrationBatches: number[] = [];
  await context.route('**/commerce/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
    };
    const json = (body: unknown) => route.fulfill({ headers, json: body });
    if (request.method() === 'OPTIONS') return route.fulfill({ headers, status: 204 });
    if (url.pathname.endsWith('/hydrate')) {
      const body: { refs: { kind: string; id: string }[] } = request.postDataJSON();
      hydrationBatches.push(body.refs.length);
      return json({
        items: body.refs.map((ref) => {
          const item = product(Number(ref.id.split('-').at(-1)));
          return { state: 'available', ref: item.ref, product: item, url: item.url };
        }),
      });
    }
    if (url.pathname.includes('/metrics/')) return route.fulfill({ headers, status: 204 });
    if (url.pathname.endsWith('/products')) {
      const start = Number(url.searchParams.get('cursor') ?? 0);
      listed = Math.max(listed, start + 20);
      return json({
        items: Array.from({ length: 20 }, (_, index) => product(start + index)),
        nextCursor: start < 60 ? String(start + 20) : null,
      });
    }
    if (url.pathname.endsWith('/collections')) return json({ items: [], nextCursor: null });
    if (!available) return json({ state: 'gone' });
    const store = {
      ref: { kind: 'store', id: 'commerce-fixture-store' },
      oxyAccountId: url.pathname.split('/').at(-1),
      handle: 'fixture',
      name: 'Commerce browser fixture shop',
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
  await expect(page.getByText('Commerce browser fixture shop', { exact: true })).toBeVisible();
  await expect(page.getByTestId('commerce-card').first()).toBeVisible();
  await expect.poll(() => hydrationBatches.length).toBeGreaterThan(0);
  expect(hydrationBatches.every((count) => count <= 24)).toBe(true);
  for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const more = page.getByRole('button', { name: 'Load more', exact: true });
    await expect(more).toBeVisible();
    await more.click();
    await expect.poll(() => listed).toBeGreaterThanOrEqual((pageNumber + 2) * 20);
  }
  // 60 catalog rows loaded; the DOM must retain only the viewport/overscan.
  await expect.poll(() => page.getByTestId('commerce-card').count()).toBeLessThan(30);
  available = false;
  // A real interval refresh tests cache invalidation after ownership/provider loss.
  await expect(page.getByText('This shop is unavailable', { exact: true })).toBeVisible({
    timeout: 40_000,
  });
  await expect(page.getByTestId('commerce-card')).toHaveCount(0);
  expect(candidate.scriptErrors).toEqual([]);
});
