import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DeletionPreflightError,
  assertNoDeletionBlockers,
  collectReferenceBlockers,
} from '../scripts/lib/adminDeletionPreflight';
import { assertAdminRunComplete } from '../scripts/lib/adminScriptLifecycle';

describe('administrative deletion preflight', () => {
  it('reports every matched reference in one pass', async () => {
    const probes = [
      { name: 'safe', hasReference: vi.fn(async () => false) },
      { name: 'posts.parentPostId', hasReference: vi.fn(async () => true) },
      { name: 'bookmarks.postId', hasReference: vi.fn(async () => true) },
    ];

    await expect(collectReferenceBlockers(probes)).resolves.toEqual([
      'posts.parentPostId',
      'bookmarks.postId',
    ]);
    expect(probes.every((probe) => probe.hasReference.mock.calls.length === 1)).toBe(true);
  });

  it('fails closed when a reference probe cannot prove absence', async () => {
    await expect(
      collectReferenceBlockers([
        {
          name: 'unavailable collection',
          hasReference: async () => {
            throw new Error('Mongo unavailable');
          },
        },
      ]),
    ).rejects.toThrow('Mongo unavailable');
  });

  it('throws a typed error that identifies every blocker', () => {
    expect(() =>
      assertNoDeletionBlockers('purge-test', ['Post.parentPostId', 'Bookmark.userId']),
    ).toThrow(DeletionPreflightError);
    expect(() =>
      assertNoDeletionBlockers('purge-test', ['Post.parentPostId', 'Bookmark.userId']),
    ).toThrow('Post.parentPostId, Bookmark.userId');
  });

  it('turns unresolved/partial counters into a failed administrative run', () => {
    expect(() =>
      assertAdminRunComplete('repair-test', { failed: 2, skipped: 1, partial: 0 }),
    ).toThrow('[repair-test] run incomplete: failed=2, skipped=1');
    expect(() =>
      assertAdminRunComplete('repair-test', { failed: 0, skipped: 0 }),
    ).not.toThrow();
  });

  it('keeps every direct administrative Post delete behind the shared preflight', () => {
    for (const script of [
      'backfillFederatedPostAuthors.ts',
      'reingestEmptyFederatedPosts.ts',
    ]) {
      const source = readFileSync(
        path.resolve(__dirname, `../scripts/${script}`),
        'utf8',
      );
      expect(source).toContain('assertPostsSafeToDelete(');
      expect(source.indexOf('assertPostsSafeToDelete(')).toBeLessThan(
        source.indexOf('Post.deleteOne('),
      );
    }
  });

  it('uses durable delivery acknowledgements and explicit resource closure', () => {
    for (const script of [
      'resendPendingOutboundFollows.ts',
      'redeliverUserPosts.ts',
      'backfillFederatedPostHtml.ts',
    ]) {
      const source = readFileSync(
        path.resolve(__dirname, `../scripts/${script}`),
        'utf8',
      );
      expect(source).not.toContain('SETTLE_MS');
      expect(source).toContain('closeAdminScriptResources');
      expect(source).toContain('assertAdminRunComplete');
    }
  });
});
