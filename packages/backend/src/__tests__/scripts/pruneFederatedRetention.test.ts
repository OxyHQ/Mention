/**
 * `pruneFederatedRetention` deletes old federated posts nobody here depends on
 * and drains the unknown-end follow-edge expiry. It sweeps whole tables, so
 * this file runs against its own database (`isolatedDatabaseFiles.ts`).
 *
 * One test per rule: what is deleted, what is kept and why, the dry run, the
 * resume cursor and the next pass, the preflight failing closed, who counts as
 * local, and the batch gate.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { adminScriptCursors } from '../../db/schema/adminScripts';
import { notifications } from '../../db/schema/discovery';
import { bookmarks, likes } from '../../db/schema/engagement';
import {
  federatedActors,
  federatedFollows,
  federationDeliveryQueue,
  remoteActorRefs,
  remoteFollowEdges,
} from '../../db/schema/federation';
import { REPORT_CATEGORIES, reports } from '../../db/schema/moderation';
import { polls } from '../../db/schema/polls';
import { posts } from '../../db/schema/posts';
import { postContentVariants } from '../../db/schema/postContent';
import { upsertRemoteFollowEdges } from '../../db/federation/remoteGraphRepository';
import {
  RetentionStoppedError,
  SCRIPT_NAME,
  createRemoteAccountClassifier,
  createRetentionGate,
  decidePostRetention,
  parseRetentionWindow,
  pruneFederatedRetention,
  type RemoteAccountClassifier,
} from '../../scripts/pruneFederatedRetention';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const OLD = new Date(NOW.getTime() - 200 * DAY_MS);
const RECENT = new Date(NOW.getTime() - 10 * DAY_MS);
const ORIGIN = 'https://retention.test';

/** A `federated_actors` row linked to an Oxy account. */
function actorRow(uri: string, username: string, oxyUserId: string) {
  return {
    protocol: 'activitypub' as const,
    uri,
    username,
    domain: 'retention.test',
    acct: `${username}@retention.test`,
    oxyUserId,
  };
}

/** Accounts whose id starts with `remote-` are remote; everyone else is local. */
const classifyRemote: RemoteAccountClassifier = async (ids) =>
  new Set(ids.filter((id) => id.startsWith('remote-')));

let seq = 0;

/** An external post by `remote-<author>`, old unless told otherwise. */
async function federated(author = 'a', overrides: Partial<PostRecordInput> = {}) {
  seq += 1;
  const owner = `remote-${author}`;
  return insertPostRecord({
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: `remote ${seq}`, tag: 'en' }] },
    federation: {
      actorUri: `${ORIGIN}/users/${author}`,
      activityId: `${ORIGIN}/notes/${seq}`,
      url: `${ORIGIN}/@${author}/${seq}`,
    },
    createdAt: OLD,
    ...overrides,
  });
}

/** A post by a local user. */
async function local(overrides: Partial<PostRecordInput> = {}) {
  seq += 1;
  return insertPostRecord({
    oxyUserId: 'local-u',
    authorship: [{ oxyUserId: 'local-u', role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: `local ${seq}`, tag: 'en' }] },
    createdAt: OLD,
    ...overrides,
  });
}

async function exists(id: string): Promise<boolean> {
  const rows = await getDb().select({ id: posts.id }).from(posts).where(eq(posts.id, id));
  return rows.length === 1;
}

async function run(overrides: Partial<Parameters<typeof pruneFederatedRetention>[0]> = {}) {
  return pruneFederatedRetention({
    dryRun: false,
    phases: ['posts'],
    now: NOW,
    classifyRemote,
    ...overrides,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  // This file owns its database: start every test from empty tables.
  await getDb().execute(sql`
    truncate posts, likes, bookmarks, notifications, reports, federated_follows,
      federated_actors, federation_delivery_queue, admin_script_cursors,
      remote_follow_edges, remote_actor_refs cascade
  `);
});

afterAll(async () => {
  await closePostgres();
});

describe('which posts go', () => {
  it('deletes an old unengaged federated post with its family, and keeps a recent one', async () => {
    const old = await federated();
    const recent = await federated('a', { createdAt: RECENT });

    const report = await run();

    expect(await exists(old.id)).toBe(false);
    expect(await exists(recent.id)).toBe(true);
    expect(report.posts?.deleted).toBe(1);
    // The family went by its foreign keys.
    const variants = await getDb()
      .select({ id: postContentVariants.id })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, old.id));
    expect(variants).toEqual([]);
  });

  it('deletes a post only remote accounts liked, and its likes with it', async () => {
    const post = await federated();
    await getDb().insert(likes).values({ userId: 'remote-b', postId: post.id });

    await run();

    expect(await exists(post.id)).toBe(false);
    expect(await getDb().select().from(likes).where(eq(likes.postId, post.id))).toEqual([]);
  });

  it('keeps what a local user engaged with or depends on', async () => {
    const liked = await federated();
    await getDb().insert(likes).values({ userId: 'local-u', postId: liked.id });
    const bookmarked = await federated();
    await getDb().insert(bookmarks).values({ userId: 'local-u', postId: bookmarked.id });
    const notified = await federated();
    await getDb().insert(notifications).values({
      recipientId: 'local-u',
      actorId: 'remote-a',
      type: 'like',
      entityId: notified.id,
      entityType: 'post',
    });
    const reported = await federated();
    await getDb()
      .insert(reports)
      .values({
        reportedType: 'post',
        reportedId: reported.id,
        reporter: 'local-u',
        categories: [REPORT_CATEGORIES[0]],
      });
    const mentionsLocal = await federated('a', { mentions: ['local-u'] });
    const pinned = await federated('a', { metadata: { isPinned: true } });
    const boosted = await federated();
    await local({ type: PostType.REPOST, boostOf: boosted.id, content: { variants: [] } });
    const repliedTo = await federated();
    await local({ parentPostId: repliedTo.id, threadId: repliedTo.id });
    const localParent = await local();
    const replyToLocal = await federated('a', {
      parentPostId: localParent.id,
      threadId: localParent.id,
    });
    const movedOwner = await insertPostRecord({
      oxyUserId: 'local-moved',
      authorship: [{ oxyUserId: 'local-moved', role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'moved', tag: 'en' }] },
      federation: { actorUri: `${ORIGIN}/users/moved`, activityId: `${ORIGIN}/notes/moved` },
      createdAt: OLD,
    });
    const followersOnly = await federated('a', { visibility: PostVisibility.FOLLOWERS_ONLY });
    const oldLocal = await local();

    const report = await run();

    const kept = [
      liked,
      bookmarked,
      notified,
      reported,
      mentionsLocal,
      pinned,
      boosted,
      repliedTo,
      replyToLocal,
      movedOwner,
      followersOnly,
      oldLocal,
      localParent,
    ];
    for (const post of kept) expect(await exists(post.id)).toBe(true);
    expect(report.posts?.deleted).toBe(0);
    expect(report.posts?.keptBy).toMatchObject({
      local: 4,
      localAccount: 3,
      bookmarked: 1,
      notified: 1,
      moderation: 1,
      pinnedOrCurated: 1,
      // `boosted`, `repliedTo`, and `localParent` (the remote reply points at it).
      referenced: 3,
      referencesLocal: 1,
    });
  });

  it('keeps every post of a thread a local user is in', async () => {
    const root = await federated();
    const sibling = await federated('b', { parentPostId: root.id, threadId: root.id });
    await local({ parentPostId: root.id, threadId: root.id });

    await run();

    expect(await exists(root.id)).toBe(true);
    expect(await exists(sibling.id)).toBe(true);
  });

  it('keeps the newest posts of an author a local user follows, so the outbox sync cannot re-import them', async () => {
    await getDb()
      .insert(federatedFollows)
      .values({
        localUserId: 'local-u',
        remoteActorUri: `${ORIGIN}/users/f`,
        direction: 'outbound',
        status: 'accepted',
      });
    const oldest = await federated('f', { createdAt: new Date(OLD.getTime() - 2 * DAY_MS) });
    const middle = await federated('f', { createdAt: new Date(OLD.getTime() - DAY_MS) });
    const newest = await federated('f');

    await run({ keepNewestPerFollowedAuthor: 2 });

    expect(await exists(oldest.id)).toBe(false);
    expect(await exists(middle.id)).toBe(true);
    expect(await exists(newest.id)).toBe(true);
  });

  it('counts a followed actor’s newest posts apart from its owner’s other accounts', async () => {
    await getDb()
      .insert(federatedFollows)
      .values({
        localUserId: 'local-u',
        remoteActorUri: `${ORIGIN}/users/linked`,
        direction: 'outbound',
        status: 'accepted',
      });
    const followed = await federated('linked', {
      createdAt: new Date(OLD.getTime() - 30 * DAY_MS),
    });
    // A linked account on another network: the same Oxy owner, newer posts.
    const sameOwner = (activityId: string) =>
      federated('linked', {
        federation: { actorUri: `${ORIGIN}/users/other-network`, activityId },
      });
    await sameOwner(`${ORIGIN}/notes/other-1`);
    await sameOwner(`${ORIGIN}/notes/other-2`);

    await run({ keepNewestPerFollowedAuthor: 1 });

    expect(await exists(followed.id)).toBe(true);
  });

  it('keeps a post with a poll nobody here voted in, without blocking the rest', async () => {
    const withPoll = await federated();
    await getDb()
      .insert(polls)
      .values({ postId: withPoll.id, question: 'which?', createdBy: 'remote-a', endsAt: NOW });
    const other = await federated();

    const report = await run();

    expect(report.posts).toMatchObject({ preflightBlocked: 0, deleted: 1 });
    expect(await exists(withPoll.id)).toBe(true);
    expect(await exists(other.id)).toBe(false);
  });

  it('keeps a post saved while the batch was being deleted', async () => {
    const post = await federated();
    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let inserted!: () => void;
    const uncommitted = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    // A save still open on another connection: the walk cannot see it yet.
    const saving = getDb().transaction(async (tx) => {
      await tx.insert(bookmarks).values({ userId: 'local-u', postId: post.id });
      inserted();
      await held;
    });
    await uncommitted;

    const pruning = run();
    // Commit only once the prune is waiting on the saved row.
    await vi.waitFor(async () => {
      const [{ waiting }] = await getDb().execute<{ waiting: number }>(sql`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `);
      expect(waiting).toBeGreaterThan(0);
    });
    commit();
    await saving;
    const report = await pruning;

    expect(await exists(post.id)).toBe(true);
    expect(report.posts).toMatchObject({ deleted: 0, keptAtDelete: 1 });
    expect(
      await getDb().select().from(bookmarks).where(eq(bookmarks.postId, post.id)),
    ).toHaveLength(1);
  });

  it('removes a thread from its leaves inward, one layer per pass', async () => {
    const parent = await federated();
    const reply = await federated('b', { parentPostId: parent.id, threadId: parent.id });

    const first = await run();
    expect(await exists(reply.id)).toBe(false);
    expect(await exists(parent.id)).toBe(true);
    expect(first.posts?.passCompleted).toBe(true);

    // The pass finished, so the next run starts a new one and the parent is a leaf now.
    await run();
    expect(await exists(parent.id)).toBe(false);
  });

  it('refuses an age under 30 days', async () => {
    await expect(run({ postMaxAgeDays: 7 })).rejects.toThrow(/under 30 days/);
  });
});

describe('dry run, resume and the preflight', () => {
  it('a dry run reports what it would delete and writes nothing, not even its cursor', async () => {
    const doomed = await federated();
    const kept = await federated();
    await getDb().insert(bookmarks).values({ userId: 'local-u', postId: kept.id });

    const report = await run({ dryRun: true });

    expect(report.posts).toMatchObject({ scanned: 2, deletable: 1, deleted: 0 });
    expect(report.posts?.deletableByType).toEqual({ text: 1 });
    expect(await exists(doomed.id)).toBe(true);
    expect(await getDb().select().from(adminScriptCursors)).toEqual([]);
  });

  it('resumes from its cursor after a run that stopped part-way', async () => {
    const first = await federated('a', { createdAt: new Date(OLD.getTime() - 2 * DAY_MS) });
    const second = await federated('a', { createdAt: new Date(OLD.getTime() - DAY_MS) });
    const third = await federated();

    // A canary budget of one post: it deletes the oldest and records where it stopped.
    const canary = await run({ limit: 1, postBatchSize: 1 });
    expect(canary.posts).toMatchObject({ scanned: 1, deleted: 1, passCompleted: false });
    expect(await exists(first.id)).toBe(false);
    expect(await exists(second.id)).toBe(true);
    const [cursor] = await getDb()
      .select()
      .from(adminScriptCursors)
      .where(eq(adminScriptCursors.script, SCRIPT_NAME));
    expect(cursor).toMatchObject({ scope: 'posts', scanned: 1, completedAt: null });

    // The next run starts after it, not from the top.
    const rest = await run({ postBatchSize: 1 });
    expect(rest.posts).toMatchObject({ scanned: 2, deleted: 2, passCompleted: true });
    expect(await exists(third.id)).toBe(false);

    // Idempotent: a re-run finds nothing more to do.
    const again = await run();
    expect(again.posts?.deleted).toBe(0);
  });

  it('fails closed on a batch the preflight refuses, and deletes none of it', async () => {
    const queued = await federated();
    const other = await federated();
    // A reference only the preflight knows about: a legacy delivery naming the post.
    await getDb()
      .insert(federationDeliveryQueue)
      .values({
        activityJson: { type: 'Announce', object: queued.federation?.activityId },
        targetInbox: `${ORIGIN}/inbox`,
        senderOxyUserId: 'local-u',
        nextAttemptAt: NOW,
      });

    const report = await run();

    expect(report.posts?.preflightBlocked).toBe(1);
    expect(report.posts?.deleted).toBe(0);
    expect(await exists(queued.id)).toBe(true);
    expect(await exists(other.id)).toBe(true);
  });
});

describe('who counts as local', () => {
  it('asks Oxy only about accounts with an actor row, and keeps what it cannot confirm', async () => {
    await getDb()
      .insert(federatedActors)
      .values([
        actorRow(`${ORIGIN}/users/r`, 'r', 'oxy-r'),
        actorRow(`${ORIGIN}/users/p`, 'p', 'oxy-p'),
        actorRow(`${ORIGIN}/users/x`, 'x', 'oxy-x'),
      ]);
    const lookup = vi.fn(async (ids: readonly string[]) => ({
      found: [
        { id: 'oxy-r', type: 'federated' },
        // A projected or moved identity: an actor row points at a LOCAL person.
        { id: 'oxy-p', type: 'local' },
      ].filter((user) => ids.includes(user.id)),
      missing: [],
      failed: ids.filter((id) => id === 'oxy-x'),
    }));
    const classify = createRemoteAccountClassifier(
      lookup as unknown as Parameters<typeof createRemoteAccountClassifier>[0],
    );

    const remote = await classify(['oxy-r', 'oxy-p', 'oxy-x', 'oxy-plain']);

    expect([...remote]).toEqual(['oxy-r']);
    // `oxy-plain` has no actor row: local without asking.
    expect(lookup).toHaveBeenCalledWith(['oxy-r', 'oxy-p', 'oxy-x'], 'federation.retention');
  });

  it('keeps a post when any of its accounts is not provably remote', () => {
    const facts = {
      id: 'p',
      type: 'text',
      createdAt: OLD,
      oxyUserId: 'remote-a',
      federationActorUri: `${ORIGIN}/users/a`,
      uris: [],
      accounts: ['remote-a', 'local-liker'],
      sqlReasons: [],
      batchReasons: [],
    };
    expect(decidePostRetention(facts, new Set(['remote-a']), false)).toEqual({
      delete: false,
      keptBy: ['localAccount'],
    });
    expect(decidePostRetention(facts, new Set(['remote-a', 'local-liker']), false)).toEqual({
      delete: true,
      keptBy: [],
    });
  });
});

describe('the batch gate', () => {
  it('stops when the off-peak window closes', async () => {
    const noonUtc = Date.UTC(2026, 10, 28, 12, 0, 0);
    const gate = createRetentionGate({
      window: parseRetentionWindow('01-07'),
      pauseMs: 0,
      slowBatchMs: 1_000,
      maxConsecutiveSlow: 3,
      now: () => noonUtc,
    });
    await expect(gate.beforeBatch()).rejects.toBeInstanceOf(RetentionStoppedError);
  });

  it('stops after three slow batches in a row, and a fast one resets the count', async () => {
    let clock = Date.UTC(2026, 10, 28, 2, 0, 0);
    const gate = createRetentionGate({
      window: parseRetentionWindow('01-07'),
      pauseMs: 0,
      slowBatchMs: 1_000,
      maxConsecutiveSlow: 3,
      now: () => clock,
    });
    const batch = async (ms: number) => {
      await gate.beforeBatch();
      clock += ms;
    };
    await batch(5_000);
    await batch(5_000);
    await batch(10); // fast: the run is healthy again
    await batch(5_000);
    await batch(5_000);
    await batch(5_000);
    await expect(gate.beforeBatch()).rejects.toMatchObject({ reason: 'database-slow' });
  });

  it('a stopped run reports it and keeps its cursor', async () => {
    await federated();
    const report = await run({
      gate: {
        async beforeBatch() {
          throw new RetentionStoppedError('window-closed');
        },
      },
    });
    expect(report.posts?.stopped).toBe('window-closed');
    expect(report.posts?.deleted).toBe(0);
  });

  it('rejects a malformed window', () => {
    expect(() => parseRetentionWindow('7-7')).toThrow();
    expect(parseRetentionWindow('always')).toBe('always');
    expect(parseRetentionWindow('22-04')).toEqual([22, 4]);
  });
});

describe('follow edges', () => {
  const ALICE = `${ORIGIN}/users/alice`;
  const BOB = `${ORIGIN}/users/bob`;
  const STRANGER = `${ORIGIN}/users/stranger`;

  it('drains unknown-end edges past the chosen TTL and never touches a known pair', async () => {
    await getDb()
      .insert(federatedActors)
      .values([actorRow(ALICE, 'alice', 'remote-alice'), actorRow(BOB, 'bob', 'remote-bob')]);
    const twentyDaysAgo = new Date(NOW.getTime() - 20 * DAY_MS);
    await upsertRemoteFollowEdges(
      [
        { sourceUri: ALICE, targetUri: BOB },
        { sourceUri: ALICE, targetUri: STRANGER },
      ],
      twentyDaysAgo,
    );

    // The sweep's own 30-day TTL would keep both; the owner chose 7.
    const dry = await pruneFederatedRetention({
      dryRun: true,
      phases: ['follow-edges'],
      edgeUnknownTtlDays: 7,
      now: NOW,
    });
    expect(dry.followEdges?.deleted).toBe(0);

    const live = await pruneFederatedRetention({
      dryRun: false,
      phases: ['follow-edges'],
      edgeUnknownTtlDays: 7,
      now: NOW,
    });

    expect(live.followEdges?.deleted).toBe(1);
    const left = await getDb()
      .select({ uri: remoteActorRefs.uri })
      .from(remoteFollowEdges)
      .innerJoin(remoteActorRefs, eq(remoteActorRefs.id, remoteFollowEdges.targetId));
    expect(left).toEqual([{ uri: BOB }]);
    // The stranger's node went with its last edge.
    const refs = await getDb()
      .select({ uri: remoteActorRefs.uri })
      .from(remoteActorRefs)
      .where(inArray(remoteActorRefs.uri, [STRANGER]));
    expect(refs).toEqual([]);
  });
});
