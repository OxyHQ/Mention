const mockClient = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
};
jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockClient.get(...args),
    post: (...args: unknown[]) => mockClient.post(...args),
    put: (...args: unknown[]) => mockClient.put(...args),
    patch: (...args: unknown[]) => mockClient.patch(...args),
    delete: (...args: unknown[]) => mockClient.delete(...args),
  },
}));
import { membershipsService } from '../membershipsService';
beforeEach(() => {
  jest.clearAllMocks();
  mockClient.get.mockResolvedValue({ data: { data: { items: [], nextCursor: null } } });
});
it('propagates cancellation through private page and landing requests', async () => {
  const controller = new AbortController();
  const page = await membershipsService.content('community', 'cursor', 'thread', controller.signal);
  expect(page).toEqual({ items: [], nextCursor: null });
  expect(mockClient.get).toHaveBeenCalledWith('/membership-communities/community/content', {
    params: { cursor: 'cursor', parentContentId: 'thread' },
    signal: controller.signal,
  });
  await membershipsService.landing('community', controller.signal);
  expect(mockClient.get).toHaveBeenLastCalledWith('/membership-communities/community/landing', {
    signal: controller.signal,
  });
});
it('joins only the chosen free-tier endpoint and sends explicit badge opt-out', async () => {
  await membershipsService.join('c', 't');
  expect(mockClient.put).toHaveBeenCalledWith('/membership-communities/c/membership', {
    tierId: 't',
  });
  await membershipsService.badge('c', false);
  expect(mockClient.patch).toHaveBeenCalledWith('/membership-communities/c/membership', {
    publicBadge: false,
  });
  await membershipsService.leave('c');
  expect(mockClient.delete).toHaveBeenCalledWith('/membership-communities/c/membership');
});
it('does not cache signed downloads or turn service errors into stale URLs', async () => {
  mockClient.get
    .mockResolvedValueOnce({ data: { data: { url: 'https://files.test/short', expiresIn: 300 } } })
    .mockRejectedValueOnce(new Error('revoked'));
  expect(await membershipsService.download('p', 'm')).toEqual({
    url: 'https://files.test/short',
    expiresIn: 300,
  });
  await expect(membershipsService.download('p', 'm')).rejects.toThrow('revoked');
  expect(mockClient.get).toHaveBeenCalledTimes(2);
});
it('uploads bytes to Mention under their actual media type', async () => {
  mockClient.post.mockResolvedValue({
    data: { data: { id: 'media', mime: 'image/png', size: 3 } },
  });
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  expect(await membershipsService.upload('c', bytes, 'image/png')).toEqual({
    id: 'media',
    mime: 'image/png',
    size: 3,
  });
  expect(mockClient.post).toHaveBeenCalledWith('/membership-communities/c/media', bytes, {
    headers: { 'Content-Type': 'image/png' },
  });
});
it('preserves the dedicated protected domain across publication, reporting and tier edits', async () => {
  mockClient.post.mockResolvedValue({ data: { data: { id: 'created' } } });
  mockClient.patch.mockResolvedValue({ data: { data: { id: 'updated' } } });
  expect(
    await membershipsService.create({
      ownerOxyUserId: 'owner',
      name: 'Community',
      slug: 'community',
    }),
  ).toEqual({ id: 'created' });
  expect(await membershipsService.update('c', { description: '', visibility: 'unlisted' })).toEqual(
    { id: 'updated' },
  );
  expect(
    await membershipsService.createContent('c', {
      kind: 'discussion',
      body: 'private',
      parentContentId: 'thread',
      mediaIds: ['media'],
    }),
  ).toEqual({ id: 'created' });
  expect(mockClient.post).toHaveBeenLastCalledWith('/membership-communities/c/content', {
    kind: 'discussion',
    body: 'private',
    parentContentId: 'thread',
    mediaIds: ['media'],
  });
  await membershipsService.report('post', 'private reason');
  expect(mockClient.post).toHaveBeenLastCalledWith('/membership-communities/content/post/reports', {
    reason: 'private reason',
  });
  await membershipsService.resolveReport('c', 'report');
  expect(mockClient.post).toHaveBeenLastCalledWith(
    '/membership-communities/c/reports/report/resolve',
  );
  await membershipsService.vote('post', 'option');
  expect(mockClient.put).toHaveBeenLastCalledWith('/membership-communities/content/post/vote', {
    optionId: 'option',
  });
  expect(
    await membershipsService.createTier('c', {
      name: 'Draft',
      kind: 'paid',
      benefits: ['content_read'],
    }),
  ).toEqual({ id: 'created' });
  await membershipsService.updateTier('c', 'tier', { name: 'Readers', benefits: ['content_read'] });
  expect(mockClient.patch).toHaveBeenLastCalledWith('/membership-communities/c/tiers/tier', {
    name: 'Readers',
    benefits: ['content_read'],
  });
  await membershipsService.removeContent('post');
  await membershipsService.revoke('c', 'member');
  await membershipsService.discardUpload('c', 'draft');
  expect(mockClient.delete.mock.calls).toEqual([
    ['/membership-communities/content/post'],
    ['/membership-communities/c/members/member'],
    ['/membership-communities/c/media/draft'],
  ]);
});
it('unwraps private reads without changing their viewer or retaining an error as data', async () => {
  const signal = new AbortController().signal;
  for (const read of [
    () => membershipsService.mine(signal),
    () => membershipsService.readContent('post', signal),
    () => membershipsService.teaser('post', signal),
    () => membershipsService.insights('c', signal),
    () => membershipsService.reports('c', signal),
    () => membershipsService.directory('c', signal),
  ]) {
    mockClient.get.mockResolvedValueOnce({ data: { data: { exact: 'payload' } } });
    expect(await read()).toEqual({ exact: 'payload' });
    expect(mockClient.get.mock.lastCall?.[1]).toEqual({ signal });
  }
});
