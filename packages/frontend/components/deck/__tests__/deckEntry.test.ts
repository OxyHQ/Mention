import { isDefaultLeadingDeckPanel } from '../deckEntry';
import { emptySnapshot, useDeckSettings } from '../deckSettings';

it('replaces only the untouched original leading slot with the fixed application column', () => {
  const snapshot = emptySnapshot();
  expect(isDefaultLeadingDeckPanel(snapshot)).toBe(true);
  snapshot.panels['deck-0'].navigation = {
    entries: [{ key: 'root', name: '/explore' }],
    index: 0,
  };
  expect(isDefaultLeadingDeckPanel(snapshot)).toBe(true);
  snapshot.panels['deck-0'].width = 510;
  expect(isDefaultLeadingDeckPanel(snapshot)).toBe(false);
});

it('preserves a customized first source, order or restored page', () => {
  const snapshot = emptySnapshot();
  snapshot.panels['deck-0'].source = 'saved';
  expect(isDefaultLeadingDeckPanel(snapshot)).toBe(false);
  snapshot.panels['deck-0'].source = 'explore';
  snapshot.order.reverse();
  expect(isDefaultLeadingDeckPanel(snapshot)).toBe(false);
  snapshot.order.reverse();
  snapshot.panels['deck-0'].navigation = {
    entries: [
      { key: 'root', name: '/explore' },
      { key: 'post', name: '/p/one' },
    ],
    index: 1,
  };
  expect(isDefaultLeadingDeckPanel(snapshot)).toBe(false);
});

it('keeps each account’s local layout mode separate from synchronized columns', () => {
  useDeckSettings.setState({ records: {}, layoutModes: {} });
  useDeckSettings.getState().activate('anonymous');
  useDeckSettings.getState().setDeckEnabled(true);
  expect(useDeckSettings.getState().records.anonymous.state).not.toHaveProperty('deckEnabled');
  useDeckSettings.getState().activate('user:a');
  expect(useDeckSettings.getState().deckEnabled).toBe(false);
  useDeckSettings.getState().activate('anonymous');
  expect(useDeckSettings.getState().deckEnabled).toBe(true);
});
