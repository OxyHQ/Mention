/**
 * Video sound on web needs a user gesture in this document.
 *
 * Browsers refuse to start media with sound before the viewer has interacted
 * with the page: `play()` rejects with `NotAllowedError`. A viewer who unmuted on
 * an earlier visit had that preference restored on a fresh page, so the first
 * autoplay on it was unmuted and refused (seen on `/@sanchezcastejon@x.com`).
 * Muted autoplay is always allowed, so the store keeps a fresh web page muted
 * until a gesture, and the viewer's own unmute (a gesture) brings sound back.
 */

type Store = typeof import('../videoMuteStore');

const mockStorage = new Map<string, unknown>();
const mockPlatform = { OS: 'web' as 'web' | 'ios' };

jest.mock('react-native', () => ({ Platform: mockPlatform }));
jest.mock('../../utils/storage', () => ({
  Storage: {
    get: async (key: string) => (mockStorage.has(key) ? mockStorage.get(key) : null),
    set: async (key: string, value: unknown) => {
      mockStorage.set(key, value);
    },
  },
}));
jest.mock('@oxy.so/core/logger', () => ({ logger: { error: jest.fn() } }));

const KEY = 'pref:global:videoMuted';
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

/** Stand in for `navigator.userActivation`, the browser's own answer. */
function setUserActivation(hasBeenActive: boolean | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: hasBeenActive === undefined ? {} : { userActivation: { hasBeenActive } },
  });
}

/** A fresh module per test: the gesture latch is module state, like a page load. */
function loadStore(): Store {
  let store!: Store;
  jest.isolateModules(() => {
    store = jest.requireActual<Store>('../videoMuteStore');
  });
  return store;
}

beforeEach(() => {
  mockStorage.clear();
  mockPlatform.OS = 'web';
  setUserActivation(false);
});

afterAll(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
});

describe('videoMuteStore on web', () => {
  it('starts a fresh page muted even when the viewer last chose sound', async () => {
    mockStorage.set(KEY, false);
    const { useVideoMuteStore } = loadStore();

    await useVideoMuteStore.getState().loadMutedState();

    expect(useVideoMuteStore.getState().isMuted).toBe(true);
    // The preference itself is kept for when the viewer asks for sound.
    expect(mockStorage.get(KEY)).toBe(false);
  });

  it('refuses an unmute with no gesture behind it, and saves nothing', async () => {
    mockStorage.set(KEY, true);
    const { useVideoMuteStore } = loadStore();
    await useVideoMuteStore.getState().loadMutedState();

    await useVideoMuteStore.getState().setMuted(false);

    expect(useVideoMuteStore.getState().isMuted).toBe(true);
    expect(mockStorage.get(KEY)).toBe(true);
  });

  it("unmutes on the viewer's own press, once the page has had a gesture", async () => {
    const { useVideoMuteStore } = loadStore();
    await useVideoMuteStore.getState().loadMutedState();
    expect(useVideoMuteStore.getState().isMuted).toBe(true);

    setUserActivation(true);
    await useVideoMuteStore.getState().toggleMuted();

    expect(useVideoMuteStore.getState().isMuted).toBe(false);
    expect(mockStorage.get(KEY)).toBe(false);
  });

  it('restores sound on a page that already had a gesture', async () => {
    mockStorage.set(KEY, false);
    setUserActivation(true);
    const { useVideoMuteStore } = loadStore();

    await useVideoMuteStore.getState().loadMutedState();

    expect(useVideoMuteStore.getState().isMuted).toBe(false);
  });

  it('muting never needs a gesture', async () => {
    setUserActivation(true);
    const { useVideoMuteStore } = loadStore();
    await useVideoMuteStore.getState().setMuted(false);
    setUserActivation(false);

    await useVideoMuteStore.getState().setMuted(true);

    expect(useVideoMuteStore.getState().isMuted).toBe(true);
  });

  it('counts a pointer gesture where the browser has no userActivation API', async () => {
    setUserActivation(undefined);
    const listeners = new Map<string, EventListener>();
    const addEventListener = jest.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    });
    const removeEventListener = jest.fn();
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { addEventListener, removeEventListener },
    });
    try {
      const { useVideoMuteStore, webMayPlayWithSound } = loadStore();
      expect(webMayPlayWithSound()).toBe(false);

      listeners.get('pointerdown')?.(new Event('pointerdown'));

      expect(webMayPlayWithSound()).toBe(true);
      await useVideoMuteStore.getState().setMuted(false);
      expect(useVideoMuteStore.getState().isMuted).toBe(false);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    }
  });
});

describe('videoMuteStore on native', () => {
  it('restores the saved preference: no browser autoplay policy applies', async () => {
    mockPlatform.OS = 'ios';
    mockStorage.set(KEY, false);
    const { useVideoMuteStore } = loadStore();

    await useVideoMuteStore.getState().loadMutedState();

    expect(useVideoMuteStore.getState().isMuted).toBe(false);
  });
});
