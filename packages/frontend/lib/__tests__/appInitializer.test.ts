import { Platform } from 'react-native';
import { AppInitializer } from '../appInitializer';

const mockSetHandler = jest.fn();
const mockSetChannel = jest.fn();
const mockGetPermissions = jest.fn();
const mockLoadMutedState = jest.fn();
const mockHideSplash = jest.fn();
const mockWarn = jest.fn();

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-splash-screen', () => ({ hideAsync: () => mockHideSplash() }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: (...args: unknown[]) => mockSetHandler(...args),
  setNotificationChannelAsync: (...args: unknown[]) => mockSetChannel(...args),
  getPermissionsAsync: (...args: unknown[]) => mockGetPermissions(...args),
  AndroidImportance: { MAX: 5 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
}));
jest.mock('@/stores/videoMuteStore', () => ({
  useVideoMuteStore: { getState: () => ({ loadMutedState: () => mockLoadMutedState() }) },
}));
jest.mock('@oxy.so/core/logger', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: (...args: unknown[]) => mockWarn(...args) },
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Let all already-queued promise work run; do not depend on a microtask count. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as { OS: string }).OS = 'android';
  mockSetChannel.mockResolvedValue(undefined);
  mockGetPermissions.mockResolvedValue({ status: 'granted' });
  mockLoadMutedState.mockResolvedValue(undefined);
  mockHideSplash.mockResolvedValue(undefined);
});

it.each(['android', 'ios'])(
  'releases %s startup without an unused permission query',
  async (os) => {
    (Platform as { OS: string }).OS = os;
    // If the old permission call is restored, signal the test before returning a
    // never-settling promise. The race fails promptly instead of hanging Jest.
    const permissionCalled = deferred<'permission called'>();
    mockGetPermissions.mockImplementation(() => {
      permissionCalled.resolve('permission called');
      return new Promise(() => {});
    });
    const result = await Promise.race([
      AppInitializer.initializeApp(true),
      permissionCalled.promise,
    ]);
    expect(result).toEqual({ success: true });
    expect(mockSetHandler).toHaveBeenCalledTimes(1);
    expect(mockSetChannel).toHaveBeenCalledTimes(os === 'android' ? 1 : 0);
    expect(mockLoadMutedState).toHaveBeenCalledTimes(1);
    expect(mockGetPermissions).not.toHaveBeenCalled();
  },
);

it.each(['channel', 'mute'] as const)(
  'waits for %s readiness before hiding the splash',
  async (last) => {
    const channel = deferred();
    const channelStarted = deferred();
    const mute = deferred();
    mockSetChannel.mockImplementation(() => {
      channelStarted.resolve();
      return channel.promise;
    });
    mockLoadMutedState.mockReturnValue(mute.promise);
    const initialization = AppInitializer.initializeApp(true);
    await channelStarted.promise;
    expect(mockSetHandler).toHaveBeenCalledTimes(1);
    expect(mockSetChannel).toHaveBeenCalledWith('default', expect.any(Object));
    expect(mockSetHandler.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetChannel.mock.invocationCallOrder[0],
    );
    expect(mockHideSplash).not.toHaveBeenCalled();
    if (last === 'channel') mute.resolve();
    else channel.resolve();
    await nextTurn();
    expect(mockHideSplash).not.toHaveBeenCalled();
    if (last === 'channel') channel.resolve();
    else mute.resolve();
    await expect(initialization).resolves.toEqual({ success: true });
    expect(mockHideSplash).toHaveBeenCalledTimes(1);
  },
);

it('does not start native notification setup on web', async () => {
  (Platform as { OS: string }).OS = 'web';
  await expect(AppInitializer.initializeApp(true)).resolves.toEqual({ success: true });
  expect(mockSetHandler).not.toHaveBeenCalled();
  expect(mockSetChannel).not.toHaveBeenCalled();
  expect(mockGetPermissions).not.toHaveBeenCalled();
  expect(mockLoadMutedState).toHaveBeenCalledTimes(1);
});

it('reports and tolerates notification channel errors without skipping mute restoration', async () => {
  const error = new Error('channel failed');
  mockSetChannel.mockRejectedValue(error);
  await expect(AppInitializer.initializeApp(true)).resolves.toEqual({ success: true });
  expect(mockWarn).toHaveBeenCalledWith('Failed to set Android notification channel', { error });
  expect(mockLoadMutedState).toHaveBeenCalledTimes(1);
});

it('preserves the font gate and permits subsequent initializations', async () => {
  await expect(AppInitializer.initializeApp(false)).resolves.toMatchObject({ success: false });
  expect(mockSetHandler).not.toHaveBeenCalled();
  expect(mockLoadMutedState).not.toHaveBeenCalled();
  await expect(AppInitializer.initializeApp(true)).resolves.toEqual({ success: true });
  await expect(AppInitializer.initializeApp(true)).resolves.toEqual({ success: true });
  expect(mockSetHandler).toHaveBeenCalledTimes(2);
  expect(mockSetChannel).toHaveBeenCalledTimes(2);
  expect(mockLoadMutedState).toHaveBeenCalledTimes(2);
});
