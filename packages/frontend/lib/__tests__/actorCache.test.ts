import fs from 'node:fs';
import path from 'node:path';

import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { queryClient as mockQueryClient } from '@/lib/queryClient';
import { getKnownIdentity, resetIdentityUpdates } from '@/stores/identityUpdates';
import { cacheActor, cacheActors, noteIdentityChanged } from '../actorCache';

/**
 * The one door into the SDK's user cache.
 *
 * Six surfaces prime that cache with users they fetched, and the SDK merge they
 * all reach overrides a real value with a real value — so ANY of them can put a
 * server copy that predates a profile edit back over that edit. Guarding them
 * individually would be six guards; they share a door instead, and these pin
 * both that the door corrects what passes through it AND that nothing walks
 * around it.
 *
 * The MERGE itself is the SDK's own contract (verified in `@oxyhq/services`).
 * What Mention owns, and what these assert, is the wiring: what is handed to it,
 * keyed to which viewer, with which fields.
 */

const mockUpsertCachedUser = jest.fn();
const mockUpsertCachedUsers = jest.fn();
jest.mock('@oxyhq/services', () => ({
  upsertCachedUser: (...args: unknown[]) => mockUpsertCachedUser(...args),
  upsertCachedUsers: (...args: unknown[]) => mockUpsertCachedUsers(...args),
}));

jest.mock('@/lib/queryClient', () => ({
  queryClient: { __sentinel: 'queryClient', invalidateQueries: jest.fn() },
}));

const invalidateQueries = mockQueryClient.invalidateQueries as unknown as jest.Mock;

/** The users handed to the batch upsert on its last call. */
function lastBatch(): unknown[] {
  expect(mockUpsertCachedUsers).toHaveBeenCalled();
  const calls = mockUpsertCachedUsers.mock.calls;
  const [client, users] = calls[calls.length - 1];
  expect(client).toBe(mockQueryClient);
  return users as unknown[];
}

beforeEach(() => {
  mockUpsertCachedUser.mockReset();
  mockUpsertCachedUsers.mockReset();
  invalidateQueries.mockReset();
});

afterEach(() => {
  resetIdentityUpdates();
});

describe('noteIdentityChanged', () => {
  it('hands the edit to the SDK merge-upsert, scoped to the acting viewer', () => {
    noteIdentityChanged(
      {
        id: 'channel-1',
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
      },
      'viewer-1',
    );

    expect(mockUpsertCachedUser).toHaveBeenCalledTimes(1);
    expect(mockUpsertCachedUser).toHaveBeenCalledWith(
      mockQueryClient,
      {
        id: 'channel-1',
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
      },
      'viewer-1',
    );
    expect(getKnownIdentity('channel-1')).toEqual({
      id: 'channel-1',
      username: 'daily',
      name: { displayName: 'Daily Digest' },
      avatar: 'avatar-after',
    });
  });

  it('invalidates the operated-accounts list and nothing else in its family', () => {
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' }, 'viewer-1');

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    const { predicate } = invalidateQueries.mock.calls[0][0];
    expect(predicate({ queryKey: viewerQueryKeys.operatedAccounts('viewer-1') })).toBe(true);
    expect(
      predicate({ queryKey: viewerQueryKeys.channelAccountSettings('viewer-1', 'channel-1') }),
    ).toBe(false);
    expect(predicate({ queryKey: viewerQueryKeys.notifications('viewer-1') })).toBe(false);
  });

  it('does not reconcile the edit against itself', () => {
    // Routed through `cacheActor`, the write would arrive as an actor that
    // "agrees" with what it just recorded and retire the entry on the spot —
    // leaving nothing to correct the very next feed response with.
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' });

    expect(getKnownIdentity('channel-1')).toEqual({ id: 'channel-1', avatar: 'avatar-after' });
  });

  it('touches no cache for a write with no id', () => {
    noteIdentityChanged({ id: '', avatar: 'avatar-after' });

    expect(mockUpsertCachedUser).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('cacheActors / cacheActor', () => {
  it('corrects an actor a profile edit has since superseded', () => {
    noteIdentityChanged({ id: 'channel-1', username: 'daily', avatar: 'avatar-after' });

    cacheActors([{ id: 'channel-1', username: 'daily', avatar: 'avatar-before' }]);

    expect(lastBatch()).toEqual([
      { id: 'channel-1', username: 'daily', avatar: 'avatar-after' },
    ]);
  });

  it('corrects a single actor the same way', () => {
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' });

    cacheActor({ id: 'channel-1', username: 'daily', avatar: 'avatar-before' });

    expect(mockUpsertCachedUser).toHaveBeenLastCalledWith(mockQueryClient, {
      id: 'channel-1',
      username: 'daily',
      avatar: 'avatar-after',
    });
  });

  it('leaves every other actor in the batch untouched', () => {
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' });

    cacheActors([
      { id: 'channel-1', username: 'daily', avatar: 'avatar-before' },
      { id: 'someone-else', username: 'else', avatar: 'their-avatar' },
    ]);

    expect(lastBatch()).toEqual([
      { id: 'channel-1', username: 'daily', avatar: 'avatar-after' },
      { id: 'someone-else', username: 'else', avatar: 'their-avatar' },
    ]);
  });

  it('retires the correction once a surface carries the edit, and stops correcting', () => {
    noteIdentityChanged({ id: 'channel-1', username: 'daily', avatar: 'avatar-after' });

    cacheActors([{ id: 'channel-1', username: 'daily', avatar: 'avatar-after' }]);
    expect(getKnownIdentity('channel-1')).toBeUndefined();

    // So a value that differs AFTERWARDS is a genuine change made somewhere else
    // — another device, accounts.oxy.so — and must reach the cache unedited.
    cacheActors([{ id: 'channel-1', username: 'daily', avatar: 'avatar-elsewhere' }]);
    expect(lastBatch()).toEqual([
      { id: 'channel-1', username: 'daily', avatar: 'avatar-elsewhere' },
    ]);
  });

  it('retires from a SINGLE-actor surface too', () => {
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' });

    cacheActor({ id: 'channel-1', avatar: 'avatar-after' });
    expect(getKnownIdentity('channel-1')).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
  ])('does not touch the cache for %s', (_label, input) => {
    cacheActors(input as never);
    expect(mockUpsertCachedUsers).not.toHaveBeenCalled();
  });

  it('does not touch the cache for a missing single actor', () => {
    cacheActor(null);
    expect(mockUpsertCachedUser).not.toHaveBeenCalled();
  });
});

/**
 * Nothing walks around the door.
 *
 * Six surfaces used to call the SDK upserts directly, and a seventh added later
 * would inherit the bug in silence — the correction simply would not run for it,
 * with no error and no failing test anywhere. A guard per surface is the shape
 * that quietly becomes five of six; this asserts the property that makes one
 * guard sufficient, which is that `lib/actorCache.ts` is the only importer.
 */
describe('the door is the only way in', () => {
  const FRONTEND_ROOT = path.resolve(__dirname, '../..');
  const SKIP_DIRS = new Set([
    'node_modules', '.expo', 'dist', 'android', 'ios', 'coverage', '.git',
  ]);

  /** Every `.ts`/`.tsx` under the frontend package, tests excluded. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name === '__tests__') continue;
        sourceFiles(full, out);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const files = sourceFiles(FRONTEND_ROOT);

  it('scanned a plausible number of source files', () => {
    // A traversal that silently found nothing would make the assertion below
    // pass for the wrong reason.
    expect(files.length).toBeGreaterThan(300);
  });

  it('is the only module importing the SDK user-cache upserts', () => {
    const importers = files.filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      // The IMPORT, not a mention in prose — several files name these helpers in
      // their docstrings, and a docstring cannot walk around anything.
      return /import\s*\{[^}]*\bupsertCachedUsers?\b[^}]*\}\s*from\s*['"]@oxyhq\/services['"]/.test(
        source,
      );
    });

    expect(importers.map((file) => path.relative(FRONTEND_ROOT, file))).toEqual([
      'lib/actorCache.ts',
    ]);
  });
});
