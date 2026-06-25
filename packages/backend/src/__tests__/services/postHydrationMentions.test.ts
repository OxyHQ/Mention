import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostActorSummary } from '@mention/shared-types';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Unit tests for the mention-placeholder replacement in {@link PostHydrationService}:
 *  - item 1: a SINGLE regex pass replaces every `[mention:<id>]` placeholder
 *    (no per-mention split/join loop), preserving the `[@displayName](handle)`
 *    output and leaving unresolved mentions as their raw placeholder, and
 *  - item 2: uncached ids are resolved through the shared `resolveUserSummaries`
 *    batch (one bulk fetch), the per-request cache is honored so an id is not
 *    re-fetched, and a fallback (unresolved) summary is left as the placeholder.
 *
 * `replaceMentionPlaceholders` is private, so it is exercised through a precise
 * structural interface (no `as any`). The shared user-summary cache and the Oxy
 * client are mocked so the REAL `resolveUserSummaries` runs against a controlled
 * bulk-fetch, letting us assert the batching + single-pass behavior.
 */

// Hoisted mock state — `vi.mock` factories run before top-level bindings, so
// every value referenced inside a factory must come from `vi.hoisted`.
const { getUserById, getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

// `server.ts` constructs a live OxyServices client at import time; stub it.
// (Paths are resolved relative to THIS test file: server.ts is at the package
// root, so it is three levels up from src/__tests__/services.)
vi.mock('../../../server', () => ({
  oxy: { getUserById },
}));

// The bulk service-token client used by resolveUserSummaries for cache misses.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds }),
}));

// Mongo models are only touched on other hydration paths; stub to empty objects.
vi.mock('../../models/Post', () => ({ Post: {} }));
vi.mock('../../models/Poll', () => ({ default: {} }));
vi.mock('../../models/Like', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));
vi.mock('../../models/UserSettings', () => ({ UserSettings: {} }));

// The Redis-backed user-summary cache: start cold (all misses), capture writes.
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

import { PostHydrationService } from '../../services/PostHydrationService';

/** Precise structural view of the private method under test (no `as any`). */
interface MentionReplacer {
  replaceMentionPlaceholders(
    text: string,
    mentions: string[],
    mentionCache: Map<string, PostActorSummary>,
  ): Promise<string>;
}

function asReplacer(service: PostHydrationService): MentionReplacer {
  return service as unknown as MentionReplacer;
}

/** A minimal Oxy user shape sufficient for `summaryFromOxyUser`. */
function makeOxyUser(id: string, username: string, displayName: string) {
  return {
    id,
    username,
    name: { displayName },
    badges: [],
    verified: false,
    isVerified: false,
  };
}

describe('PostHydrationService.replaceMentionPlaceholders', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    service = new PostHydrationService();
  });

  it('replaces every occurrence of a placeholder in a single pass', async () => {
    getUsersByIds.mockResolvedValue([makeOxyUser('u1', 'alice', 'Alice')]);

    const text = 'hi [mention:u1] and again [mention:u1]!';
    const result = await asReplacer(service).replaceMentionPlaceholders(
      text,
      ['u1'],
      new Map(),
    );

    expect(result).toBe('hi [@Alice](alice) and again [@Alice](alice)!');
    // Batched: a single bulk fetch, never the per-id getUserById fallback.
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('resolves multiple distinct mentions in one bulk fetch', async () => {
    getUsersByIds.mockResolvedValue([
      makeOxyUser('u1', 'alice', 'Alice'),
      makeOxyUser('u2', 'bob', 'Bob'),
    ]);

    const text = '[mention:u1] meet [mention:u2]';
    const result = await asReplacer(service).replaceMentionPlaceholders(
      text,
      ['u1', 'u2'],
      new Map(),
    );

    expect(result).toBe('[@Alice](alice) meet [@Bob](bob)');
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(getUsersByIds).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('does not re-fetch an id already in the per-request mention cache', async () => {
    const mentionCache = new Map<string, PostActorSummary>([
      ['u1', { id: 'u1', handle: 'alice', displayName: 'Alice', isVerified: false }],
    ]);

    const result = await asReplacer(service).replaceMentionPlaceholders(
      'hello [mention:u1]',
      ['u1'],
      mentionCache,
    );

    expect(result).toBe('hello [@Alice](alice)');
    // Already cached → no bulk fetch, no per-id fetch.
    expect(getUsersByIds).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('leaves an unresolved (fallback) mention as its raw placeholder', async () => {
    // Bulk returns nothing for u9, then the per-id fallback also fails →
    // resolveUserSummaries yields a fallback summary (handle === displayName === id).
    getUsersByIds.mockResolvedValue([]);
    getUserById.mockRejectedValue(new Error('not found'));

    const result = await asReplacer(service).replaceMentionPlaceholders(
      'who is [mention:u9]?',
      ['u9'],
      new Map(),
    );

    expect(result).toBe('who is [mention:u9]?');
  });

  it('does not replace undeclared placeholders from the shared hydration cache', async () => {
    const mentionCache = new Map<string, PostActorSummary>([
      ['attacker', { id: 'attacker', handle: 'attacker', displayName: 'Attacker', isVerified: false }],
      ['victim', { id: 'victim', handle: 'victim', displayName: 'Victim', isVerified: false }],
    ]);

    const result = await asReplacer(service).replaceMentionPlaceholders(
      'declared [mention:attacker], raw spoof [mention:victim]',
      ['attacker'],
      mentionCache,
    );

    expect(result).toBe('declared [@Attacker](attacker), raw spoof [mention:victim]');
    expect(getUsersByIds).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('leaves placeholders for ids not listed in mentions untouched', async () => {
    getUsersByIds.mockResolvedValue([makeOxyUser('u1', 'alice', 'Alice')]);

    const text = '[mention:u1] and [mention:u2]';
    const result = await asReplacer(service).replaceMentionPlaceholders(
      text,
      ['u1'], // u2 is not declared as a mention
      new Map(),
    );

    expect(result).toBe('[@Alice](alice) and [mention:u2]');
    expect(getUsersByIds).toHaveBeenCalledWith(['u1']);
  });
});
