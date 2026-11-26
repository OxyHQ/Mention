import path from 'node:path';

/**
 * A returning signed-in session paints from the device's cache before any network, even when this
 * app once recorded a sign-out (the fix in `@oxy.so/services` 14.24.2). The intent
 * outlives the device signing back in through another app, and while the cache refused, every cold
 * start waited for the registry classification and the mint (Pixel 8a: about 3 s, 6 to 7 s on a
 * slow connection). The installed cache is the gate: an older Services fails it.
 */
type CachedBootModule = {
  createCachedBootStore: (
    storage: {
      getItem(key: string): Promise<string | null>;
      setItem(key: string, value: string): Promise<void>;
      removeItem(key: string): Promise<void>;
    },
    prefix: string,
  ) => {
    saveLane(clientId: string, lane: 'device' | 'oauth'): Promise<void>;
    saveAccount(user: { id: string }): Promise<void>;
    clearAccount(): Promise<void>;
    readSession(clientId: string, authStore: unknown): Promise<{ user: { id: string } } | null>;
  };
};

// The cache reads only the token lead from core's session entry; its CommonJS build here.
jest.mock('@oxy.so/core/session', () =>
  jest.requireActual(
    require('node:path').join(
      require('node:path').dirname(require.resolve('@oxy.so/core/package.json')),
      'dist/cjs/session/index.js',
    ),
  ),
);

const { createCachedBootStore }: CachedBootModule = require(
  path.join(
    path.dirname(require.resolve('@oxy.so/services/package.json')),
    'lib/commonjs/ui/session/cachedBoot.js',
  ),
);

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
}

const authStore = {
  load: async () => ({ sessionId: 's1', userId: 'u1', deviceId: 'd1', deviceSecret: 'secret' }),
  save: async () => true,
  clear: async () => undefined,
  isAutomaticIdentitySignInSuppressed: async () => true,
};

describe('the cold boot paints a returning session from the cache', () => {
  it('while an old sign-out intent is still recorded', async () => {
    const cache = createCachedBootStore(memoryStorage(), 'mention');
    await cache.saveLane('client', 'device');
    await cache.saveAccount({ id: 'u1' });
    await expect(cache.readSession('client', authStore)).resolves.toMatchObject({
      user: { id: 'u1' },
    });
  });

  it('but not after a sign-out deleted the cached profile', async () => {
    const cache = createCachedBootStore(memoryStorage(), 'mention');
    await cache.saveLane('client', 'device');
    await cache.saveAccount({ id: 'u1' });
    await cache.clearAccount();
    await expect(cache.readSession('client', authStore)).resolves.toBeNull();
  });
});
