import { emptySnapshot, useDeckSettings } from '../deckSettings';
import { isDefaultLeadingDeckPanel } from '../deckEntry';
import { mergeDeckChanges } from '../deckPersistence';

beforeEach(() => {
  useDeckSettings.setState({ records: {}, layoutModes: {} });
  useDeckSettings.getState().activate('anonymous');
});

it('persists moved columns without moving the hidden default slot or losing their state', () => {
  useDeckSettings.getState().updatePanel('deck-1', {
    width: 510,
    navigation: { entries: [{ key: 'post', name: '/p/one' }], index: 0 },
    scrollOffsets: { post: 350 },
  });
  const before = structuredClone(useDeckSettings.getState().panels);
  const order = useDeckSettings.getState().order.slice(1).reverse();
  useDeckSettings.getState().reorderPanels(['main', 'context', ...order]);
  const state = useDeckSettings.getState();
  expect(state.order).toEqual(['deck-0', ...order]);
  expect(state.panels).toEqual(before);
  expect(isDefaultLeadingDeckPanel(state)).toBe(true);
  expect(state.records.anonymous.state.order).toEqual(state.order);
  expect(state.records.anonymous.dirty).toBe(true);
  useDeckSettings.getState().activate('user:a');
  expect(useDeckSettings.getState().order).toEqual(emptySnapshot().order);
  useDeckSettings.getState().activate('anonymous');
  expect(useDeckSettings.getState().order).toEqual(state.order);
});

it('retains all columns when an incoming order omits panels or contains duplicate/unknown IDs', () => {
  const original = useDeckSettings.getState().order;
  useDeckSettings.getState().reorderPanels(['deck-2', 'main', 'deck-2', 'deck-1']);
  expect(useDeckSettings.getState().order).toEqual(
    original.map((id) => (id === 'deck-1' ? 'deck-2' : id === 'deck-2' ? 'deck-1' : id)),
  );
  expect(Object.keys(useDeckSettings.getState().panels)).toHaveLength(original.length);
});

it('keeps the local reordered sequence while accepting independent remote column changes', () => {
  const base = emptySnapshot();
  const local = emptySnapshot();
  const remote = emptySnapshot();
  local.order = ['deck-0', ...local.order.slice(1).reverse()];
  remote.panels['deck-1'].width = 580;
  remote.panels['deck-2'].navigation = {
    entries: [{ key: 'post', name: '/p/remote' }],
    index: 0,
  };
  const merged = mergeDeckChanges(base, local, remote);
  expect(merged.order).toEqual(local.order);
  expect(merged.panels['deck-1'].width).toBe(580);
  expect(merged.panels['deck-2'].navigation).toEqual(remote.panels['deck-2'].navigation);
});
