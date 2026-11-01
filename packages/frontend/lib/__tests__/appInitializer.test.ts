import { Platform } from 'react-native';
import { AppInitializer } from '../appInitializer';

const mockSetupNotifications = jest.fn();
const mockHasNotificationPermission = jest.fn();
const mockLoadMutedState = jest.fn();
const mockHideSplash = jest.fn();
const mockWarn = jest.fn();

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-splash-screen', () => ({ hideAsync: () => mockHideSplash() }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/utils/notifications', () => ({
  setupNotifications: () => mockSetupNotifications(),
  hasNotificationPermission: () => mockHasNotificationPermission(),
}));
jest.mock('@/stores/videoMuteStore', () => ({
  useVideoMuteStore: { getState: () => ({ loadMutedState: () => mockLoadMutedState() }) },
}));
jest.mock('@oxy.so/core/logger', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: (...args: unknown[]) => mockWarn(...args) },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as { OS: string }).OS = 'android';
  mockSetupNotifications.mockResolvedValue(undefined);
  mockHasNotificationPermission.mockResolvedValue(true);
  mockLoadMutedState.mockResolvedValue(undefined);
  mockHideSplash.mockResolvedValue(undefined);
});

it.each(['android', 'ios'])(
  'releases %s startup without an unused permission query',
  async (os) => {
    (Platform as { OS: string }).OS = os;
    // An OS permission read can stall independently of channel and mute setup.
    mockHasNotificationPermission.mockReturnValue(new Promise(() => {}));
    let result: Awaited<ReturnType<typeof AppInitializer.initializeApp>> | undefined;
    void AppInitializer.initializeApp(true).then((value) => {
      result = value;
    });
    await settle();
    expect(mockSetupNotifications).toHaveBeenCalledTimes(1);
    expect(mockLoadMutedState).toHaveBeenCalledTimes(1);
    expect(mockHasNotificationPermission).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  },
);

it.each(['channel', 'mute'] as const)(
  'waits for %s readiness before hiding the splash',
  async (last) => {
    const channel = deferred();
    const mute = deferred();
    mockSetupNotifications.mockReturnValue(channel.promise);
    mockLoadMutedState.mockReturnValue(mute.promise);
    const initialization = AppInitializer.initializeApp(true);
    await settle();
    expect(mockSetupNotifications).toHaveBeenCalledTimes(1);
    expect(mockHideSplash).not.toHaveBeenCalled();
    if (last === 'channel') mute.resolve();
    else channel.resolve();
    await settle();
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
  expect(mockSetupNotifications).not.toHaveBeenCalled();
  expect(mockHasNotificationPermission).not.toHaveBeenCalled();
  expect(mockLoadMutedState).toHaveBeenCalledTimes(1);
});

it('reports and tolerates notification setup errors without skipping mute restoration', async () => {
  const error = new Error('notification setup failed');
  mockSetupNotifications.mockRejectedValue(error);
  await expect(AppInitializer.initializeApp(true)).resolves.toEqual({ success: true });
  expect(mockWarn).toHaveBeenCalledWith('Failed to setup notifications', { error });
  expect(mockLoadMutedState).toHaveBeenCalledTimes(1);
});

it('preserves the font gate and permits subsequent initializations', async () => {
  await expect(AppInitializer.initializeApp(false)).resolves.toMatchObject({ success: false });
  expect(mockSetupNotifications).not.toHaveBeenCalled();
  expect(mockLoadMutedState).not.toHaveBeenCalled();
  await expect(AppInitializer.initializeApp(true)).resolves.toEqual({ success: true });
  await expect(AppInitializer.initializeApp(true)).resolves.toEqual({ success: true });
  expect(mockSetupNotifications).toHaveBeenCalledTimes(2);
  expect(mockLoadMutedState).toHaveBeenCalledTimes(2);
});
