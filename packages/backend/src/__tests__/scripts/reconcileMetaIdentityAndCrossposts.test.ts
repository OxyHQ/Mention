/**
 * The #990 reconciliation, against real rows.
 *
 * What it has to be is CONSERVATIVE and HONEST: a one-shot that re-derives the
 * decision from the same modules the live path uses, reports what it found, and
 * never merges an Oxy identity that already carries follows and moderation
 * records. So the assertions are about the REPORT and about what the dry run
 * does and does not write, rather than about a happy path.
 *
 * ## Why this file gets its own database
 *
 * The script pages every federated actor and every unclustered federated post in
 * the table — it takes no scope, because a reconciliation that only fixed the
 * caller's rows would reconcile nothing in production. Registered in
 * `isolatedDatabaseFiles.ts` for that reason: on the shared database its live
 * pass would record identity claims against actors other suites seeded and
 * cluster their posts mid-assertion.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres';
import {
  federatedActors,
  federatedIdentityClaims,
  federatedIdentityLinks,
} from '../../db/schema/federation';
import { postEquivalenceClusters, posts } from '../../db/schema/posts';
import { postMedia } from '../../db/schema/postContent';
import { insertPostRecord } from '../../db/posts/postRepository';
import { upsertActor } from '../../db/federation/actorRepository';
import { reconcileMetaIdentityAndCrossposts } from '../../scripts/reconcileMetaIdentityAndCrossposts';

let db: Database;

const PERSON = 'oxy-reconcile-person';
const IG_ACTOR = 'https://kilogram.makeup/users/zuck';
const IG_STALE_ACTOR = 'https://kilogram.makeup/users/notyetrefreshed';
const THREADS_ACTOR = 'https://threads.net/ap/users/17841401746480004/';
const ASSET = 'https://scontent.cdninstagram.com/v/t51.2885-15/489123456789012_n.jpg';

async function seedActor(uri: string, username: string, domain: string, networkAcct?: string) {
  await upsertActor(
    uri,
    {
      protocol: 'activitypub',
      username,
      domain,
      acct: `${username}@${domain}`,
      ...(networkAcct ? { networkAcct } : {}),
      alsoKnownAs: networkAcct ? ['https://www.threads.net/@zuck'] : undefined,
      type: 'Person',
      manuallyApprovesFollowers: false,
      discoverable: true,
      memorial: false,
      suspended: false,
      followersCount: 0,
      followingCount: 0,
      postsCount: 0,
      lastFetchedAt: new Date(),
    },
    [],
  );
}

const AT = new Date('2026-09-11T12:00:00.000Z');

async function seedVariant(actorUri: string, mediaUrl: string, at: Date): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: PERSON,
    authorship: [{ oxyUserId: PERSON, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'building in the open', tag: 'en' }] },
    federation: {
      activityId: `${actorUri}/statuses/${Math.random().toString(36).slice(2)}`,
      actorUri,
    },
  });
  await db.update(posts).set({ createdAt: at, updatedAt: at }).where(eq(posts.id, record.id));
  await db.insert(postMedia).values({
    postId: record.id,
    position: 0,
    mediaId: mediaUrl,
    type: 'image',
    remoteUrl: mediaUrl,
    width: 1080,
    height: 1350,
    sizeBytes: 204800,
    createdAt: at,
  });
  return record.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  await getDb().delete(postEquivalenceClusters);
  await getDb().delete(federatedIdentityLinks);
  await getDb().delete(federatedIdentityClaims);
  await getDb().delete(posts);
  await getDb().delete(federatedActors);
});

afterAll(async () => {
  await closePostgres();
});

describe('the dry run', () => {
  it('counts the bridged actors that are and are not re-labelled', async () => {
    await seedActor(IG_ACTOR, 'zuck', 'kilogram.makeup', 'zuck@instagram.com');
    await seedActor(IG_STALE_ACTOR, 'notyetrefreshed', 'kilogram.makeup');

    const report = await reconcileMetaIdentityAndCrossposts({ dryRun: true });

    expect(report).toMatchObject({
      instagramActorsExamined: 2,
      instagramBridgeActorsRelabelled: 1,
      instagramBridgeActorsStillUnderBridgeIdentity: 1,
    });
  });

  it('writes nothing — no claim, no link, no cluster', async () => {
    await seedActor(IG_ACTOR, 'zuck', 'kilogram.makeup', 'zuck@instagram.com');
    await seedActor(THREADS_ACTOR, 'zuck', 'threads.net');
    await seedVariant(IG_ACTOR, ASSET, AT);
    await seedVariant(THREADS_ACTOR, `${ASSET}?oe=1`, new Date(AT.getTime() + 60_000));

    await reconcileMetaIdentityAndCrossposts({ dryRun: true });

    expect(await getDb().select().from(federatedIdentityClaims)).toEqual([]);
    expect(await getDb().select().from(federatedIdentityLinks)).toEqual([]);
    expect(await getDb().select().from(postEquivalenceClusters)).toEqual([]);
  });

  it('reports the cross-posts a live run would cluster, without clustering them', async () => {
    await seedActor(IG_ACTOR, 'zuck', 'kilogram.makeup', 'zuck@instagram.com');
    await seedActor(THREADS_ACTOR, 'zuck', 'threads.net');
    await seedVariant(IG_ACTOR, ASSET, AT);
    await seedVariant(THREADS_ACTOR, `${ASSET}?oe=1`, new Date(AT.getTime() + 60_000));

    const report = await reconcileMetaIdentityAndCrossposts({ dryRun: true });

    // Both sides see the other as a candidate, and both would match — the dry
    // run reports the pair from each end because it does not write the cluster
    // that would take the second one out of the scan.
    expect(report.postCrosspostCandidates).toBe(2);
    expect(report.postClustersCreated).toBe(2);
    expect(report.postCandidatesRefusedForWeakEvidence).toBe(0);
  });
});

describe('the live run', () => {
  it('clusters a historical cross-post pair exactly once', async () => {
    await seedActor(IG_ACTOR, 'zuck', 'kilogram.makeup', 'zuck@instagram.com');
    await seedActor(THREADS_ACTOR, 'zuck', 'threads.net');
    const instagram = await seedVariant(IG_ACTOR, ASSET, AT);
    const threads = await seedVariant(THREADS_ACTOR, `${ASSET}?oe=1`, new Date(AT.getTime() + 60_000));

    const report = await reconcileMetaIdentityAndCrossposts({ dryRun: false });

    expect(report.postClustersCreated).toBe(1);
    expect(await getDb().select().from(postEquivalenceClusters)).toHaveLength(1);

    const rows = await db
      .select({ id: posts.id, collapsed: posts.crosspostCollapsed })
      .from(posts)
      .where(inArray(posts.id, [instagram, threads]));
    // Both stored; exactly one collapsed.
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.collapsed)).toHaveLength(1);
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    await seedActor(IG_ACTOR, 'zuck', 'kilogram.makeup', 'zuck@instagram.com');
    await seedActor(THREADS_ACTOR, 'zuck', 'threads.net');
    await seedVariant(IG_ACTOR, ASSET, AT);
    await seedVariant(THREADS_ACTOR, `${ASSET}?oe=1`, new Date(AT.getTime() + 60_000));

    await reconcileMetaIdentityAndCrossposts({ dryRun: false });
    const second = await reconcileMetaIdentityAndCrossposts({ dryRun: false });

    expect(second.postClustersCreated).toBe(0);
    expect(await getDb().select().from(postEquivalenceClusters)).toHaveLength(1);
  });

  /**
   * The invariant the whole reconciliation is written around: two identities
   * that each minted their own Oxy user before the evidence appeared are
   * REPORTED, never merged. Follows, blocks, moderation records and post
   * authorship already reference both, and re-pointing one strands every one of
   * them.
   */
  it('never merges two Oxy users that both already exist', async () => {
    await seedActor(IG_ACTOR, 'zuck', 'kilogram.makeup', 'zuck@instagram.com');
    await seedActor(THREADS_ACTOR, 'zuck', 'threads.net');
    const [ig] = await db.select().from(federatedActors).where(eq(federatedActors.uri, IG_ACTOR));
    const [threads] = await db
      .select()
      .from(federatedActors)
      .where(eq(federatedActors.uri, THREADS_ACTOR));
    await db.update(federatedActors).set({ oxyUserId: 'oxy-a' }).where(eq(federatedActors.id, ig.id));
    await db
      .update(federatedActors)
      .set({ oxyUserId: 'oxy-b' })
      .where(eq(federatedActors.id, threads.id));

    await reconcileMetaIdentityAndCrossposts({ dryRun: false });

    const [igAfter] = await db.select().from(federatedActors).where(eq(federatedActors.uri, IG_ACTOR));
    expect(igAfter.oxyUserId).toBe('oxy-a');
    const [threadsAfter] = await db
      .select()
      .from(federatedActors)
      .where(eq(federatedActors.uri, THREADS_ACTOR));
    expect(threadsAfter.oxyUserId).toBe('oxy-b');
  });
});
