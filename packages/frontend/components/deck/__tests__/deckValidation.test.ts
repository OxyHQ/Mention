import { normalizeDeckSnapshot, normalizeNavigation } from '../deckValidation';
import { emptySnapshot } from '../deckSettings';
it('rejects malformed cache shapes and external navigation destinations', () => {
  expect(normalizeDeckSnapshot({ panels: 'bad' })).toBeNull();
  expect(
    normalizeNavigation({ entries: [{ key: 'r', name: 'https://evil.test' }], index: 0 }),
  ).toBeUndefined();
  expect(
    normalizeNavigation({ entries: [{ key: 'r', name: '//evil.test' }], index: 0 }),
  ).toBeUndefined();
  expect(
    normalizeNavigation({ entries: [{ key: 'r', name: '/explore' }], index: 7 }),
  ).toBeUndefined();
});
it('persists references only and bounds navigation around current page', () => {
  const navigation = normalizeNavigation({
    entries: Array.from({ length: 150 }, (_, i) => ({
      key: String(i),
      name: '/p/' + i,
      params: { id: String(i), privatePost: { content: 'private' }, nonfinite: NaN },
    })),
    index: 149,
  })!;
  expect(navigation.entries[navigation.index].name).toBe('/p/149');
  expect(navigation.entries.length).toBeLessThanOrEqual(100);
  expect(navigation.entries[0].params).toEqual({ id: '50' });
});
it('drops invalid scroll offsets and repairs missing and duplicate panel order', () => {
  const state = emptySnapshot();
  state.order = ['missing', 'deck-0', 'deck-0'];
  state.panels['deck-0'].scrollOffsets = { negative: -3, infinite: Infinity, valid: 123 };
  const clean = normalizeDeckSnapshot(state)!;
  expect(clean.order).toEqual(['deck-0', 'deck-1', 'deck-2', 'deck-3']);
  expect(clean.panels['deck-0'].scrollOffsets).toEqual({ valid: 123 });
});
it('rejects encoded external paths, prototype keys and duplicate route identities', () => {
  expect(
    normalizeNavigation({ entries: [{ key: 'a', name: '/%2Fexample.test' }], index: 0 }),
  ).toBeUndefined();
  expect(
    normalizeNavigation({
      entries: [
        { key: 'a', name: '/ok' },
        { key: 'a', name: '/other' },
      ],
      index: 0,
    }),
  ).toBeUndefined();
  const state = emptySnapshot();
  Object.defineProperty(state.panels, '__proto__', {
    value: state.panels['deck-0'],
    enumerable: true,
  });
  expect(Object.hasOwn(normalizeDeckSnapshot(state)!.panels, '__proto__')).toBe(false);
});
it('evicts old history and scroll data before exceeding the server payload limit', () => {
  const { boundDeckSnapshot } = require('../deckValidation');
  const state = emptySnapshot();
  for (let panel = 0; panel < 24; panel++) {
    state.panels['deck-' + panel] = {
      ...state.panels['deck-0'],
      navigation: {
        entries: Array.from({ length: 100 }, (_, i) => ({
          key: String(i),
          name: '/t/' + String(i) + 'x'.repeat(500),
        })),
        index: 99,
      },
      scrollOffsets: Object.fromEntries(
        Array.from({ length: 256 }, (_, i) => ['key' + i + 'x'.repeat(100), i]),
      ),
    };
  }
  state.order = Object.keys(state.panels);
  const bounded = boundDeckSnapshot(state);
  expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThan(524288);
  expect(
    bounded.panels['deck-0'].navigation.entries[bounded.panels['deck-0'].navigation.index].key,
  ).toBe('99');
});
it('bounds even oversized current-route params without dropping small route identifiers', () => {
  const { boundDeckSnapshot } = require('../deckValidation');
  const state = emptySnapshot();
  for (let i = 0; i < 24; i++) {
    state.panels['deck-' + i] = {
      source: 'explore',
      width: 390,
      resizable: true,
      appearance: 'solid',
      navigation: {
        index: 0,
        entries: [
          {
            key: 'current',
            name: '/t/' + '漢'.repeat(4000),
            params: { huge: Array.from({ length: 32 }, () => '漢'.repeat(2048)), id: 'topic' },
          },
        ],
      },
    };
  }
  state.order = Object.keys(state.panels);
  const bounded = boundDeckSnapshot(state);
  expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThan(524288);
  expect(bounded.panels['deck-0'].navigation.entries[0].name).toBe('/t/' + '漢'.repeat(4000));
  const normal = normalizeNavigation({
    entries: [
      {
        key: 'r',
        name: '/t/topic',
        params: { huge: Array.from({ length: 32 }, () => '漢'.repeat(2048)), id: 'topic' },
      },
    ],
    index: 0,
  })!;
  expect(normal.entries[0].params).toEqual({ id: 'topic' });
});
it('accepts legacy workspaces and preserves only boolean home preferences', () => {
  const state = emptySnapshot();
  expect(normalizeDeckSnapshot(state)?.homeScreen).not.toBe(true);
  expect(normalizeDeckSnapshot({ ...state, homeScreen: true })?.homeScreen).toBe(true);
  expect(normalizeDeckSnapshot({ ...state, homeScreen: 'true' })?.homeScreen).toBeUndefined();
});
