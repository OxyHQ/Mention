/**
 * A browser that blocks site storage (the property itself throws) keeps
 * Mention working and isolated, in memory: the viewer-owner marker of the
 * persisted caches (`db/cacheLifecycle.ts`) falls back to the process, and the
 * web keeps no durable copy of posts, feeds or people (`data/persister.ts`), so
 * nothing of one account is restored for another.
 */
import { QueryClient } from '@tanstack/react-query';

jest.mock('@/db/database', () => ({
  getDb: () => null,
  resetDb: () => undefined,
  isDbAvailable: () => false,
}));

import { claimViewerCache, readPersistedViewerOwner } from '@/db/cacheLifecycle';
import { activateAccount, resetAccountScopeForTests } from '@/lib/accountScope';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  resetAccountScopeForTests();
});

it('claims the cache per viewer in memory when the browser blocks storage', () => {
  expect(readPersistedViewerOwner()).toBeNull();
  expect(claimViewerCache('A')).toEqual({ reset: true, previousViewerId: null, trusted: true });
  expect(claimViewerCache('A')).toMatchObject({ reset: false, trusted: true });
  // B never inherits what A's session held: the memory marker says it was A's.
  expect(claimViewerCache('B')).toEqual({ reset: true, previousViewerId: 'A', trusted: true });
});

it('keeps posts, feeds and people in memory only on the web', () => {
  // The web module (`persister.ts`), whatever platform Jest resolves for.
  const { accountPersister } =
    jest.requireActual<typeof import('@/data/persister')>('@/data/persister.ts');
  expect(accountPersister('A')).toBeUndefined();
  // The in-memory scope needs no storage at all.
  expect(() => activateAccount('A', new QueryClient())).not.toThrow();
});
