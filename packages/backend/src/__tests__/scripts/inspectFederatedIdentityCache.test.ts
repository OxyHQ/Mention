import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres';
import { federatedActors } from '../../db/schema/federation';
import { posts } from '../../db/schema/posts';
import { insertPostRecord } from '../../db/posts/postRepository';
import { upsertActor } from '../../db/federation/actorRepository';
import { inspectFederatedIdentityCache, validateCacheInspectionInput } from '../../scripts/inspectFederatedIdentityCache';
const source = 'https://inspection-990.example/users/fresh';
const input = { actorUri: source, canonicalAcct: 'fresh@inspection-canonical.example', transportAcct: 'fresh@inspection-990.example' };
const fetchSpy = vi.fn(() => { throw new Error('Cache inspection must not fetch'); });
beforeAll(connectPostgres);
afterAll(closePostgres);
afterEach(async () => {
  vi.unstubAllGlobals();
  await getDb().delete(posts).where(eq(posts.federationActorUri, source));
  await getDb().delete(federatedActors).where(inArray(federatedActors.uri, [source, `${source}-other`]));
});
async function actor(uri = source) {
  return upsertActor(uri, { protocol: 'activitypub', username: 'fresh', domain: 'inspection-990.example', acct: input.transportAcct, networkAcct: input.canonicalAcct, type: 'Person', manuallyApprovesFollowers: false, discoverable: true, memorial: false, suspended: false, followersCount: 0, followingCount: 0, postsCount: 0, lastFetchedAt: new Date() }, []);
}
it('proves an absent candidate with one read-only snapshot and no discovery', async () => {
  vi.stubGlobal('fetch', fetchSpy);
  const report = await inspectFederatedIdentityCache(input);
  expect(report).toMatchObject({ operation: 'inspect_cache', dryRun: true, actorUriMatches: 0, canonicalAcctMatches: 0, transportAcctMatches: 0, postSourceMatches: 0 });
  expect(Number.isNaN(Date.parse(report.observedAt))).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(report.identifiers).toEqual(input);
});
it('counts an existing cached actor and its source posts without changing either', async () => {
  await actor();
  await insertPostRecord({ oxyUserId: 'inspect-person', authorship: [{ oxyUserId: 'inspect-person', role: 'owner', status: 'accepted' }], type: PostType.TEXT, visibility: PostVisibility.PUBLIC, status: 'published', content: { variants: [{ source: 'author', text: 'cache evidence', tag: 'en' }] }, federation: { actorUri: source, activityId: `${source}/posts/one` } });
  const before = await getDb().select().from(federatedActors).where(eq(federatedActors.uri, source));
  expect(await inspectFederatedIdentityCache(input)).toMatchObject({ actorUriMatches: 1, canonicalAcctMatches: 1, transportAcctMatches: 1, postSourceMatches: 1 });
  expect(await getDb().select().from(federatedActors).where(eq(federatedActors.uri, source))).toEqual(before);
});
it('counts tombstoned actors and private source history rather than filtering them out', async () => {
  await actor();
  await getDb().update(federatedActors).set({ suspended: true, discoverable: false }).where(eq(federatedActors.uri, source));
  await insertPostRecord({ oxyUserId: 'inspect-person', authorship: [{ oxyUserId: 'inspect-person', role: 'owner', status: 'accepted' }], type: PostType.TEXT, visibility: PostVisibility.PRIVATE, status: 'published', content: { variants: [{ source: 'author', text: 'private source evidence', tag: 'en' }] }, federation: { actorUri: source, activityId: `${source}/posts/private` } });
  expect(await inspectFederatedIdentityCache(input)).toMatchObject({ actorUriMatches: 1, canonicalAcctMatches: 1, transportAcctMatches: 1, postSourceMatches: 1 });
});
it('finds cached accts under another URI rather than falsely declaring absence', async () => {
  await actor(`${source}-other`);
  expect(await inspectFederatedIdentityCache(input)).toMatchObject({ actorUriMatches: 0, canonicalAcctMatches: 1, transportAcctMatches: 1, postSourceMatches: 0 });
});
it.each([
  { ...input, actorUri: "https://inspection-990.example/users/' or 1=1--" },
  { ...input, actorUri: 'http://inspection-990.example/users/fresh' },
  { ...input, actorUri: 'https://127.0.0.1/users/fresh' },
  { ...input, actorUri: `${source}?resolve=true` },
  { ...input, canonicalAcct: 'fresh@inspection-canonical.example;drop table posts' },
  { ...input, transportAcct: '' },
])('rejects non-exact or unsafe selectors before any database access', candidate => {
  expect(() => validateCacheInspectionInput(candidate)).toThrow();
});
