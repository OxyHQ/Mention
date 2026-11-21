import { AppState, type AppStateStatus } from 'react-native';

/**
 * React Query's device signals are Mention's to wire: the Oxy SDK no longer
 * drives `onlineManager` or `focusManager`, and on a device React Query has no
 * signal of its own. `lib/queryClient` wires both, once, when the client is
 * created.
 */

let mockNetInfoListener: ((state: { isConnected: boolean | null }) => void) | undefined;
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: (listener: (state: { isConnected: boolean | null }) => void) => {
      mockNetInfoListener = listener;
      return () => undefined;
    },
  },
}));

it('feeds React Query the network and whether the app is in front', () => {
  let onAppState: ((status: AppStateStatus) => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    onAppState = listener;
    return { remove: jest.fn() };
  });

  require('../queryClient');
  const { focusManager, onlineManager } =
    jest.requireActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');

  mockNetInfoListener?.({ isConnected: false });
  expect(onlineManager.isOnline()).toBe(false);
  // Not yet known counts as connected: never NetInfo's reachability probe.
  mockNetInfoListener?.({ isConnected: null });
  expect(onlineManager.isOnline()).toBe(true);

  onAppState?.('background');
  expect(focusManager.isFocused()).toBe(false);
  onAppState?.('active');
  expect(focusManager.isFocused()).toBe(true);
});
