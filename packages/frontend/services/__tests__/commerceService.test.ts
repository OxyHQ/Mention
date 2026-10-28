import { commerceService } from '../commerceService';
const mockAuthenticated = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
const mockPublic = { get: jest.fn(), post: jest.fn() };
jest.mock('@/utils/api', () => ({
  get authenticatedClient() {
    return mockAuthenticated;
  },
  get publicClient() {
    return mockPublic;
  },
}));
beforeEach(() => {
  for (const method of [...Object.values(mockAuthenticated), ...Object.values(mockPublic)])
    method.mockReset().mockResolvedValue({ data: { sentinel: true } });
});
it('keeps account data and writes on the shared account transport, encoding path segments', async () => {
  await commerceService.storefront('a/b');
  await commerceService.connect('a/b', 'shop');
  await commerceService.disconnect('a/b');
  await commerceService.storeProducts('a/b', 'page+2');
  await commerceService.storeCollections('a/b');
  await commerceService.metrics('stores', 'a/b');
  await commerceService.recordMetric('posts', 'a/b', 'handoff');
  expect(mockAuthenticated.get.mock.calls).toEqual([
    ['/commerce/accounts/a%2Fb'],
    ['/commerce/accounts/a%2Fb/products', { params: { cursor: 'page+2' } }],
    ['/commerce/accounts/a%2Fb/collections', { params: { cursor: undefined } }],
    ['/commerce/metrics/stores/a%2Fb'],
  ]);
  expect(mockAuthenticated.put).toHaveBeenCalledWith('/commerce/accounts/a%2Fb', {
    handle: 'shop',
  });
  expect(mockAuthenticated.delete).toHaveBeenCalledWith('/commerce/accounts/a%2Fb');
  expect(mockAuthenticated.post).toHaveBeenCalledWith('/commerce/metrics/posts/a%2Fb', {
    event: 'handoff',
  });
  expect(mockPublic.get).not.toHaveBeenCalled();
});
it('uses public catalog presentation with request cancellation and opaque pagination', async () => {
  const signal = new AbortController().signal;
  await commerceService.hydrate([], signal);
  await commerceService.products({ query: 'chair', cursor: 'opaque/+=' });
  await commerceService.products();
  expect(mockPublic.post).toHaveBeenCalledWith('/commerce/hydrate', { refs: [] }, { signal });
  expect(mockPublic.get.mock.calls).toEqual([
    ['/commerce/products', { params: { query: 'chair', cursor: 'opaque/+=' } }],
    ['/commerce/products', { params: {} }],
  ]);
});
it('propagates a revoked account refusal without retrying anonymously', async () => {
  const refusal = new Error('revoked');
  mockAuthenticated.get.mockRejectedValue(refusal);
  await expect(commerceService.storefront('private')).rejects.toBe(refusal);
  expect(mockPublic.get).not.toHaveBeenCalled();
});
