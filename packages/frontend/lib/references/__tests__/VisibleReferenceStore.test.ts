import { VisibleReferenceStore, type ReferenceBatch } from '../VisibleReferenceStore';

type Item = { id: string; title: string };
const item = { id: 'case-1', title: 'Public title' };
const ready = { items: [item], unavailableIds: [] };
const tick = async (ms = 16) => {
  await jest.advanceTimersByTimeAsync(ms);
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('groups a visible viewport and deduplicates concurrent cards, with no request on construction', async () => {
  const load = jest.fn(async (ids: readonly string[]) => ({
    items: ids.map((id) => ({ ...item, id })),
    unavailableIds: [],
  }));
  const store = new VisibleReferenceStore(load);
  expect(load).not.toHaveBeenCalled();
  const stop = [
    store.subscribe('case-1', jest.fn()),
    store.subscribe('case-1', jest.fn()),
    store.subscribe('case-2', jest.fn()),
  ];
  expect(store.getSnapshot('case-1')).toEqual({ status: 'loading' });
  await tick();
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.calls[0][0]).toEqual(['case-1', 'case-2']);
  for (const unsubscribe of stop) unsubscribe();
  expect(store.getSnapshot('case-1')).toEqual({ status: 'loading' });
});

it('does not load render-ahead/hidden or unsubscribed queued cards', async () => {
  const load = jest.fn(async () => ready);
  const store = new VisibleReferenceStore(load);
  const stop = store.subscribe('case-1', jest.fn());
  stop();
  await tick();
  expect(load).not.toHaveBeenCalled();
});

it.each(['withdrawn', 'error', 'malformed'] as const)(
  'drops old facts on %s and never restores a stale snapshot',
  async (failure) => {
    const load = jest
      .fn<Promise<ReferenceBatch<Item>>, [readonly string[], { signal: AbortSignal }]>()
      .mockResolvedValueOnce(ready);
    if (failure === 'error') load.mockRejectedValueOnce(new Error('offline'));
    else
      load.mockResolvedValueOnce({
        items: [],
        unavailableIds: failure === 'withdrawn' ? ['case-1'] : [],
      });
    const store = new VisibleReferenceStore(load);
    const stop = store.subscribe('case-1', jest.fn());
    await tick();
    expect(store.getSnapshot('case-1')).toEqual({ status: 'ready', value: item });
    store.refresh();
    expect(store.getSnapshot('case-1')).toEqual({ status: 'loading' });
    await tick();
    expect(store.getSnapshot('case-1')).toEqual({ status: 'unavailable' });
    stop();
  },
);

it('periodically revalidates visible references and clears a revoked public case', async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({ items: [], unavailableIds: ['case-1'] });
  const store = new VisibleReferenceStore<Item>(load, { refreshMs: 100 });
  const stop = store.subscribe('case-1', jest.fn());
  await tick();
  await tick(100);
  expect(store.getSnapshot('case-1')).toEqual({ status: 'loading' });
  await tick();
  expect(store.getSnapshot('case-1')).toEqual({ status: 'unavailable' });
  stop();
});

it('times out a provider that ignores abort, without a late response resurrecting facts', async () => {
  let finish!: (result: ReferenceBatch<Item>) => void;
  const load = jest.fn(
    (_ids: readonly string[], _options: { signal: AbortSignal }) =>
      new Promise<ReferenceBatch<Item>>((resolve) => {
        finish = resolve;
      }),
  );
  const store = new VisibleReferenceStore(load, { timeoutMs: 100 });
  const stop = store.subscribe('case-1', jest.fn());
  await tick();
  await tick(100);
  expect(load.mock.calls[0][1].signal.aborted).toBe(true);
  expect(store.getSnapshot('case-1')).toEqual({ status: 'unavailable' });
  finish(ready);
  await tick();
  expect(store.getSnapshot('case-1')).toEqual({ status: 'unavailable' });
  stop();
});

it('ignores an old lifetime response after recycling the same reference', async () => {
  let finish!: (result: ReferenceBatch<Item>) => void;
  const load = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ items: [], unavailableIds: ['case-1'] });
  const store = new VisibleReferenceStore<Item>(load);
  const first = store.subscribe('case-1', jest.fn());
  await tick();
  first();
  const second = store.subscribe('case-1', jest.fn());
  await tick();
  finish(ready);
  await tick();
  expect(store.getSnapshot('case-1')).toEqual({ status: 'unavailable' });
  second();
});
