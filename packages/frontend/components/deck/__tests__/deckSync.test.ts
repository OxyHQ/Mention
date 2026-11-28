import { useDeckSettings, DEFAULT_DECK_SETTINGS, type DeckSnapshot } from '../deckSettings';
import { startDeckSync } from '../deckSync';
import { mergeDeckChanges } from '../deckPersistence';
const snapshot = (): DeckSnapshot => ({
  syncEnabled: true,
  panels: structuredClone(DEFAULT_DECK_SETTINGS),
  order: Object.keys(DEFAULT_DECK_SETTINGS),
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  jest.useFakeTimers();
  useDeckSettings.setState({ records: {} });
  useDeckSettings.getState().activate('user:a');
});
afterEach(() => jest.useRealTimers());
it('keeps different panel edits and treats a navigation history atomically', () => {
  const base = snapshot();
  const local = snapshot();
  const remote = snapshot();
  local.panels['deck-0'].navigation = { entries: [{ key: 'p', name: '/p/one' }], index: 0 };
  remote.panels['deck-1'].width = 600;
  const result = mergeDeckChanges(base, local, remote);
  expect(result.panels['deck-1'].width).toBe(600);
  expect(result.panels['deck-0'].navigation?.entries[0].name).toBe('/p/one');
});
it('restores each viewer independently and never imports another account', () => {
  useDeckSettings.getState().updatePanel('deck-0', { width: 500 });
  useDeckSettings.getState().activate('user:b');
  expect(useDeckSettings.getState().panels['deck-0'].width).toBe(390);
  useDeckSettings.getState().activate('user:a');
  expect(useDeckSettings.getState().panels['deck-0'].width).toBe(500);
});
it('fences a response after account switching', async () => {
  let resolve!: (v: any) => void;
  const save = jest.fn();
  const sync = startDeckSync('user:a', {
    load: () =>
      new Promise((r) => {
        resolve = r;
      }),
    save,
  });
  useDeckSettings.getState().activate('user:b');
  const remote = snapshot();
  remote.panels['deck-0'].width = 610;
  resolve({ revision: 5, state: remote });
  await flush();
  expect(useDeckSettings.getState().panels['deck-0'].width).toBe(390);
  expect(save).not.toHaveBeenCalled();
  sync.stop();
});
it('retains edits made during a save and sends them after acknowledgement', async () => {
  let acknowledge!: (v: any) => void;
  const save = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          acknowledge = r;
        }),
    )
    .mockImplementation(async (revision, state) => ({ revision: revision + 1, state }));
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: snapshot() }),
    save,
  });
  await flush();
  useDeckSettings.getState().updatePanel('deck-0', { width: 500 });
  await jest.advanceTimersByTimeAsync(400);
  const sent = save.mock.calls[0][1];
  useDeckSettings.getState().updatePanel('deck-1', { width: 600 });
  acknowledge({ revision: 2, state: sent });
  await flush();
  expect(useDeckSettings.getState().records['user:a'].dirty).toBe(true);
  await jest.advanceTimersByTimeAsync(400);
  expect(save.mock.calls[1][1].panels['deck-1'].width).toBe(600);
  expect(useDeckSettings.getState().records['user:a'].dirty).toBe(false);
  sync.stop();
});
it('preserves offline pending changes and retries with CAS revision', async () => {
  const save = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async (revision, state) => ({ revision: revision + 1, state }));
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 3, state: snapshot() }),
    save,
  });
  await flush();
  useDeckSettings.getState().updatePanel('deck-0', { width: 500 });
  await jest.advanceTimersByTimeAsync(400);
  expect(useDeckSettings.getState().status).toBe('error');
  expect(useDeckSettings.getState().records['user:a'].dirty).toBe(true);
  await jest.advanceTimersByTimeAsync(1000);
  expect(save.mock.calls[1][0]).toBe(3);
  expect(useDeckSettings.getState().status).toBe('saved');
  sync.stop();
});
it('merges a conflict without losing another device panel changes', async () => {
  const remote = snapshot();
  remote.panels['deck-1'].width = 600;
  const save = jest
    .fn()
    .mockRejectedValueOnce({ response: { status: 409, data: { revision: 2, state: remote } } })
    .mockImplementation(async (revision, state) => ({ revision: revision + 1, state }));
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: snapshot() }),
    save,
  });
  await flush();
  useDeckSettings.getState().updatePanel('deck-0', { width: 500 });
  await jest.advanceTimersByTimeAsync(401);
  expect(save.mock.calls[1][0]).toBe(2);
  expect(save.mock.calls[1][1].panels['deck-0'].width).toBe(500);
  expect(save.mock.calls[1][1].panels['deck-1'].width).toBe(600);
  sync.stop();
});
it('disabling sync preserves device workspace and does not upload further local edits', async () => {
  const save = jest.fn().mockImplementation(async (revision, state) => ({
    revision: revision + 1,
    state: { ...snapshot(), syncEnabled: state.syncEnabled },
  }));
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: snapshot() }),
    save,
  });
  await flush();
  useDeckSettings.getState().setSyncEnabled(false);
  await jest.advanceTimersByTimeAsync(400);
  useDeckSettings.getState().updatePanel('deck-0', { width: 500 });
  await jest.advanceTimersByTimeAsync(400);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][1]).toEqual({ syncEnabled: false, panels: {}, order: [] });
  expect(useDeckSettings.getState().panels['deck-0'].width).toBe(500);
  useDeckSettings.getState().setSyncEnabled(true);
  await jest.advanceTimersByTimeAsync(400);
  expect(save.mock.calls[1][1].panels['deck-0'].width).toBe(500);
  sync.stop();
});
it('merges edits made while initial remote load is pending without reverting the active page', async () => {
  let resolve!: (value: any) => void;
  const save = jest
    .fn()
    .mockImplementation(async (revision, state) => ({ revision: revision + 1, state }));
  const sync = startDeckSync('user:a', {
    load: () =>
      new Promise((r) => {
        resolve = r;
      }),
    save,
  });
  useDeckSettings.getState().updatePanel('deck-0', {
    navigation: { entries: [{ key: 'topic', name: '/t/Bloom' }], index: 0 },
  });
  const remote = snapshot();
  remote.panels['deck-1'].width = 600;
  resolve({ revision: 5, state: remote });
  await flush();
  expect(useDeckSettings.getState().panels['deck-0'].navigation?.entries[0].name).toBe('/t/Bloom');
  expect(useDeckSettings.getState().panels['deck-1'].width).toBe(600);
  sync.stop();
});
it('restores a disabled preference without replacing the local workspace or uploading it', async () => {
  useDeckSettings.getState().updatePanel('deck-0', { width: 500 });
  const remote = { ...snapshot(), syncEnabled: false, panels: {}, order: [] };
  const save = jest.fn();
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 2, state: remote }),
    save,
  });
  await flush();
  expect(useDeckSettings.getState().syncEnabled).toBe(false);
  expect(useDeckSettings.getState().panels['deck-0'].width).toBe(500);
  expect(save).not.toHaveBeenCalled();
  sync.stop();
});
it('does not keep saving acknowledged objects with differently ordered keys', async () => {
  const remote = snapshot();
  const save = jest.fn();
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: remote }),
    save,
  });
  await flush();
  await jest.advanceTimersByTimeAsync(3000);
  expect(save).not.toHaveBeenCalled();
  expect(useDeckSettings.getState().status).toBe('saved');
  sync.stop();
});
it('merges concurrent panel deletion and addition with valid complete order', async () => {
  const remote = snapshot();
  remote.panels['deck-other'] = {
    source: 'explore',
    width: 400,
    resizable: true,
    appearance: 'solid',
  };
  remote.order.push('deck-other');
  const save = jest
    .fn()
    .mockRejectedValueOnce({ response: { status: 409, data: { revision: 2, state: remote } } })
    .mockImplementation(async (revision, state) => ({ revision: revision + 1, state }));
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: snapshot() }),
    save,
  });
  await flush();
  useDeckSettings.getState().removePanel('deck-1');
  await jest.advanceTimersByTimeAsync(401);
  const merged = save.mock.calls[1][1];
  expect(merged.panels['deck-1']).toBeUndefined();
  expect(merged.panels['deck-other']).toBeDefined();
  expect(merged.order).toEqual(['deck-0', 'deck-2', 'deck-3', 'deck-other']);
  expect(new Set(merged.order)).toEqual(new Set(Object.keys(merged.panels)));
  sync.stop();
});
it('preserves a local addition when another device deleted a different panel', async () => {
  const remote = snapshot();
  delete remote.panels['deck-1'];
  remote.order = remote.order.filter((id) => id !== 'deck-1');
  const save = jest
    .fn()
    .mockRejectedValueOnce({ response: { status: 409, data: { revision: 2, state: remote } } })
    .mockImplementation(async (revision, state) => ({ revision: revision + 1, state }));
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: snapshot() }),
    save,
  });
  await flush();
  useDeckSettings.getState().receive('user:a', {
    ...useDeckSettings.getState().records['user:a'],
    dirty: true,
    state: {
      ...snapshot(),
      panels: {
        ...snapshot().panels,
        'deck-new': { source: 'saved', width: 390, resizable: true, appearance: 'solid' },
      },
      order: [...snapshot().order, 'deck-new'],
    },
  });
  await jest.advanceTimersByTimeAsync(401);
  const merged = save.mock.calls[1][1];
  expect(merged.order).toEqual(['deck-0', 'deck-2', 'deck-3', 'deck-new']);
  expect(merged.panels['deck-new'].source).toBe('saved');
  sync.stop();
});
it('sends a disable preference made while the preceding workspace save is still in flight', async () => {
  let acknowledge!: (value: any) => void;
  const save = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    )
    .mockImplementation(async (revision, state) => ({ revision: revision + 1, state }));
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: snapshot() }),
    save,
  });
  await flush();
  useDeckSettings.getState().updatePanel('deck-0', { width: 500 });
  await jest.advanceTimersByTimeAsync(400);
  const sent = save.mock.calls[0][1];
  useDeckSettings.getState().setSyncEnabled(false);
  acknowledge({ revision: 2, state: sent });
  await flush();
  await jest.advanceTimersByTimeAsync(400);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][1]).toEqual({ syncEnabled: false, panels: {}, order: [] });
  expect(useDeckSettings.getState().records['user:a'].dirty).toBe(false);
  sync.stop();
});
it('syncs home preference without losing concurrent panel changes', async () => {
  const remote = snapshot();
  remote.panels['deck-1'].width = 600;
  useDeckSettings.getState().setHomeScreen(true);
  const save = jest.fn(async (revision, state) => ({ revision: revision + 1, state }));
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: remote }),
    save,
  });
  await flush();
  await jest.advanceTimersByTimeAsync(400);
  expect(save).toHaveBeenCalled();
  expect(useDeckSettings.getState().homeScreen).toBe(true);
  expect(useDeckSettings.getState().panels['deck-1'].width).toBe(600);
  expect(useDeckSettings.getState().records['user:a'].dirty).toBe(false);
  sync.stop();
});
it('keeps a new home preference local while sync is disabled', async () => {
  const remote = { ...snapshot(), syncEnabled: false, homeScreen: false };
  const save = jest.fn();
  const sync = startDeckSync('user:a', {
    load: async () => ({ revision: 1, state: remote }),
    save,
  });
  await flush();
  useDeckSettings.getState().setHomeScreen(true);
  await jest.advanceTimersByTimeAsync(1000);
  expect(useDeckSettings.getState().homeScreen).toBe(true);
  expect(save).not.toHaveBeenCalled();
  sync.stop();
});
it('reveals an explicitly added panel without persisting the command or replaying it on account activation', () => {
  const id = useDeckSettings.getState().addPanel('saved');
  const store = useDeckSettings.getState();
  expect(store.revealPanel?.id).toBe(id);
  expect(store.records['user:a'].state).not.toHaveProperty('revealPanel');
  store.activate('user:b');
  expect(useDeckSettings.getState().revealPanel).toBeUndefined();
  useDeckSettings.getState().activate('user:a');
  expect(useDeckSettings.getState().activePanel).toBe(id);
  expect(useDeckSettings.getState().revealPanel).toBeUndefined();
});
