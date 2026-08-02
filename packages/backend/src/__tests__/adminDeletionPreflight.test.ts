import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';
import {
  DeletionPreflightError,
  assertNoDeletionBlockers,
  assertPostsSafeToDelete,
  collectReferenceBlockers,
} from '../scripts/lib/adminDeletionPreflight';
import { assertAdminRunComplete } from '../scripts/lib/adminScriptLifecycle';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { contentLabels, labelers } from '../db/schema/moderation';
import { feedInteractions } from '../db/schema/feeds';
import { likes } from '../db/schema/engagement';
import { notifications } from '../db/schema/discovery';
import { deletePostRecord, insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';

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

  it('keeps every direct administrative post delete behind the shared preflight', () => {
    for (const script of [
      'backfillFederatedPostAuthors.ts',
      'reingestEmptyFederatedPosts.ts',
    ]) {
      const source = readFileSync(
        path.resolve(__dirname, `../scripts/${script}`),
        'utf8',
      );
      // BOTH assertions are load-bearing, and the second alone is not enough:
      // `indexOf` returns -1 for an absent needle, so an ordering check against a
      // preflight that had been deleted would pass vacuously. The `toContain`
      // pair is what stops that.
      expect(source).toContain('assertPostsSafeToDelete(');
      expect(source).toContain('deletePostRecord(');
      expect(source.indexOf('assertPostsSafeToDelete(')).toBeLessThan(
        source.indexOf('deletePostRecord('),
      );
    }
  });

  it('reads no Mongoose model — every probe must hit the store that is written', () => {
    // The defect this guards is invisible at runtime: a probe against a
    // collection nothing writes returns "no reference" and the preflight clears
    // the deletion. Row assertions below cover four probes; this covers all
    // thirty-odd at once, including any added later.
    const source = readFileSync(
      path.resolve(__dirname, '../scripts/lib/adminDeletionPreflight.ts'),
      'utf8',
    );
    const modelImports = [...source.matchAll(/from '\.\.\/\.\.\/models\/([\w.]+)'/g)].map(
      (match) => match[1],
    );
    // `Report.model` survives for the `ReportedType` ENUM only — a value, not a
    // query. Asserting the exact set rather than a count keeps a swap visible.
    expect(modelImports).toEqual(['Report.model']);
    expect(source).not.toMatch(/\b[A-Z]\w*\.exists\(/);
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

/**
 * The post-reference probes, against REAL ROWS.
 *
 * The cases above exercise the probe RUNNER with `vi.fn()` doubles, which is the
 * right shape for "does it collect every blocker in one pass". It says nothing
 * about the probes themselves, and those are now correlated SQL — the exact
 * construct that renders a bare column and silently returns zero rows.
 *
 * The consequence is one-directional and severe: a probe that matches nothing
 * answers "no blocker", so the preflight clears EVERY deletion. A gate that
 * fails open is worse than no gate, because the operator believes it ran. Only a
 * row assertion can tell a working probe from a broken one.
 */
describe('assertPostsSafeToDelete — against real rows', () => {
  const OWNER = 'oxy-preflight-owner';
  const OTHER = 'oxy-preflight-other';
  const created: string[] = [];

  async function seed(overrides: Partial<PostRecordInput> = {}): Promise<string> {
    const owner = (overrides.oxyUserId ?? OWNER) as string;
    const record = await insertPostRecord({
      oxyUserId: owner,
      authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'referenced', tag: 'en' }] },
      ...overrides,
    });
    created.push(record.id);
    return record.id;
  }

  beforeAll(async () => {
    await connectPostgres();
  });

  afterEach(async () => {
    for (const id of created.splice(0).reverse()) {
      await deletePostRecord(id, undefined);
    }
  });

  afterAll(async () => {
    await closePostgres();
  });

  it('clears a post nothing references', async () => {
    const orphan = await seed();

    await expect(assertPostsSafeToDelete('preflight-test', [{ id: orphan }])).resolves
      .toBeUndefined();
  });

  it('BLOCKS a post another post replies to, quotes, boosts, or threads through', async () => {
    for (const link of ['parentPostId', 'quoteOf', 'boostOf', 'threadId'] as const) {
      const target = await seed();
      await seed({
        oxyUserId: OTHER,
        [link]: target,
        ...(link === 'boostOf' ? { type: PostType.BOOST, content: {} } : {}),
      });

      await expect(
        assertPostsSafeToDelete('preflight-test', [{ id: target }]),
      ).rejects.toThrow(DeletionPreflightError);
      // The message has to NAME the reference, or an operator cannot act on it.
      await expect(
        assertPostsSafeToDelete('preflight-test', [{ id: target }]),
      ).rejects.toThrow(/posts\.boost_of\/quote_of\/parent_post_id\/thread_id/);

      for (const id of created.splice(0).reverse()) {
        await deletePostRecord(id, undefined);
      }
    }
  });

  /**
   * One case per PREDICATE SHAPE across the eleven non-post probes, because the
   * shapes are what fail differently: a discriminator column that has to match
   * (`entity_type`, `target_type`), a probe keyed on the URI set rather than the
   * id set, and the engagement pair the caller can opt out of.
   *
   * A test that only exercised the posts self-reference probe would have passed
   * unchanged while every other probe still read a dead Mongo collection — which
   * is exactly the state this file was found in.
   *
   * One case PER PROBE rather than one case covering four, so a failure names
   * the probe that broke instead of pointing at a line inside a compound test.
   */
  const referenceCases: {
    probe: string;
    reference: (postId: string) => Promise<{ uris?: string[] }>;
    cleanup: (postId: string) => Promise<void>;
  }[] = [
    {
      probe: 'notifications.entity_id',
      reference: async (postId) => {
        await getDb().insert(notifications).values({
          recipientId: OWNER,
          actorId: OTHER,
          type: 'like',
          entityType: 'post',
          entityId: postId,
        });
        return {};
      },
      cleanup: async (postId) => {
        await getDb().delete(notifications).where(eq(notifications.entityId, postId));
      },
    },
    {
      probe: 'content_labels.target_id',
      reference: async (postId) => {
        const db = getDb();
        const [labeler] = await db
          .insert(labelers)
          .values({ name: `preflight-labeler-${postId}`, creatorId: OWNER })
          .returning({ id: labelers.id });
        await db.insert(contentLabels).values({
          labelerId: labeler.id,
          targetType: 'post',
          targetId: postId,
          labelSlug: 'spam',
          createdBy: OWNER,
        });
        return {};
      },
      cleanup: async (postId) => {
        // CASCADEs the label with it.
        await getDb().delete(labelers).where(eq(labelers.name, `preflight-labeler-${postId}`));
      },
    },
    {
      // Keyed on `postKeys`, so a URI the post is known by blocks it even though
      // that string is not the post id — the one probe an id-only fixture misses.
      probe: 'feed_interactions.post_uri',
      reference: async (postId) => {
        await getDb().insert(feedInteractions).values({
          userId: OTHER,
          feedDescriptor: 'for_you',
          postUri: `mtn://preflight/${postId}`,
          event: 'impression',
        });
        return { uris: [`mtn://preflight/${postId}`] };
      },
      cleanup: async (postId) => {
        await getDb()
          .delete(feedInteractions)
          .where(eq(feedInteractions.postUri, `mtn://preflight/${postId}`));
      },
    },
    {
      // `likes` CASCADEs from `posts`, so this probe is what stands between a
      // delete and the SILENT destruction of the engagement row. Under Mongo an
      // unblocked delete left a visible orphan instead.
      probe: 'likes.post_id',
      reference: async (postId) => {
        await getDb().insert(likes).values({ userId: OTHER, postId });
        return {};
      },
      // Nothing to do — the post delete cascades it.
      cleanup: async () => {},
    },
  ];

  it.each(referenceCases)('BLOCKS a delete referenced by $probe', async (testCase) => {
    const target = await seed();
    const { uris } = await testCase.reference(target);

    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: target, uris }]),
    ).rejects.toThrow(new RegExp(testCase.probe.replace('.', '\\.')));

    await testCase.cleanup(target);
  });

  it('lets the caller opt out of the engagement probes, and ONLY those', async () => {
    // `cascadeEngagement` exists for the gone-actor purge, which deletes the
    // Like and Bookmark rows in its own awaited cascade. It must not become a
    // blanket override: a post another post replies to stays blocked.
    const liked = await seed();
    await getDb().insert(likes).values({ userId: OTHER, postId: liked });

    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: liked }], { cascadeEngagement: true }),
    ).resolves.toBeUndefined();

    const replied = await seed();
    await seed({ oxyUserId: OTHER, parentPostId: replied });
    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: replied }], { cascadeEngagement: true }),
    ).rejects.toThrow(/posts\.boost_of/);
  });

  it('does not block on a reference from a post being deleted in the SAME batch', async () => {
    // A thread deleted whole references itself. Counting that as a blocker would
    // make a legitimate multi-post delete impossible, so the probe excludes the
    // targets — which is what the `NOT IN` arm is for, and what an over-eager
    // "any reference at all" predicate would get wrong in the opposite direction.
    const root = await seed();
    const reply = await seed({ parentPostId: root });

    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: root }, { id: reply }]),
    ).resolves.toBeUndefined();
  });
});
