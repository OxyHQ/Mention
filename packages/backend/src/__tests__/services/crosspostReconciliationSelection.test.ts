import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { canonicalFederationHost } from '@oxy.so/federation';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres';
import { posts, postEquivalenceClusters } from '../../db/schema/posts';
import { federatedActors } from '../../db/schema/federation';
import { upsertActor } from '../../db/federation/actorRepository';
import { createCluster, findClusterByPostId } from '../../db/posts/postEquivalenceRepository';
import { crosspostReconciliationPostSql, reevaluateClusterForPost } from '../../services/PostEquivalenceService';

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../../connectors/oxyIdentity', () => ({ lookupOxyIdentities: mocks.lookup }));
const created: string[] = [];
const actors: string[] = [];
beforeAll(connectPostgres);
afterAll(closePostgres);
afterEach(async () => {
  if (created.length) await getDb().delete(posts).where(inArray(posts.id, created.splice(0)));
  if (actors.length) await getDb().delete(federatedActors).where(inArray(federatedActors.uri, actors.splice(0)));
  await getDb().delete(postEquivalenceClusters);
  vi.resetAllMocks();
});
async function actor(domain: string, networkAcct?: string) {
  const username = randomUUID();
  const uri = `https://source.test/${username}`;
  await upsertActor(uri, { protocol: 'activitypub', username, domain, acct: `${username}@${domain}`, networkAcct,
    type: 'Person', manuallyApprovesFollowers: false, discoverable: true, memorial: false, suspended: false,
    followersCount: 0, followingCount: 0, postsCount: 0, lastFetchedAt: new Date() }, []);
  actors.push(uri);
  return uri;
}
async function post(uri: string | null, changes: Partial<typeof posts.$inferInsert> = {}) {
  const [row] = await getDb().insert(posts).values({ oxyUserId: 'selection-person', status: 'published', federationActorUri: uri, ...changes }).returning({ id: posts.id });
  created.push(row.id);
  return row.id;
}
// Other integration suites may create eligible rows in the same test database.
async function selected(cursor?: string) {
  return (await getDb().select({ id: posts.id }).from(posts)
    .leftJoin(federatedActors, eq(federatedActors.uri, posts.federationActorUri))
    .where(and(inArray(posts.id, created), crosspostReconciliationPostSql(), cursor ? gt(posts.id, cursor) : undefined))
    .orderBy(asc(posts.id)).limit(100)).map(row => row.id);
}

it('keeps every eligible Meta network spelling with detector precedence and excludes unrelated unclustered posts', async () => {
  const expected: string[] = [];
  for (const [domain, networkAcct] of [
    ['instagram.com', undefined], ['threads.net', undefined], ['kilogram.makeup', 'author@instagram.com'],
    ['ignored.test', 'author@\tWWW.THREADS.NET\u00a0'], ['\ufeffWWW.INSTAGRAM.COM\n', undefined],
    ['threads.net', 'author@x.com'], ['kilogram.makeup', undefined], ['x.com', undefined], ['threads.net.evil.test', undefined],
    ['instagram.com', 'missing-domain@'],
  ] as const) {
    const uri = await actor(domain, networkAcct);
    const id = await post(uri);
    const rawDomain = networkAcct?.split('@')[1] || domain;
    if (['instagram.com', 'threads.net'].includes(canonicalFederationHost(rawDomain))) expected.push(id);
  }
  const ig = await actor('instagram.com');
  await post(ig, { status: 'draft' });
  await post(ig, { boostOf: expected[0] });
  await post(ig, { oxyUserId: '' });
  await post(null);
  expect(await selected()).toEqual(expected.sort());
});

it('visits non-Meta, restricted, null-actor and missing-actor members after deletion so reevaluation reveals surviving posts', async () => {
  const a = await post(await actor('x.com'));
  const b = await post(null, { status: 'restricted' });
  const c = await post('https://missing.test/actor');
  const deleted = await post(await actor('threads.net'));
  await createCluster('fingerprint', [
    { postId: a, networkDomain: 'x.com', preferred: true, evidence: 'old' },
    { postId: b, networkDomain: 'threads.net', preferred: false, evidence: 'old' },
    { postId: c, networkDomain: 'instagram.com', preferred: false, evidence: 'old' },
    { postId: deleted, networkDomain: 'threads.net', preferred: false, evidence: 'old' },
  ]);
  await getDb().delete(posts).where(eq(posts.id, deleted));
  expect(await selected()).toEqual([a, b, c].sort());
  await reevaluateClusterForPost(a, { failOnError: true });
  expect(await findClusterByPostId(a)).toBeNull();
  expect((await getDb().select().from(posts).where(inArray(posts.id, [a, b, c]))).every(row => !row.crosspostCollapsed)).toBe(true);
  expect(mocks.lookup).not.toHaveBeenCalled();
});

it('does not skip expired-proof clusters and visits an orphan collapsed flag without claiming it repaired', async () => {
  const a = await post(await actor('instagram.com'));
  const b = await post(await actor('threads.net'));
  await createCluster('fingerprint', [{ postId: a, networkDomain: 'instagram.com', preferred: true, evidence: 'old' }, { postId: b, networkDomain: 'threads.net', preferred: false, evidence: 'old' }]);
  const orphan = await post(null, { crosspostCollapsed: true });
  expect(await selected()).toEqual([a, b, orphan].sort());
  // Oxy's current lookup no longer exposes the expired equivalence.
  mocks.lookup.mockResolvedValue([]);
  await reevaluateClusterForPost(a, { failOnError: true });
  expect(await findClusterByPostId(a)).toBeNull();
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  await reevaluateClusterForPost(orphan, { failOnError: true });
  expect((await getDb().select().from(posts).where(eq(posts.id, orphan)))[0].crosspostCollapsed).toBe(true);
});

it('paginates past excluded rows with an exact unique cursor and retains old members across batch boundaries', async () => {
  const ig = await actor('instagram.com');
  const x = await actor('x.com');
  const expected: string[] = [];
  for (let index = 0; index < 105; index++) {
    expected.push(await post(ig));
    await post(x);
  }
  const old = await post(null, { crosspostCollapsed: true });
  expected.push(old);
  const first = await selected();
  const second = await selected(first.at(-1));
  expect(first).toHaveLength(100);
  expect([...first, ...second]).toEqual(expected.sort());
  expect(await selected(second.at(-1))).toEqual([]);
});
