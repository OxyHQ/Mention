import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres';
import { federatedActors, federatedIdentityClaims } from '../../db/schema/federation';
import { posts, postEquivalenceClusters } from '../../db/schema/posts';
import { postAuthorships } from '../../db/schema/postContent';
import { mutes } from '../../db/schema/engagement';
import { insertPostRecord } from '../../db/posts/postRepository';
import { upsertActor, setActorOxyUserId, deleteActorsByUris } from '../../db/federation/actorRepository';
import { createCluster } from '../../db/posts/postEquivalenceRepository';
import { createActorProjectionCacheBatch, reconcileActorIdentityProjection, unmuteIdentityProjection } from '../../services/ActorIdentityProjectionService';
import { reconcileMetaIdentityAndCrossposts } from '../../scripts/reconcileMetaIdentityAndCrossposts';
import { logger } from '../../utils/logger';
import { recordAttestedIdentityLink } from '../../scripts/recordAttestedIdentityLink';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), resolve: vi.fn(), users: vi.fn(), detect: vi.fn(), reevaluate: vi.fn(), invalidate: vi.fn(), scan: vi.fn(), del: vi.fn() }));
vi.mock('../../services/userSummaryCache', () => ({ invalidate: mocks.invalidate }));
vi.mock('../../utils/redis', async importOriginal => ({ ...(await importOriginal<object>()), getRedisClient: () => ({ isReady: true, scanIterator: mocks.scan, del: mocks.del }) }));
vi.mock('../../connectors/oxyIdentity', () => ({ lookupOxyIdentities: mocks.lookup, resolveOxyIdentity: mocks.resolve }));
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ getUsersByIds: mocks.users }) }));
vi.mock('../../services/PostEquivalenceService', async importOriginal => ({ ...await importOriginal<typeof import('../../services/PostEquivalenceService')>(), detectCrosspostEquivalence: mocks.detect, reevaluateClusterForPost: mocks.reevaluate, reevaluateClusters: vi.fn() }));
const source = 'https://kilogram.makeup/users/source';
const otherSource = 'did:plc:other-source';
beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(() => { vi.clearAllMocks(); mocks.invalidate.mockResolvedValue(undefined); mocks.scan.mockImplementation(async function* () { yield ['anonfeed:fixture']; }); mocks.del.mockResolvedValue(1); mocks.lookup.mockResolvedValue([]); mocks.reevaluate.mockReset(); mocks.detect.mockResolvedValue({ outcome: 'refused', reason: 'no_current_content_proof' }); });
afterEach(async () => {
  vi.restoreAllMocks();
  await getDb().delete(postEquivalenceClusters);
  await getDb().delete(posts);
  await getDb().delete(federatedActors);
  await getDb().delete(mutes);
  await getDb().delete(federatedIdentityClaims);
});
async function actor(uri: string, oldId = 'old-person') {
  const row = await upsertActor(uri, { protocol: uri.startsWith('did:') ? 'atproto' : 'activitypub', username: uri === source ? 'source' : 'other', domain: uri === source ? 'kilogram.makeup' : 'bsky.social', acct: uri === source ? 'source@kilogram.makeup' : 'other@bsky.social', type: 'Person', manuallyApprovesFollowers: false, discoverable: true, memorial: false, suspended: false, followersCount: 0, followingCount: 0, postsCount: 0, lastFetchedAt: new Date() }, []);
  await setActorOxyUserId(row.id, oldId);
}
async function post(actorUri: string, user = 'old-person') {
  return insertPostRecord({ oxyUserId: user, authorship: [{ oxyUserId: user, role: 'owner', status: 'accepted' }], type: PostType.TEXT, visibility: PostVisibility.PUBLIC, status: 'published', content: { variants: [{ source: 'author', text: 'source-specific post', tag: 'en' }] }, federation: { activityId: `${actorUri}/posts/${Math.random()}`, actorUri } });
}
it('remaps exactly one immutable source and its owner rows, idempotently', async () => {
  await actor(source); await actor(otherSource);
  const own = await post(source); const foreign = await post(otherSource);
  const first = await reconcileActorIdentityProjection({ actorUri: source, oxyUserId: 'current-source', networkAcct: 'source@instagram.com' });
  expect(first.postsChanged).toBe(1);
  expect((await getDb().select().from(posts).where(eq(posts.id, own.id)))[0].oxyUserId).toBe('current-source');
  expect((await getDb().select().from(postAuthorships).where(eq(postAuthorships.postId, own.id)))[0].oxyUserId).toBe('current-source');
  expect((await getDb().select().from(posts).where(eq(posts.id, foreign.id)))[0].oxyUserId).toBe('old-person');
  expect((await reconcileActorIdentityProjection({ actorUri: source, oxyUserId: 'current-source', networkAcct: 'source@instagram.com' })).postsChanged).toBe(0);
});
it('dry-run projects counts but never resolves Oxy or writes Mention', async () => {
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  await actor(source); await actor(otherSource); await post(source);
  await getDb().update(federatedActors).set({ networkAcct: 'source@instagram.com' }).where(eq(federatedActors.uri, source));
  mocks.lookup.mockResolvedValue([{ identifier: source, userId: 'new-person', externalIdentities: [{ actorUri: source, canonicalAcct: 'source@instagram.com' }] }]);
  const report = await reconcileMetaIdentityAndCrossposts();
  expect(info.mock.calls.filter(([message]) => message === '[reconcileMetaIdentityAndCrossposts] progress')).toEqual([
    ['[reconcileMetaIdentityAndCrossposts] progress', { dryRun: true, phase: 'actors', batchesCompleted: 1, actorsExamined: 2, actorsChanged: 1, postsChanged: 1, authorshipConflicts: 0 }],
    ['[reconcileMetaIdentityAndCrossposts] progress', { dryRun: true, phase: 'posts', batchesCompleted: 1, postsExamined: 1, postClustersCreated: 0 }],
  ]);
  expect(report.actorsExamined).toBe(2);
  expect(report.postsChanged).toBe(1);
  expect(report.refused.oxy_identity_not_resolved).toBe(1);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.detect).not.toHaveBeenCalled();
  expect((await getDb().select().from(federatedActors).where(eq(federatedActors.uri, source)))[0].oxyUserId).toBe('old-person');
});
it('revocation restores only its source id and reveals every former cluster member', async () => {
  await actor(source, 'shared'); await actor(otherSource, 'shared');
  const a = await post(source, 'shared'); const b = await post(otherSource, 'shared');
  await createCluster('fingerprint', [{ postId: a.id, networkDomain: 'instagram.com', preferred: false, evidence: 'historical' }, { postId: b.id, networkDomain: 'threads.net', preferred: true, evidence: 'historical' }]);
  const result = await reconcileActorIdentityProjection({ actorUri: source, oxyUserId: 'restored-source' });
  expect(result.clustersDissolved).toBe(1);
  expect(await getDb().select().from(postEquivalenceClusters)).toHaveLength(0);
  const rows = await getDb().select().from(posts);
  expect(rows.every(row => !row.crosspostCollapsed)).toBe(true);
  expect(rows.find(row => row.id === b.id)?.oxyUserId).toBe('shared');
});
it('preserves legacy mutes without duplicates and normal unmute removes active-group copies', async () => {
  await actor(source); await post(source);
  await getDb().insert(mutes).values({ userId: 'viewer', mutedId: 'old-person' });
  const first = await reconcileActorIdentityProjection({ actorUri: source, oxyUserId: 'current' });
  expect(first.mutesPreserved).toBe(1);
  await reconcileActorIdentityProjection({ actorUri: source, oxyUserId: 'current' });
  expect(await getDb().select().from(mutes)).toHaveLength(2);
  mocks.users.mockResolvedValue([{ id: 'current', redirectedUserIds: ['old-person'] }]);
  expect(await unmuteIdentityProjection('viewer', 'current')).toBe(2);
  expect(await getDb().select().from(mutes)).toHaveLength(0);
});
it('scans native and AP actors in apply mode and records explicit refusals', async () => {
  await actor(source); await actor(otherSource); await post(source); await post(otherSource);
  mocks.resolve.mockImplementation(async ({ actorUri }: { actorUri: string }) => ({ externalIdentity: { userId: actorUri === source ? 'ig-user' : 'native-user', canonicalAcct: actorUri === source ? 'source@instagram.com' : 'other@bsky.social' } }));
  const result = await reconcileMetaIdentityAndCrossposts({ dryRun: false });
  expect(result.actorsExamined).toBe(2); expect(result.postsChanged).toBe(2);
  expect(result.refused.no_current_content_proof).toBe(1);
  expect(result.postsExamined).toBe(1);
});
it('retires both manual attestation creation and deletion without touching historical rows', async () => {
  const before = await getDb().select().from(federatedIdentityClaims);
  for (const remove of [false, true]) expect(await recordAttestedIdentityLink({ identityA: 'a@instagram.com', identityB: 'a@threads.net', source: 'manual assertion', dryRun: false, remove })).toEqual({ applied: false, refusal: 'oxy_identity_authority_required', rows: 0 });
  expect(await getDb().select().from(federatedIdentityClaims)).toEqual(before);
});

it('retains old identity evidence when a source actor cache is purged', async () => {
  await actor(source);
  await getDb().insert(federatedIdentityClaims).values({ subjectActorUri: source, subject: 'a@instagram.com', target: 'a@threads.net', kind: 'first-party-link', source: 'historical attestation' });
  expect(await deleteActorsByUris([source])).toBe(1);
  expect(await getDb().select().from(federatedIdentityClaims)).toHaveLength(1);
});

it('applies fresh registered authority and resolves only the missing exact source', async () => {
  await actor(source); await actor(otherSource); await post(source); await post(otherSource);
  mocks.lookup.mockResolvedValue([
    { identifier: source, userId: 'current-canonical', externalIdentities: [{ actorUri: source, canonicalAcct: 'source@instagram.com', sourceUserId: 'source-owner' }], redirectedUserIds: ['old-person'] },
    // A different actor in the same projection cannot stand in for this source.
    { identifier: otherSource, userId: 'unrelated', externalIdentities: [{ actorUri: 'did:plc:foreign', canonicalAcct: 'foreign@bsky.social' }] },
  ]);
  mocks.resolve.mockResolvedValue({ externalIdentity: { userId: 'resolved-native', canonicalAcct: 'other@bsky.social' } });
  const report = await reconcileMetaIdentityAndCrossposts({ dryRun: false });
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  expect(new Set(mocks.lookup.mock.calls[0][0])).toEqual(new Set([source, otherSource]));
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  expect(mocks.resolve).toHaveBeenCalledWith({ actorUri: otherSource, transportAcct: 'other@bsky.social', protocol: 'atproto' });
  expect(report.postsChanged).toBe(2);
  const rows = await getDb().select().from(posts);
  expect(rows.find(row => row.federationActorUri === source)?.oxyUserId).toBe('current-canonical');
  expect(rows.find(row => row.federationActorUri === otherSource)?.oxyUserId).toBe('resolved-native');
});

it('reads Oxy again on each apply and restores a source after authority separates it', async () => {
  await actor(source, 'former-group'); await post(source, 'former-group');
  mocks.lookup.mockResolvedValueOnce([{ identifier: source, userId: 'canonical-group', externalIdentities: [{ actorUri: source, canonicalAcct: 'source@instagram.com' }] }]);
  await reconcileMetaIdentityAndCrossposts({ dryRun: false });
  mocks.lookup.mockResolvedValueOnce([{ identifier: source, userId: 'independent-source', externalIdentities: [{ actorUri: source, canonicalAcct: 'source@instagram.com' }] }]);
  await reconcileMetaIdentityAndCrossposts({ dryRun: false });
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
  expect(mocks.resolve).not.toHaveBeenCalled();
  const [row] = await getDb().select().from(posts).where(eq(posts.federationActorUri, source));
  expect(row.oxyUserId).toBe('independent-source');
});

it('stops an apply batch before writes if the authoritative lookup fails', async () => {
  await actor(source); await post(source);
  mocks.lookup.mockRejectedValue(new Error('Authority temporarily unavailable'));
  await expect(reconcileMetaIdentityAndCrossposts({ dryRun: false })).rejects.toThrow('Authority temporarily unavailable');
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.detect).not.toHaveBeenCalled();
  const [row] = await getDb().select().from(posts).where(eq(posts.federationActorUri, source));
  expect(row.oxyUserId).toBe('old-person');
});


it.each(['detect', 'reevaluate'] as const)('administrative apply rejects %s failures without reporting completion', async phase => {
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  await actor(source);
  const stored = await post(source);
  mocks.lookup.mockResolvedValue([{ identifier: source, userId: 'old-person', externalIdentities: [{ actorUri: source, canonicalAcct: 'source@instagram.com' }] }]);
  mocks[phase].mockRejectedValueOnce(new Error('crosspost operation unavailable'));
  await expect(reconcileMetaIdentityAndCrossposts({ dryRun: false })).rejects.toThrow('crosspost operation unavailable');
  expect(mocks.reevaluate).toHaveBeenCalledWith(stored.id, { failOnError: true });
  if (phase === 'detect') expect(mocks.detect).toHaveBeenCalledWith({ postId: stored.id }, { failOnError: true });
  else expect(mocks.detect).not.toHaveBeenCalled();
  expect(info.mock.calls.some(([message]) => message === '[reconcileMetaIdentityAndCrossposts] complete')).toBe(false);
});

async function rowVersions(id: string) {
  const [row] = await getDb().execute<{ postVersion: string; ownerVersion: string }>(sql`
    select p.xmin::text as "postVersion", a.xmin::text as "ownerVersion"
    from posts p join post_authorships a on a.post_id=p.id and a.role='owner' where p.id=${id}
  `);
  return row;
}

it('changes network metadata without rewriting already correct post or owner rows', async () => {
  await actor(source); const stored = await post(source);
  const before = await rowVersions(stored.id);
  const result = await reconcileActorIdentityProjection({ actorUri: source, oxyUserId: 'old-person', networkAcct: 'source@instagram.com' });
  expect(result.actorChanged).toBe(true); expect(result.postsChanged).toBe(0);
  expect(await rowVersions(stored.id)).toEqual(before);
  expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  expect(mocks.scan).toHaveBeenCalledTimes(1); // live default remains immediate
});

it('repairs each divergent ownership row without rewriting its correct counterpart', async () => {
  await actor(source, 'current');
  const wrongOwner = await post(source, 'current');
  const wrongPost = await post(source, 'current');
  await getDb().update(postAuthorships).set({ oxyUserId: 'old' }).where(eq(postAuthorships.postId, wrongOwner.id));
  await getDb().update(posts).set({ oxyUserId: 'old' }).where(eq(posts.id, wrongPost.id));
  const ownerBefore = await rowVersions(wrongOwner.id); const postBefore = await rowVersions(wrongPost.id);
  expect((await reconcileActorIdentityProjection({ actorUri: source, oxyUserId: 'current' })).postsChanged).toBe(2);
  const ownerAfter = await rowVersions(wrongOwner.id); const postAfter = await rowVersions(wrongPost.id);
  expect(ownerAfter.postVersion).toBe(ownerBefore.postVersion);
  expect(ownerAfter.ownerVersion).not.toBe(ownerBefore.ownerVersion);
  expect(postAfter.ownerVersion).toBe(postBefore.ownerVersion);
  expect(postAfter.postVersion).not.toBe(postBefore.postVersion);
  expect((await getDb().select().from(postAuthorships)).every(row => row.oxyUserId === 'current')).toBe(true);
  expect((await getDb().select().from(posts)).every(row => row.oxyUserId === 'current')).toBe(true);
});

it.each([false, true])('coalesces admin invalidations across batches, including lookup failure=%s', async failSecondBatch => {
  await getDb().insert(federatedActors).values(Array.from({ length: 101 }, (_, i) => ({ uri: `https://example.social/users/batch-${i}`, username: `batch-${i}`, domain: "example.social", acct: `batch-${i}@example.social`, oxyUserId: "old-person" })));
  mocks.lookup.mockImplementation(async (uris: string[]) => {
    if (failSecondBatch && mocks.lookup.mock.calls.length === 2) throw new Error('second batch unavailable');
    return uris.map(uri => ({ identifier: uri, userId: 'shared-new', externalIdentities: [{ actorUri: uri, canonicalAcct: 'network@example.social' }] }));
  });
  const run = reconcileMetaIdentityAndCrossposts({ dryRun: false });
  if (failSecondBatch) await expect(run).rejects.toThrow('second batch unavailable');
  else expect((await run).actorsChanged).toBe(101);
  expect(mocks.invalidate).toHaveBeenCalledTimes(failSecondBatch ? 1 : 2);
  for (const [ids] of mocks.invalidate.mock.calls) expect(new Set(ids)).toEqual(new Set(['old-person', 'shared-new']));
  expect(mocks.scan).toHaveBeenCalledTimes(1);
  expect(mocks.del).toHaveBeenCalledWith(['anonfeed:fixture']);
  expect((await getDb().select().from(federatedActors)).filter(row => row.oxyUserId === 'shared-new')).toHaveLength(failSecondBatch ? 100 : 101);
}, 20000);

it('records committed invalidations before a later cluster read fails', async () => {
  await actor(source); await post(source);
  const batch = createActorProjectionCacheBatch();
  const record = vi.spyOn(batch, 'record');
  const failure = vi.spyOn(getDb(), 'selectDistinct').mockImplementationOnce(() => { throw new Error('cluster read failed'); });
  try {
    await expect(reconcileActorIdentityProjection({ actorUri: source, oxyUserId: 'new', cacheInvalidation: batch })).rejects.toThrow('cluster read failed');
    expect(record).toHaveBeenCalledWith(['old-person', 'new']);
    expect((await getDb().select().from(federatedActors))[0].oxyUserId).toBe('new');
  } finally { failure.mockRestore(); await batch.finish(); }
  expect(mocks.invalidate).toHaveBeenCalledWith(['old-person', 'new']);
  expect(mocks.scan).toHaveBeenCalledTimes(1);
});
