import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { DeckHomeEntry } from '../DeckHomeEntry';
import { useDeckSettings } from '../deckSettings';

let mockAvailable = true;
let mockPathname = '/';
let mockAuth: { user: { id: string } | null; isAuthResolved: boolean } = {
  user: { id: 'a' },
  isAuthResolved: true,
};
jest.mock('../useDeckAvailable', () => ({ useDeckAvailable: () => mockAvailable }));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  Redirect: ({ href }: { href: string }) => {
    const { Text } = require('react-native');
    return <Text>{`Redirect ${href}`}</Text>;
  },
}));
const mountedTrees = new Set<TestRenderer.ReactTestRenderer>();
afterEach(() => {
  act(() => {
    for (const tree of mountedTrees) tree.unmount();
  });
  mountedTrees.clear();
});
function home() {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <DeckHomeEntry>
        <Text>Route content</Text>
      </DeckHomeEntry>,
    );
  });
  if (!renderer) throw new Error('Renderer was not created');
  const tree = renderer;
  mountedTrees.add(tree);
  return {
    getByText: (text: string) =>
      tree.root.findAllByType(Text).find((node) => node.props.children === text),
    unmount: () =>
      act(() => {
        tree.unmount();
        mountedTrees.delete(tree);
      }),
  };
}
beforeEach(() => {
  mockAvailable = true;
  mockPathname = '/';
  mockAuth = { user: { id: 'a' }, isAuthResolved: true };
  useDeckSettings.setState({ records: {} });
  useDeckSettings.getState().activate('user:a');
});
it('defaults legacy/new accounts to the normal home and opts into Deck immediately', () => {
  const screen = home();
  expect(screen.getByText('Route content')).toBeTruthy();
  screen.unmount();
  useDeckSettings.getState().setHomeScreen(true);
  expect(home().getByText('Redirect /deck')).toBeTruthy();
});
it.each(['/deck', '/t/Bloom', '/settings/deck', '/p/one'])('preserves deep link %s', (path) => {
  useDeckSettings.getState().setHomeScreen(true);
  mockPathname = path;
  expect(home().getByText('Route content')).toBeTruthy();
});
it('keeps normal home when Deck is unavailable on native or compact screens', () => {
  useDeckSettings.getState().setHomeScreen(true);
  mockAvailable = false;
  expect(home().getByText('Route content')).toBeTruthy();
});
it('never redirects with an unresolved session or another account’s cached choice', () => {
  useDeckSettings.getState().setHomeScreen(true);
  mockAuth = { user: { id: 'b' }, isAuthResolved: true };
  const screen = home();
  expect(screen.getByText('Route content')).toBeTruthy();
  screen.unmount();
  mockAuth = { user: { id: 'a' }, isAuthResolved: false };
  expect(home().getByText('Route content')).toBeTruthy();
});
it('restores account choices independently, including disabling the preference', () => {
  useDeckSettings.getState().setHomeScreen(true);
  useDeckSettings.getState().activate('user:b');
  expect(useDeckSettings.getState().homeScreen).not.toBe(true);
  useDeckSettings.getState().activate('user:a');
  expect(useDeckSettings.getState().homeScreen).toBe(true);
  useDeckSettings.getState().setHomeScreen(false);
  expect(home().getByText('Route content')).toBeTruthy();
});
it('keeps the Expo navigator mounted while the preference redirects Home', () => {
  const mounted = jest.fn();
  const unmounted = jest.fn();
  function Navigator() {
    React.useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <Text>Navigator</Text>;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <DeckHomeEntry>
        <Navigator />
      </DeckHomeEntry>,
    );
  });
  act(() => useDeckSettings.getState().setHomeScreen(true));
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
  act(() => renderer?.unmount());
});
