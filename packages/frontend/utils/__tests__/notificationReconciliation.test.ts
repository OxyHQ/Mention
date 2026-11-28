import { QueryClient } from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { reconcileNotificationCache } from '../notificationReconciliation';

const page = (id: string, read = false, nextCursor?: string) => ({
  notifications: [
    {
      _id: id,
      recipientId: 'A',
      actorId: 'system',
      type: 'welcome',
      entityId: '',
      entityType: 'system',
      read,
      createdAt: '2026-11-01T12:00:00Z',
    },
  ],
  unreadCount: read ? 0 : 1,
  hasMore: !!nextCursor,
  nextCursor,
  limit: 20,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let client: QueryClient;
let epoch: number;
const intent = { viewerId: 'A', epoch: 1 };
const current = () => epoch === intent.epoch;
const listKey = viewerQueryKeys.notifications('A');
const badgeKey = viewerQueryKeys.unreadNotifications('A');
beforeEach(() => {
  epoch = 1;
  client = new QueryClient();
  client.setQueryData(listKey, { pages: [page('one')], pageParams: [undefined] });
  client.setQueryData(badgeKey, 1);
});
afterEach(() => client.clear());

it('applies a protected snapshot only to the intended current session', async () => {
  const getPage = jest.fn().mockResolvedValue(page('one', true));
  const result = await reconcileNotificationCache(client, intent, current, { getPage });
  expect(getPage).toHaveBeenCalledWith('A', undefined, 20);
  expect(result.status).toBe('applied');
  expect(
    client.getQueryData<{ pages: ReturnType<typeof page>[] }>(listKey)?.pages[0].notifications[0]
      .read,
  ).toBe(true);
  expect(client.getQueryData(badgeKey)).toBe(0);
});

it('never applies a retained result after same-user replacement or ABA', async () => {
  const pending = deferred<ReturnType<typeof page>>();
  const work = reconcileNotificationCache(client, intent, current, {
    getPage: () => pending.promise,
  });
  epoch = 3;
  pending.resolve(page('one', true));
  expect((await work).status).toBe('session-changed');
  expect(
    client.getQueryData<{ pages: ReturnType<typeof page>[] }>(listKey)?.pages[0].notifications[0]
      .read,
  ).toBe(false);
  expect(client.getQueryData(badgeKey)).toBe(1);
});

it('does not overwrite any realtime or concurrent update received during a protected read', async () => {
  const pending = deferred<ReturnType<typeof page>>();
  const work = reconcileNotificationCache(client, intent, current, {
    getPage: () => pending.promise,
  });
  const later = { pages: [page('new')], pageParams: [undefined] };
  client.setQueryData(listKey, later);
  client.setQueryData(badgeKey, 2);
  pending.resolve(page('one', true));
  expect((await work).status).toBe('superseded');
  expect(client.getQueryData(listKey)).toEqual(later);
  expect(client.getQueryData(badgeKey)).toBe(2);
});

it('rejects even an idempotent realtime write during the read', async () => {
  const pending = deferred<ReturnType<typeof page>>();
  const work = reconcileNotificationCache(client, intent, current, {
    getPage: () => pending.promise,
  });
  client.setQueryData(listKey, (data: unknown) => data);
  pending.resolve(page('one', true));
  expect((await work).status).toBe('superseded');
});

it('preserves the cache when the protected read rejects and does not fall back', async () => {
  const error = Object.assign(new Error('viewer changed'), { status: 409 });
  const getPage = jest.fn().mockRejectedValue(error);
  const result = await reconcileNotificationCache(client, intent, current, { getPage });
  expect(result).toEqual({ status: 'failed', error });
  expect(getPage).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(badgeKey)).toBe(1);
});

it('walks current cursors for already-loaded pages, stopping a repeated cursor', async () => {
  client.setQueryData(listKey, {
    pages: [page('old'), page('older')],
    pageParams: [undefined, 'old'],
  });
  const getPage = jest
    .fn()
    .mockResolvedValueOnce(page('new', false, 'next'))
    .mockResolvedValueOnce(page('old', true, 'next'));
  expect((await reconcileNotificationCache(client, intent, current, { getPage })).status).toBe(
    'applied',
  );
  expect(getPage.mock.calls).toEqual([
    ['A', undefined, 20],
    ['A', 'next', 20],
  ]);
  expect(client.getQueryData<{ pageParams: unknown[] }>(listKey)?.pageParams).toEqual([
    undefined,
    'next',
  ]);
});

it('does not overwrite a badge update triggered while applying the list', async () => {
  const cache = client.getQueryCache();
  const list = cache.find({ queryKey: listKey, exact: true });
  let injected = false;
  const stop = cache.subscribe((event) => {
    if (
      !injected &&
      event.query === list &&
      event.type === 'updated' &&
      event.action.type === 'success'
    ) {
      injected = true;
      client.setQueryData(badgeKey, 99);
    }
  });
  try {
    const result = await reconcileNotificationCache(client, intent, current, {
      getPage: async () => page('one', true),
    });
    expect(result.status).toBe('superseded');
    expect(client.getQueryData(badgeKey)).toBe(99);
  } finally {
    stop();
  }
});
