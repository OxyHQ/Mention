/**
 * Native-module stand-ins for the feed row-cost harness (`jest.perf.config.js`).
 * Only modules with no JS implementation are replaced here; everything a row
 * renders stays real.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// expo-video's player is a native shared object. The fake keeps the surface the
// shared player registry touches, and counts creations so the harness can
// report how many players a scroll acquired.
jest.mock('expo-video', () => {
  const React = require('react');
  const created: unknown[] = [];
  const makePlayer = (source: unknown) => {
    const player = {
      source,
      playing: false,
      muted: true,
      loop: false,
      currentTime: 0,
      duration: 0,
      status: 'idle',
      play() { player.playing = true; },
      pause() { player.playing = false; },
      replace() {},
      replaceAsync: async () => {},
      release() {},
      addListener: () => ({ remove() {} }),
      removeAllListeners() {},
    };
    created.push(player);
    return player;
  };
  return {
    __created: created,
    createVideoPlayer: makePlayer,
    useVideoPlayer: (source: unknown) => React.useMemo(() => makePlayer(source), [source]),
    VideoView: (props: object) => React.createElement('VideoView', props),
    isPictureInPictureSupported: () => false,
  };
});

jest.mock('react-native-webview', () => {
  const React = require('react');
  const WebView = (props: object) => React.createElement('WebView', props);
  return { __esModule: true, WebView, default: WebView };
});

// ── Network boundary ─────────────────────────────────────────────
// Every request a row makes lands in `perfNetwork`, so the harness can report
// (and gate) per-row network side effects: translation calls above all.

jest.mock('@/utils/api', () => {
  const { recordRequest } = require('./perfNetwork');
  const record = (method: string) => async (endpoint: string) => {
    recordRequest(method, endpoint);
    return { data: {} };
  };
  const client = {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
    patch: record('PATCH'),
  };
  return {
    api: client,
    publicApi: client,
    authenticatedClient: client,
    publicClient: client,
    isUnauthorizedError: () => false,
    isNotFoundError: () => false,
    getApiOrigin: () => 'http://localhost:4110',
  };
});

jest.mock('@/lib/syraApi', () => {
  const { recordRequest } = require('./perfNetwork');
  const call = (name: string) => async () => {
    recordRequest('GET', `syra:${name}`);
    return name === 'getLivePresencePreference' ? 'active' : [];
  };
  const client = new Proxy({}, {
    get: (_t, method) => async (endpoint: string) => {
      recordRequest(String(method).toUpperCase(), `syra:${endpoint}`);
      return { data: {} };
    },
  });
  return {
    syraLinkedClient: client,
    roomsService: new Proxy({}, { get: (_t, name) => call(`rooms.${String(name)}`) }),
    getLiveRooms: call('getLiveRooms'),
    getLiveUsers: call('getLiveUsers'),
    getLivePresencePreference: call('getLivePresencePreference'),
    updateLivePresencePreference: call('updateLivePresencePreference'),
  };
});

jest.mock('@/lib/oxyServices', () => {
  const deep: unknown = new Proxy(function () {}, {
    get: (_t, name) => (name === 'then' ? undefined : deep),
    apply: () => deep,
  });
  return { oxyServices: deep };
});

// The Oxy SDK's React surface needs a signed-in OxyProvider; the harness renders
// a signed-out viewer, which is what a first feed paint is.
jest.mock('@oxy.so/services', () => {
  const noop = () => undefined;
  const oxyServices: unknown = new Proxy(function () {}, {
    get: (_t, name) => (name === 'then' ? undefined : oxyServices),
    apply: () => oxyServices,
  });
  const auth = {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    oxyServices,
    showBottomSheet: noop,
    activeSessionId: null,
    sessions: [],
  };
  return new Proxy({}, {
    get: (_t, name) => {
      if (name === '__esModule') return true;
      if (name === 'useAuth' || name === 'useOxy') return () => auth;
      if (name === 'queryKeys') return new Proxy({}, { get: (_q, key) => (...args: unknown[]) => [key, ...args] });
      if (typeof name === 'string' && /^use[A-Z]/.test(name)) return () => ({ data: undefined, isLoading: false });
      if (typeof name === 'string' && /^[A-Z]/.test(name)) return () => null;
      return noop;
    },
  });
});
jest.mock('@oxy.so/services/ui/client', () => jest.requireMock('@oxy.so/services'));

jest.mock('expo-router', () => {
  const router = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false, navigate: jest.fn() };
  return {
    router,
    useRouter: () => router,
    usePathname: () => '/',
    useSegments: () => [],
    useLocalSearchParams: () => ({}),
    useFocusEffect: () => undefined,
    useIsFocused: () => true,
    useNavigation: () => ({ addListener: () => () => undefined, isFocused: () => true, setOptions: () => undefined }),
    useGlobalSearchParams: () => ({}),
    Link: ({ children }: { children: unknown }) => children,
  };
});

// SQLite is native; the posts store's in-memory backend (the one web uses when
// SQLite is unavailable) serves the harness instead, with identical keyed
// reactivity — that is owned by postsStore, not by the storage.
jest.mock('../db/database', () => require('../db/database.web'));

// expo-image: a host element, and a prefetch that records what the row asked
// to preload so the harness can count media prefetches per fling.
jest.mock('expo-image', () => {
  const React = require('react');
  const { recordRequest } = require('./perfNetwork');
  const Image = (props: object) => React.createElement('ExpoImage', props);
  Image.prefetch = async (urls: string | string[]) => {
    for (const url of Array.isArray(urls) ? urls : [urls]) recordRequest('PREFETCH', url);
    return true;
  };
  Image.clearMemoryCache = async () => true;
  Image.clearDiskCache = async () => true;
  return { __esModule: true, Image, ImageBackground: Image, default: Image };
});

// Bloom's `useImagePreload` prefetches through react-native's Image, whose Jest
// mock returns undefined instead of a promise. Record those too.
{
  const { Image } = require('react-native');
  const { recordRequest } = require('./perfNetwork');
  Image.prefetch = async (url: string) => {
    recordRequest('PREFETCH', url);
    return true;
  };
}
