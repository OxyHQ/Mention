import { resolveMention } from '../resolveMention';
import { feedService } from '@/services/feedService';
jest.mock('@/services/feedService', () => ({ feedService: { resolveExternalActor: jest.fn() } }));
const resolve = jest.mocked(feedService.resolveExternalActor);
const actor = {
  network: 'activitypub' as const,
  externalId: 'https://mastodon.social/users/zackwhittaker',
  handle: 'zackwhittaker@mastodon.social',
  oxyUserId: 'oxy-zack',
  followed: false,
};
beforeEach(() => resolve.mockReset());
it('uses the canonical identity returned for the source, even if its handle differs', async () => {
  resolve.mockResolvedValue(actor);
  expect(await resolveMention('https://bridge.example/users/opaque')).toEqual(actor);
  expect(resolve).toHaveBeenCalledTimes(1);
});
it('resolves the reported Mastodon URL through WebFinger when URL discovery misses', async () => {
  resolve.mockResolvedValueOnce(null).mockResolvedValueOnce(actor);
  expect(await resolveMention('https://mastodon.social/@zackwhittaker')).toEqual(actor);
  expect(resolve.mock.calls.map(([query]) => query)).toEqual([
    'https://mastodon.social/@zackwhittaker',
    'zackwhittaker@mastodon.social',
  ]);
});
it('never treats an opaque actor ID as a username', async () => {
  resolve.mockResolvedValue(null);
  expect(await resolveMention('https://remote.example/users/123')).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(1);
});
it('keeps an unresolved account unresolved rather than inventing an ID', async () => {
  resolve.mockResolvedValue(null);
  expect(await resolveMention('https://remote.example/@alice')).toBeNull();
});
it('propagates network failures so the reader can retry', async () => {
  resolve.mockRejectedValue(new Error('Offline'));
  await expect(resolveMention('https://remote.example/@alice')).rejects.toThrow('Offline');
});
