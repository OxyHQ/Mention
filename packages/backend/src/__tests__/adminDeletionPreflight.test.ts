import { randomUUID } from 'node:crypto';
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
  assertActorAnchorSafeToDelete,
  assertActorSafeToDelete,
  assertNoDeletionBlockers,
  assertPostsSafeToDelete,
  collectReferenceBlockers,
} from '../scripts/lib/adminDeletionPreflight';
import { assertAdminRunComplete } from '../scripts/lib/adminScriptLifecycle';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { ReportedType } from '../models/Report.model';
import { contentLabels, labelers, reports } from '../db/schema/moderation';
import { articles } from '../db/schema/articles';
import {
  actorKeyPairs,
  federatedFollows,
  federationDeliveryQueue,
} from '../db/schema/federation';
import {
  customFeeds,
  feedGenerators,
  feedInteractions,
  feedLikes,
  feedReviews,
  userFeedPreferences,
} from '../db/schema/feeds';
import { postgates, threadgates } from '../db/schema/gates';
import { accountLists, starterPacks } from '../db/schema/lists';
import {
  mentionNodeIngestWitnesses,
  mentionRepoHeads,
  mentionSignedRecords,
  mentionUserNodes,
} from '../db/schema/mtn';
import { endorsementOutbox, engagementOutbox } from '../db/schema/outbox';
import { polls } from '../db/schema/polls';
import { postRecentRepliers } from '../db/schema/postContent';
import { userBehaviors, userSettings } from '../db/schema/userProfile';
import {
  bookmarks,
  entityFollows,
  likes,
  muteWords,
  mutes,
  pokes,
  postSubscriptions,
} from '../db/schema/engagement';
import { authorFollowerSnapshots, notifications, pushTokens } from '../db/schema/discovery';
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

/**
 * `assertActorSafeToDelete` — ONE PLANTED ROW PER PROBE.
 *
 * This gate is the last thing between a purge and the irreversible deletion of a
 * federated actor that something still references, and until now nothing
 * exercised it. Every way of being wrong produces the same output as a genuinely
 * clean actor — a probe against the wrong table, a mistyped column, or one whose
 * store stopped being written all answer "no reference", and the gate says SAFE.
 * It has the history to match: three of its checks read Postgres while the rest
 * read Mongo, and after that cutover every Mongo probe would have answered "no
 * references" and the gate would have passed by default.
 *
 * So each case plants exactly one row that only ONE probe can see and asserts
 * the gate refuses with `blockers` EQUAL to that probe — not merely containing
 * it. A second probe firing means the row was not specific and the case proves
 * less than it claims.
 *
 * Each case also carries the control in the other direction, because the arm a
 * probe lives in is itself a claim: `allowGoneActorCascade` returns early, so a
 * probe past that point must block WITHOUT the acknowledgement and must go quiet
 * WITH it, while a probe before it must block either way.
 *
 * SCOPE, STATED RATHER THAN IMPLIED: a compound probe (`mutes.user_id/muted_id`,
 * `starter_packs owner/member/used_by`, …) is exercised through ONE of its
 * disjuncts. That proves the probe reaches a live table and fires; it does not
 * prove every column in the disjunction is spelled right. The exhaustiveness
 * assertion at the end covers PROBES, and says so.
 */
describe('assertActorSafeToDelete — one planted row per probe', () => {
  /** Which arm of the builder a probe lives in, which decides how it is called. */
  type ProbeArm = 'always' | 'withoutOxyUser' | 'beyondCascade' | 'anchor';

  interface ActorSubject {
    /** The actor under deletion. */
    readonly oxyUserId: string;
    readonly actorUri: string;
    /** Somebody else, for the probes that are about a reference FROM a third party. */
    readonly other: string;
    /** Posts to remove afterwards; their children cascade. */
    readonly posts: string[];
  }

  interface ActorProbeCase {
    readonly probe: string;
    readonly arm: ProbeArm;
    readonly plant: (subject: ActorSubject) => Promise<void>;
    readonly clear: (subject: ActorSubject) => Promise<void>;
  }

  let subject: ActorSubject;

  beforeAll(async () => {
    await connectPostgres();
  });

  afterAll(async () => {
    await closePostgres();
  });

  beforeEach(() => {
    // A fresh identity per case, so no case can be satisfied by another's row
    // and the `blockers` equality below means what it says.
    const suffix = randomUUID();
    subject = {
      oxyUserId: `probe-actor-${suffix}`,
      other: `probe-other-${suffix}`,
      actorUri: `https://remote.invalid/users/${suffix}`,
      posts: [],
    };
  });

  /** A post owned by somebody ELSE, so seeding one never trips an owner probe. */
  async function foreignPost(overrides: Partial<PostRecordInput> = {}): Promise<string> {
    const record = await insertPostRecord({
      oxyUserId: subject.other,
      authorship: [{ oxyUserId: subject.other, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'referenced', tag: 'en' }] },
      ...overrides,
    });
    subject.posts.push(record.id);
    return record.id;
  }

  function callGate(arm: ProbeArm, allowGoneActorCascade: boolean): Promise<void> {
    if (arm === 'anchor') {
      return assertActorAnchorSafeToDelete('probe-test', { actorUri: subject.actorUri });
    }
    const target = arm === 'withoutOxyUser'
      ? { actorUri: subject.actorUri }
      : { oxyUserId: subject.oxyUserId, actorUri: subject.actorUri };
    return assertActorSafeToDelete('probe-test', target, { allowGoneActorCascade });
  }

  async function blockersFrom(gate: Promise<void>): Promise<string[]> {
    try {
      await gate;
      return [];
    } catch (error) {
      if (error instanceof DeletionPreflightError) return [...error.blockers];
      throw error;
    }
  }

  const cases: readonly ActorProbeCase[] = [
    {
      probe: 'bookmarks.user_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(bookmarks).values({ userId: s.oxyUserId, postId: await foreignPost() });
      },
      // Cascades with the post.
      clear: async () => {},
    },
    {
      probe: 'mutes.user_id/muted_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(mutes).values({ userId: s.oxyUserId, mutedId: s.other });
      },
      clear: async (s) => {
        await getDb().delete(mutes).where(eq(mutes.userId, s.oxyUserId));
      },
    },
    {
      probe: 'mute_words.user_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(muteWords).values({ userId: s.oxyUserId, value: 'probe' });
      },
      clear: async (s) => {
        await getDb().delete(muteWords).where(eq(muteWords.userId, s.oxyUserId));
      },
    },
    {
      probe: 'feed_interactions.user_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(feedInteractions).values({
          userId: s.oxyUserId,
          feedDescriptor: 'for_you',
          postUri: `mtn://probe/${s.oxyUserId}`,
          event: 'impression',
        });
      },
      clear: async (s) => {
        await getDb().delete(feedInteractions).where(eq(feedInteractions.userId, s.oxyUserId));
      },
    },
    {
      probe: 'feed_likes.user_id',
      arm: 'always',
      plant: async (s) => {
        const [feed] = await getDb()
          .insert(customFeeds)
          .values({ ownerOxyUserId: s.other, title: 'probe feed' })
          .returning({ id: customFeeds.id });
        await getDb().insert(feedLikes).values({ userId: s.oxyUserId, feedId: feed.id });
      },
      clear: async (s) => {
        await getDb().delete(feedLikes).where(eq(feedLikes.userId, s.oxyUserId));
        await getDb().delete(customFeeds).where(eq(customFeeds.ownerOxyUserId, s.other));
      },
    },
    {
      probe: 'feed_reviews.reviewer_id',
      arm: 'always',
      plant: async (s) => {
        const [feed] = await getDb()
          .insert(customFeeds)
          .values({ ownerOxyUserId: s.other, title: 'probe feed' })
          .returning({ id: customFeeds.id });
        await getDb()
          .insert(feedReviews)
          .values({ feedId: feed.id, reviewerId: s.oxyUserId, rating: 4 });
      },
      clear: async (s) => {
        await getDb().delete(feedReviews).where(eq(feedReviews.reviewerId, s.oxyUserId));
        await getDb().delete(customFeeds).where(eq(customFeeds.ownerOxyUserId, s.other));
      },
    },
    {
      probe: 'post_subscriptions.subscriber_id/author_id',
      arm: 'always',
      plant: async (s) => {
        await getDb()
          .insert(postSubscriptions)
          .values({ subscriberId: s.oxyUserId, authorId: s.other });
      },
      clear: async (s) => {
        await getDb().delete(postSubscriptions).where(eq(postSubscriptions.subscriberId, s.oxyUserId));
      },
    },
    {
      probe: 'push_tokens.user_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(pushTokens).values({ userId: s.oxyUserId, token: `probe-${s.oxyUserId}` });
      },
      clear: async (s) => {
        await getDb().delete(pushTokens).where(eq(pushTokens.userId, s.oxyUserId));
      },
    },
    {
      probe: 'pokes.poker_id/poked_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(pokes).values({ pokerId: s.oxyUserId, pokedId: s.other });
      },
      clear: async (s) => {
        await getDb().delete(pokes).where(eq(pokes.pokerId, s.oxyUserId));
      },
    },
    {
      probe: 'reports.reporter/reported_id(user)',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(reports).values({
          reportedType: ReportedType.USER,
          reportedId: s.other,
          reporter: s.oxyUserId,
          categories: ['spam'],
        });
      },
      clear: async (s) => {
        await getDb().delete(reports).where(eq(reports.reporter, s.oxyUserId));
      },
    },
    {
      probe: 'polls.created_by/poll_votes.user_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(polls).values({
          question: 'probe?',
          createdBy: s.oxyUserId,
          endsAt: new Date(Date.now() + 60_000),
        });
      },
      clear: async (s) => {
        await getDb().delete(polls).where(eq(polls.createdBy, s.oxyUserId));
      },
    },
    {
      probe: 'articles.created_by',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(articles).values({ createdBy: s.oxyUserId });
      },
      clear: async (s) => {
        await getDb().delete(articles).where(eq(articles.createdBy, s.oxyUserId));
      },
    },
    {
      probe: 'postgates.created_by',
      arm: 'always',
      plant: async (s) => {
        const postId = await foreignPost();
        await getDb().insert(postgates).values({
          postId,
          postUri: `mtn://probe/${postId}`,
          createdBy: s.oxyUserId,
        });
      },
      clear: async (s) => {
        await getDb().delete(postgates).where(eq(postgates.createdBy, s.oxyUserId));
      },
    },
    {
      probe: 'threadgates.created_by',
      arm: 'always',
      plant: async (s) => {
        const postId = await foreignPost();
        await getDb().insert(threadgates).values({
          postId,
          postUri: `mtn://probe/${postId}`,
          createdBy: s.oxyUserId,
        });
      },
      clear: async (s) => {
        await getDb().delete(threadgates).where(eq(threadgates.createdBy, s.oxyUserId));
      },
    },
    {
      probe: 'post_recent_repliers.oxy_user_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(postRecentRepliers).values({
          postId: await foreignPost(),
          oxyUserId: s.oxyUserId,
          repliedAt: new Date(),
        });
      },
      clear: async () => {},
    },
    {
      probe: 'engagement_outbox.payload actor/owner',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(engagementOutbox).values({
          // The one table here whose `id` has no client-side default; every
          // other insert in this file legitimately omits it.
          id: randomUUID(),
          kind: 'post.like',
          revision: 1,
          payloadActorOxyUserId: s.oxyUserId,
          payloadPostId: await foreignPost(),
          payloadRelationshipId: `probe-${s.oxyUserId}`,
          expiresAt: new Date(Date.now() + 60_000),
        });
      },
      clear: async () => {},
    },
    {
      probe: 'account_lists owner/member',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(accountLists).values({ ownerOxyUserId: s.oxyUserId, title: 'probe' });
      },
      clear: async (s) => {
        await getDb().delete(accountLists).where(eq(accountLists.ownerOxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'custom_feeds owner/member',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(customFeeds).values({ ownerOxyUserId: s.oxyUserId, title: 'probe' });
      },
      clear: async (s) => {
        await getDb().delete(customFeeds).where(eq(customFeeds.ownerOxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'starter_packs owner/member/used_by',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(starterPacks).values({ ownerOxyUserId: s.oxyUserId, name: 'probe' });
      },
      clear: async (s) => {
        await getDb().delete(starterPacks).where(eq(starterPacks.ownerOxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'feed_generators.created_by',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(feedGenerators).values({
          uri: `mtn://probe/gen/${s.oxyUserId}`,
          name: 'probe',
          algorithm: 'probe',
          createdBy: s.oxyUserId,
        });
      },
      clear: async (s) => {
        await getDb().delete(feedGenerators).where(eq(feedGenerators.createdBy, s.oxyUserId));
      },
    },
    {
      probe: 'labelers.creator_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(labelers).values({ name: `probe-${s.oxyUserId}`, creatorId: s.oxyUserId });
      },
      clear: async (s) => {
        await getDb().delete(labelers).where(eq(labelers.creatorId, s.oxyUserId));
      },
    },
    {
      probe: 'content_labels created_by/target_id(user)',
      arm: 'always',
      plant: async (s) => {
        // Authored by somebody else, so `labelers.creator_id` stays quiet and
        // only the `target_id` disjunct can be what fires.
        const [labeler] = await getDb()
          .insert(labelers)
          .values({ name: `probe-${s.oxyUserId}`, creatorId: s.other })
          .returning({ id: labelers.id });
        await getDb().insert(contentLabels).values({
          labelerId: labeler.id,
          targetType: 'user',
          targetId: s.oxyUserId,
          labelSlug: 'spam',
          createdBy: s.other,
        });
      },
      clear: async (s) => {
        // CASCADEs the label with it.
        await getDb().delete(labelers).where(eq(labelers.creatorId, s.other));
      },
    },
    {
      probe: 'federation_delivery_queue.sender_oxy_user_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(federationDeliveryQueue).values({
          activityJson: { type: 'Probe' },
          targetInbox: 'https://remote.invalid/inbox',
          senderOxyUserId: s.oxyUserId,
          nextAttemptAt: new Date(),
        });
      },
      clear: async (s) => {
        await getDb()
          .delete(federationDeliveryQueue)
          .where(eq(federationDeliveryQueue.senderOxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'endorsement_outbox pending owner/member',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(endorsementOutbox).values({
          source: 'starterPack',
          sourceId: `probe-${s.oxyUserId}`,
          pendingRemoveOwnerId: s.oxyUserId,
        });
      },
      clear: async (s) => {
        await getDb()
          .delete(endorsementOutbox)
          .where(eq(endorsementOutbox.sourceId, `probe-${s.oxyUserId}`));
      },
    },
    {
      probe: 'user_behaviors references from another viewer',
      arm: 'always',
      plant: async (s) => {
        // SOMEBODY ELSE's behaviour row naming this actor. The `hiddenAuthors`
        // arm is a `text[]` containment test, which an `eq` would silently miss.
        await getDb()
          .insert(userBehaviors)
          .values({ oxyUserId: s.other, hiddenAuthors: [s.oxyUserId] });
      },
      clear: async (s) => {
        await getDb().delete(userBehaviors).where(eq(userBehaviors.oxyUserId, s.other));
      },
    },
    {
      probe: 'posts non-owner authorship/federation.actor_uri',
      arm: 'always',
      plant: async (s) => {
        await foreignPost({
          authorship: [
            { oxyUserId: s.other, role: 'owner', status: 'accepted' },
            { oxyUserId: s.oxyUserId, role: 'collaborator', status: 'accepted' },
          ],
        });
      },
      clear: async () => {},
    },
    {
      probe: 'federated_follows.local_user_id',
      arm: 'always',
      plant: async (s) => {
        await getDb().insert(federatedFollows).values({
          localUserId: s.oxyUserId,
          remoteActorUri: 'https://elsewhere.invalid/users/someone',
          direction: 'outbound',
        });
      },
      clear: async (s) => {
        await getDb().delete(federatedFollows).where(eq(federatedFollows.localUserId, s.oxyUserId));
      },
    },
    {
      probe: 'posts.federation_actor_uri without linked Oxy identity',
      arm: 'withoutOxyUser',
      plant: async (s) => {
        await foreignPost({ federation: { actorUri: s.actorUri } });
      },
      clear: async () => {},
    },
    {
      probe: 'federated_follows.remote_actor_uri',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(federatedFollows).values({
          localUserId: s.other,
          remoteActorUri: s.actorUri,
          direction: 'inbound',
        });
      },
      clear: async (s) => {
        await getDb().delete(federatedFollows).where(eq(federatedFollows.remoteActorUri, s.actorUri));
      },
    },
    {
      probe: 'posts owner/authorship/mentions',
      arm: 'beyondCascade',
      plant: async (s) => {
        const record = await insertPostRecord({
          oxyUserId: s.oxyUserId,
          authorship: [{ oxyUserId: s.oxyUserId, role: 'owner', status: 'accepted' }],
          type: PostType.TEXT,
          visibility: PostVisibility.PUBLIC,
          status: 'published',
          content: { variants: [{ source: 'author', text: 'mine', tag: 'en' }] },
        });
        s.posts.push(record.id);
      },
      clear: async () => {},
    },
    {
      probe: 'likes.user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(likes).values({ userId: s.oxyUserId, postId: await foreignPost() });
      },
      clear: async () => {},
    },
    {
      probe: 'entity_follows.user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb()
          .insert(entityFollows)
          .values({ userId: s.oxyUserId, entityType: 'list', entityId: `probe-${s.oxyUserId}` });
      },
      clear: async (s) => {
        await getDb().delete(entityFollows).where(eq(entityFollows.userId, s.oxyUserId));
      },
    },
    {
      probe: 'notifications recipient/actor',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(notifications).values({
          recipientId: s.oxyUserId,
          actorId: s.other,
          type: 'follow',
          entityType: 'profile',
          entityId: `probe-${s.oxyUserId}`,
        });
      },
      clear: async (s) => {
        await getDb().delete(notifications).where(eq(notifications.recipientId, s.oxyUserId));
      },
    },
    {
      probe: 'user_settings.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(userSettings).values({ oxyUserId: s.oxyUserId });
      },
      clear: async (s) => {
        await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'user_behaviors.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(userBehaviors).values({ oxyUserId: s.oxyUserId });
      },
      clear: async (s) => {
        await getDb().delete(userBehaviors).where(eq(userBehaviors.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'user_feed_preferences.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(userFeedPreferences).values({ oxyUserId: s.oxyUserId });
      },
      clear: async (s) => {
        await getDb()
          .delete(userFeedPreferences)
          .where(eq(userFeedPreferences.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'author_follower_snapshots.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb()
          .insert(authorFollowerSnapshots)
          .values({ oxyUserId: s.oxyUserId, followerCount: 1 });
      },
      clear: async (s) => {
        await getDb()
          .delete(authorFollowerSnapshots)
          .where(eq(authorFollowerSnapshots.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'actor_key_pairs.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(actorKeyPairs).values({
          oxyUserId: s.oxyUserId,
          publicKeyPem: 'probe-public',
          privateKeyPem: 'probe-private',
          keyId: `${s.actorUri}#main-key`,
        });
      },
      clear: async (s) => {
        await getDb().delete(actorKeyPairs).where(eq(actorKeyPairs.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'mention_user_nodes.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(mentionUserNodes).values({
          oxyUserId: s.oxyUserId,
          endpoint: 'https://node.invalid',
          nodePublicKey: 'probe-key',
        });
      },
      clear: async (s) => {
        await getDb().delete(mentionUserNodes).where(eq(mentionUserNodes.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'mention_repo_heads.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(mentionRepoHeads).values({
          oxyUserId: s.oxyUserId,
          subjectDid: `did:probe:${s.oxyUserId}`,
          seq: 1,
          headRecordId: `probe-${s.oxyUserId}`,
        });
      },
      clear: async (s) => {
        await getDb().delete(mentionRepoHeads).where(eq(mentionRepoHeads.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'mention_signed_records.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(mentionSignedRecords).values({
          subjectDid: `did:probe:${s.oxyUserId}`,
          oxyUserId: s.oxyUserId,
          type: 'app.mention.feed.post',
          envelope: { probe: true },
          publicKey: 'probe-key',
        });
      },
      clear: async (s) => {
        await getDb()
          .delete(mentionSignedRecords)
          .where(eq(mentionSignedRecords.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'mention_node_ingest_witnesses.oxy_user_id',
      arm: 'beyondCascade',
      plant: async (s) => {
        await getDb().insert(mentionNodeIngestWitnesses).values({
          oxyUserId: s.oxyUserId,
          recordId: `probe-${s.oxyUserId}`,
          witnessSignature: 'probe-signature',
          ingestedAt: 1,
        });
      },
      clear: async (s) => {
        await getDb()
          .delete(mentionNodeIngestWitnesses)
          .where(eq(mentionNodeIngestWitnesses.oxyUserId, s.oxyUserId));
      },
    },
    {
      probe: 'posts.federation_actor_uri',
      arm: 'anchor',
      plant: async (s) => {
        await foreignPost({ federation: { actorUri: s.actorUri } });
      },
      clear: async () => {},
    },
    {
      probe: 'federated_follows.remote_actor_uri',
      arm: 'anchor',
      plant: async (s) => {
        await getDb().insert(federatedFollows).values({
          localUserId: s.other,
          remoteActorUri: s.actorUri,
          direction: 'inbound',
        });
      },
      clear: async (s) => {
        await getDb().delete(federatedFollows).where(eq(federatedFollows.remoteActorUri, s.actorUri));
      },
    },
  ];

  it.each(cases)('BLOCKS on $probe ($arm)', async (testCase) => {
    // The control, first: with nothing planted the gate must CLEAR. A gate that
    // refused unconditionally would pass every assertion below while being
    // useless, and this is the only place that distinction is visible.
    expect(await blockersFrom(callGate(testCase.arm, false))).toEqual([]);

    await testCase.plant(subject);

    // `always` probes run before the gone-actor cascade returns, so they must
    // block WITH the acknowledgement; everything else must block WITHOUT it.
    const acknowledged = testCase.arm === 'always';
    expect(await blockersFrom(callGate(testCase.arm, acknowledged))).toEqual([testCase.probe]);

    if (testCase.arm === 'beyondCascade') {
      // …and go quiet with it, which is what makes the arm a claim and not a
      // coincidence of ordering.
      expect(await blockersFrom(callGate(testCase.arm, true))).toEqual([]);
    }

    await testCase.clear(subject);
    for (const id of subject.posts.splice(0).reverse()) {
      await deletePostRecord(id, undefined);
    }
  });

  /**
   * Coverage cannot silently become a subset.
   *
   * The probe list is read off the AST — the same scan the floor test uses — so
   * a probe added later is either exercised above or named here with a reason,
   * and anything else fails by name. Without this the table would quietly cover
   * whatever it happened to cover, which is the failure mode that makes a
   * partially-tested gate worse than an untested one: the coverage is what buys
   * it trust.
   */
  it('exercises every probe the module declares', () => {
    const declared = new Set(
      scanPreflightProbes()
        .filter((probe) => probe.owner !== 'buildPostReferenceProbes')
        .map((probe) => probe.name),
    );
    const exercised = new Set(cases.map((testCase) => testCase.probe));

    expect([...declared].filter((probe) => !exercised.has(probe)).sort()).toEqual([]);
    expect([...exercised].filter((probe) => !declared.has(probe)).sort()).toEqual([]);
  });
});
