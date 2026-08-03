import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DeletionPreflightError,
  POST_REFERENCE_PROBE_NAMES,
  actorReferenceProbes,
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

  it('probes every user-referencing field a cascade would otherwise strand', () => {
    const names = actorReferenceProbes(
      { oxyUserId: 'actor-1', actorUri: 'https://remote.example/users/a' },
      // The gone-actor bucket: probes its own cascade does NOT remove. Each of
      // these names a row that survives that cascade holding the actor's id, so
      // this is the bucket they have to be in to be checked at all.
      true,
    ).map((probe) => probe.name);

    // Vacuity floor: a broken traversal returning nothing would satisfy every
    // `toContain` below by satisfying none of them.
    expect(names.length).toBeGreaterThanOrEqual(25);
    expect(new Set(names).size).toBe(names.length);

    for (const name of [
      // The writer behind a channel post — deliberately outside `authorship[]`
      // to protect their anonymity, which put it outside every matcher too.
      'Post.writtenByOxyUserId',
      'Lane.ownerId',
      'LaneMute.viewer/laneOwner',
      'McpConnection.oxyUserId/activeOxyUserId',
      'ModerationEnforcement.subjectId',
      'UserSettings privacy references from another viewer',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('probes author subscriptions by their real fields, and nothing probes them by post', () => {
    const names = actorReferenceProbes(
      { oxyUserId: 'actor-1', actorUri: 'https://remote.example/users/a' },
      true,
    ).map((probe) => probe.name);
    // `PostSubscription` is `{ subscriberId, authorId }` — a subscription to an
    // AUTHOR, with no post reference at all. It belongs to the ACTOR probes and
    // must never appear among the post ones.
    expect(names).toContain('PostSubscription.subscriberId/authorId');
    expect(POST_REFERENCE_PROBE_NAMES).not.toContain('PostSubscription');

    // The regression this guards: a cascade step filtering that collection by a
    // post id. It matched nothing and reported its guaranteed zero as work
    // done, and under `strictQuery` the unknown path is STRIPPED — turning the
    // same call into `deleteMany({})`. Measured on mongod 8.0.28 with this
    // repo's mongoose: 0 deleted as shipped, 3 of 3 deleted with the flag on.
    for (const file of [
      '../controllers/posts.controller.ts',
      '../scripts/purgeBlockedDomainContent.ts',
      '../services/PostDeletionCascade.ts',
    ]) {
      const source = readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(source).not.toMatch(/PostSubscription\s*[,)]?[\s\S]{0,80}postId/);
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
