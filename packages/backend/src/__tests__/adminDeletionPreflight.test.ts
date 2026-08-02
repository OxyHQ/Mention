import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type * as TypeScript from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';
import {
  DeletionPreflightError,
  POST_REFERENCE_PROBE_NAMES,
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

const ts = createRequire(path.join(__dirname, 'adminDeletionPreflight.test.ts'))(
  'typescript',
) as typeof TypeScript;
const PREFLIGHT_SOURCE = path.resolve(__dirname, '../scripts/lib/adminDeletionPreflight.ts');

/**
 * The complete set of functions a probe may reach to answer "does a row exist",
 * and every one of them reads Postgres.
 *
 * A probe that reaches NONE of these answers its question without asking the
 * store — which is the Mongo-era defect exactly: a probe against a collection
 * nothing writes returned "no reference" for every input, so the preflight
 * cleared every deletion while reading as a gate that ran.
 */
const POSTGRES_READ_HELPERS = new Set([
  'anyRow',
  'postExists',
  'existsFollow',
  'hasActorKeyPair',
  'hasDeliveriesFromSender',
  'hasDeliveriesReferencingObjects',
]);

/**
 * Known subject, known value. Each of these probes lives in the ACTOR builder,
 * which — unlike the post probes below — has no row test standing behind it, and
 * which is where the split-store defect was found (3 checks reading Postgres, 36
 * reading a store that had moved). A count floor cannot tell a working parse
 * from a broken one; naming a probe and the exact helper it must reach can.
 */
const ACTOR_PROBE_READS: Readonly<Record<string, string>> = {
  'actor_key_pairs.oxy_user_id': 'hasActorKeyPair',
  'federated_follows.remote_actor_uri': 'existsFollow',
  'federation_delivery_queue.sender_oxy_user_id': 'hasDeliveriesFromSender',
  'posts owner/authorship/mentions': 'postExists',
  'user_settings.oxy_user_id': 'anyRow',
  'mention_signed_records.oxy_user_id': 'anyRow',
};

interface ScannedProbe {
  /** The blocker name an operator would see printed. */
  readonly name: string;
  /** The enclosing top-level function, so a failure says which builder broke. */
  readonly owner: string;
  readonly line: number;
  /** Which members of {@link POSTGRES_READ_HELPERS} the probe body reaches. */
  readonly reads: readonly string[];
}

/**
 * Every reference probe the module declares, read off the AST rather than by
 * grep — so a probe mentioned in a docblock is not a hit, and a probe whose body
 * spans twenty lines of drizzle is still one probe.
 *
 * The two builders declare probes in different SHAPES and both must be covered:
 * the actor probes are `{ name, hasReference }` object literals, and the post
 * probes are a `Record<PostReferenceProbeName, …>` keyed by string literal.
 */
function scanPreflightProbes(): ScannedProbe[] {
  const source = readFileSync(PREFLIGHT_SOURCE, 'utf8');
  const sourceFile = ts.createSourceFile(
    PREFLIGHT_SOURCE,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const probes: ScannedProbe[] = [];

  const readsOf = (body: TypeScript.Node): string[] => {
    const found = new Set<string>();
    const collect = (child: TypeScript.Node): void => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        const callee = child.expression.text;
        if (POSTGRES_READ_HELPERS.has(callee)) found.add(callee);
      }
      ts.forEachChild(child, collect);
    };
    collect(body);
    return [...found];
  };
  const lineOf = (node: TypeScript.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const visit = (node: TypeScript.Node, owner: string): void => {
    const scope = ts.isFunctionDeclaration(node) && node.name ? node.name.text : owner;

    if (ts.isObjectLiteralExpression(node)) {
      // Shape 1 — `{ name: '…', hasReference: () => … }`.
      let name: string | undefined;
      let hasReference: TypeScript.Expression | undefined;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
        if (property.name.text === 'name' && ts.isStringLiteral(property.initializer)) {
          name = property.initializer.text;
        }
        if (property.name.text === 'hasReference') hasReference = property.initializer;
      }
      if (name !== undefined && hasReference !== undefined) {
        probes.push({ name, owner: scope, line: lineOf(node), reads: readsOf(hasReference) });
      }

      // Shape 2 — the post builder's string-literal-keyed record. Anchored on
      // the builder's NAME so an unrelated string-keyed object elsewhere in the
      // module can never be mistaken for a probe table.
      if (scope === 'buildPostReferenceProbes') {
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
          probes.push({
            name: property.name.text,
            owner: scope,
            line: lineOf(property),
            reads: readsOf(property.initializer),
          });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(sourceFile, '<module>');

  return probes;
}

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
    const source = readFileSync(PREFLIGHT_SOURCE, 'utf8');
    const modelImports = [...source.matchAll(/from '\.\.\/\.\.\/models\/([\w.]+)'/g)].map(
      (match) => match[1],
    );
    // `Report.model` survives for the `ReportedType` ENUM only — a value, not a
    // query. Asserting the exact set rather than a count keeps a swap visible.
    //
    // THE IMPORT ASSERTION IS THE LOAD-BEARING ONE OF THE TWO. It is an exact
    // equality over a walked set, so it fails whether the list grows OR shrinks.
    // The `.exists(` line beneath it is a NEGATIVE naming a Mongo-era API that
    // no longer occurs anywhere in this file — it matches zero today, which
    // means it can no longer distinguish a violation from a clean file and is
    // kept only as a cheap tripwire for a reintroduced Mongoose read. If one of
    // these two ever has to go, it is that one.
    expect(modelImports).toEqual(['Report.model']);
    expect(source).not.toMatch(/\b[A-Z]\w*\.exists\(/);
  });

  /**
   * The floor under the check above, and the only thing standing behind
   * `assertActorSafeToDelete`.
   *
   * "No Mongoose model is imported" is a NEGATIVE that names the old API: once
   * the models were deleted it matched nothing, and a pattern that matches
   * nothing passes for every possible violation, silently, forever. It cannot
   * see the failure that actually matters either — a probe that answers its
   * question WITHOUT asking the store. The exact defect found this month was 3
   * of 39 actor probes reading Postgres while the rest read a store that had
   * moved, and none of the assertions above could have detected it.
   *
   * So this walks the AST and demands that every probe REACH a Postgres read.
   * The floors are semantic rather than counted, because a count is exactly what
   * a broken parse satisfies: the post builder's key set must equal the exported
   * name list (imported here as a value, so a rename is a compile error), and
   * named actor probes must resolve to the named helper.
   */
  it('resolves EVERY declared probe to a Postgres read', () => {
    const probes = scanPreflightProbes();
    const describeProbe = (probe: ScannedProbe): string =>
      `${probe.owner}: ${probe.name} (src/scripts/lib/adminDeletionPreflight.ts:${probe.line})`;

    // FLOOR — the post builder. One probe per exported name, no more and no
    // fewer: a dropped probe is a reference nothing checks, and a probe the list
    // does not name cannot be acknowledged by a caller.
    expect(
      probes
        .filter((probe) => probe.owner === 'buildPostReferenceProbes')
        .map((probe) => probe.name)
        .sort(),
    ).toEqual([...POST_REFERENCE_PROBE_NAMES].sort());

    // FLOOR — the actor builders. Known subject, known value: each named probe
    // must be found AND must reach exactly the helper named for it.
    expect(
      Object.keys(ACTOR_PROBE_READS).map((name) => {
        const matching = probes.filter((probe) => probe.name === name);
        return `${name} -> ${
          matching.length === 0
            ? 'NOT FOUND'
            : [...new Set(matching.flatMap((probe) => probe.reads))].sort().join('+')
        }`;
      }),
    ).toEqual(Object.entries(ACTOR_PROBE_READS).map(([name, helper]) => `${name} -> ${helper}`));

    // THE INVARIANT. A probe reaching no Postgres read is a gate that fails
    // open, and an operator who believes it ran.
    expect(probes.filter((probe) => probe.reads.length === 0).map(describeProbe)).toEqual([]);
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

  it('lets the caller acknowledge only the probes it NAMES', async () => {
    // `removedByCascade` exists for the gone-actor purge, which deletes the
    // `likes` and `bookmarks` rows in its own awaited cascade. It must not
    // become a blanket override: a post another post replies to stays blocked,
    // and so does a probe the caller did not name.
    const liked = await seed();
    await getDb().insert(likes).values({ userId: OTHER, postId: liked });

    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: liked }], {
        removedByCascade: ['likes.post_id', 'bookmarks.post_id'],
      }),
    ).resolves.toBeUndefined();

    // The SAME liked post, with only the bookmark probe acknowledged: the like
    // is still a blocker, so the acknowledgement is per-probe rather than a
    // mode.
    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: liked }], {
        removedByCascade: ['bookmarks.post_id'],
      }),
    ).rejects.toThrow(/likes\.post_id/);

    const replied = await seed();
    await seed({ oxyUserId: OTHER, parentPostId: replied });
    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: replied }], {
        removedByCascade: ['likes.post_id', 'bookmarks.post_id'],
      }),
    ).rejects.toThrow(/posts\.boost_of/);
  });

  /**
   * The post GRAPH probe is the one no cascade may acknowledge away, and
   * `allowDanglingReplyReferences` narrows it to `boost_of` alone.
   *
   * The reply/quote/thread columns are `ON DELETE SET NULL`, so nothing DANGLES
   * in the referential sense — the reference is silently erased instead of
   * visibly broken, which is exactly why the option has to be stated rather than
   * assumed. `boost_of` is never covered: a boost has a deliberately empty body
   * and renders entirely from its original, so a dangling one is a placeholder
   * card with nothing behind it.
   */
  it('narrows the graph probe to boosts when the caller allows dangling replies', async () => {
    const replied = await seed();
    await seed({ oxyUserId: OTHER, parentPostId: replied });

    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: replied }], {
        allowDanglingReplyReferences: true,
        removedByCascade: ['likes.post_id', 'bookmarks.post_id'],
      }),
    ).resolves.toBeUndefined();

    const boosted = await seed();
    await seed({ oxyUserId: OTHER, boostOf: boosted });
    await expect(
      assertPostsSafeToDelete('preflight-test', [{ id: boosted }], {
        allowDanglingReplyReferences: true,
        removedByCascade: ['likes.post_id', 'bookmarks.post_id'],
      }),
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
