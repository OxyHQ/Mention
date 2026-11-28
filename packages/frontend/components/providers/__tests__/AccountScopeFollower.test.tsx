import { createAccounts, setActiveStore, withStore } from '@oxy.so/bloom-data';
import TestRenderer, { act } from 'react-test-renderer';
import { AccountScopeFollower } from '@/components/providers/AccountScopeFollower';
import { currentAccountId } from '@/lib/accountScope';
import { SavedFeeds } from '@/lib/savedFeedsCopy';

let mockAccountId: string | null = 'viewer-a';
const mockListeners = new Set<() => void>();
const mockRuntime = {
  getSnapshot: () => ({ account: mockAccountId ? { id: mockAccountId } : null }),
  subscribe(listener: () => void) {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
};
jest.mock('@oxy.so/services/runtime', () => ({ useOxyRuntime: () => mockRuntime }));
const mockWarn = jest.fn();
jest.mock('@oxy.so/core/logger', () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));

afterEach(() => {
  setActiveStore(undefined);
  jest.restoreAllMocks();
});

it('follows the runtime and reads what each account keeps, until it unmounts', async () => {
  const accounts = createAccounts();
  const load = jest.spyOn(SavedFeeds, 'load');
  accounts.open('viewer-a');

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AccountScopeFollower />);
  });
  expect(currentAccountId()).toBe('viewer-a');
  expect(load).toHaveBeenCalledTimes(1);

  // Services opens the next account's store before it notifies.
  const next = accounts.open('viewer-b');
  mockAccountId = 'viewer-b';
  await act(async () => {
    for (const listener of [...mockListeners]) listener();
  });
  expect(currentAccountId()).toBe('viewer-b');
  expect(load).toHaveBeenCalledTimes(2);
  expect(withStore(next, () => SavedFeeds.get())).toBeUndefined();

  load.mockRejectedValueOnce(new Error('storage is blocked'));
  mockAccountId = null;
  await act(async () => {
    for (const listener of [...mockListeners]) listener();
  });
  expect(mockWarn).toHaveBeenCalledTimes(1);

  act(() => renderer.unmount());
  expect(currentAccountId()).toBeNull();
  expect(mockListeners.size).toBe(0);
});
