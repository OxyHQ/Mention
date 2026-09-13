import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres';
import { federatedActors, federatedIdentityClaims } from '../../db/schema/federation';
import { posts, postEquivalenceClusters } from '../../db/schema/posts';
import { postAuthorships } from '../../db/schema/postContent';
import { mutes } from '../../db/schema/engagement';
import { insertPostRecord } from '../../db/posts/postRepository';
import { upsertActor, setActorOxyUserId, deleteActorsByUris } from '../../db/federation/actorRepository';
import { createCluster } from '../../db/posts/postEquivalenceRepository';
import { reconcileActorIdentityProjection, unmuteIdentityProjection } from '../../services/ActorIdentityProjectionService';
import { reconcileMetaIdentityAndCrossposts } from '../../scripts/reconcileMetaIdentityAndCrossposts';
import { recordAttestedIdentityLink } from '../../scripts/recordAttestedIdentityLink';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), resolve: vi.fn(), users: vi.fn(), detect: vi.fn() }));
vi.mock('../../connectors/oxyIdentity', () => ({ lookupOxyIdentities: mocks.lookup, resolveOxyIdentity: mocks.resolve }));
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ getUsersByIds: mocks.users }) }));
vi.mock('../../services/PostEquivalenceService', () => ({ detectCrosspostEquivalence: mocks.detect, reevaluateClusterForPost: vi.fn(), reevaluateClusters: vi.fn() }));
const source = 'https://kilogram.makeup/users/source';
const otherSource = 'did:plc:other-source';
beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(() => { vi.clearAllMocks(); mocks.detect.mockResolvedValue({ outcome: 'refused', reason: 'no_current_content_proof' }); });
afterEach(async () => {
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
  await actor(source); await actor(otherSource); await post(source);
  mocks.lookup.mockResolvedValue([{ identifier: source, userId: 'new-person', externalIdentities: [{ actorUri: source, canonicalAcct: 'source@instagram.com' }] }]);
  const report = await reconcileMetaIdentityAndCrossposts();
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
  expect(result.refused.no_current_content_proof).toBe(2);
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
